import type {
  OrganizationDto,
  OrganizationResponse,
  OrgRole,
  UpdateOrganizationRequest,
} from '@web-app-demo/contracts'

import type { Actor } from '../auth/actor'
import type { DbClient } from '../db'
import { Prisma } from '../generated/prisma/client'
import { AppError } from '../http/errors'

/** Делегаты, нужные для создания организации — и в транзакции, и вне её. */
type OrgTx = Pick<Prisma.TransactionClient, 'organization' | 'user' | 'vehicle' | 'order'>

/** Без 0/O/1/I — код диктуют по телефону и печатают на листке. */
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generateInviteCode(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (byte) => INVITE_ALPHABET[byte % INVITE_ALPHABET.length]).join('')
}

/** Имя автосервиса по умолчанию, когда при регистрации его не указали. */
export function defaultOrgName(displayName: string | null | undefined, email: string): string {
  const base = displayName?.trim() || email.split('@')[0] || 'без названия'
  return `Автосервис ${base}`
}

/**
 * Создаёт организацию со свежим кодом приглашения. Коллизия 8-символьного кода
 * практически невозможна, но unique-констрейнт её поймает — тогда пробуем другой.
 */
export async function createOrganization(
  tx: OrgTx,
  input: { name: string },
): Promise<{ id: string }> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await tx.organization.create({
        data: { name: input.name, inviteCode: generateInviteCode() },
        select: { id: true },
      })
    } catch (error) {
      if (!isUniqueConstraintError(error) || attempt >= 3) throw error
    }
  }
}

class OrgRaceLost extends Error {}

/**
 * Автосервис (организация): рабочее пространство сотрудников. Все пользователи
 * состоят ровно в одной организации; старым записям без неё она создаётся при
 * первом обращении (см. ensureForUser) — так сервисы кабинета всегда получают
 * непустой orgId и не держат две ветки логики.
 */
export class OrganizationService {
  constructor(private readonly db: DbClient) {}

  /**
   * Возвращает организацию пользователя, создавая личную при её отсутствии.
   * Личный гараж и заказы, заведённые до появления организаций, переезжают в
   * неё — иначе после обновления они бы «пропали» из кабинета.
   */
  async ensureForUser(userId: string): Promise<{ orgId: string; orgRole: OrgRole }> {
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { orgId: true, orgRole: true, displayName: true, email: true },
    })
    if (user.orgId) return { orgId: user.orgId, orgRole: user.orgRole }

    try {
      return await this.db.$transaction(async (tx) => {
        const org = await createOrganization(tx, {
          name: defaultOrgName(user.displayName, user.email),
        })
        // Два параллельных запроса одного пользователя: побеждает первый, второй
        // откатывает свою организацию и перечитывает.
        const claimed = await tx.user.updateMany({
          where: { id: userId, orgId: null },
          data: { orgId: org.id, orgRole: 'OWNER' },
        })
        if (claimed.count === 0) throw new OrgRaceLost()

        await tx.vehicle.updateMany({ where: { userId, orgId: null }, data: { orgId: org.id } })
        await tx.order.updateMany({ where: { userId, orgId: null }, data: { orgId: org.id } })
        return { orgId: org.id, orgRole: 'OWNER' as const }
      })
    } catch (error) {
      if (!(error instanceof OrgRaceLost)) throw error
      const again = await this.db.user.findUniqueOrThrow({
        where: { id: userId },
        select: { orgId: true, orgRole: true },
      })
      if (!again.orgId) throw new Error('Организация пользователя не создана после гонки')
      return { orgId: again.orgId, orgRole: again.orgRole }
    }
  }

  async get(actor: Pick<Actor, 'orgId'>): Promise<OrganizationResponse> {
    const org = await this.db.organization.findUnique({
      where: { id: actor.orgId },
      include: { _count: { select: { members: true } } },
    })
    if (!org) throw new AppError(404, 'NOT_FOUND', 'Автосервис не найден')
    return { organization: toDto(org) }
  }

  /** Название, телефон и наценка — только владелец. */
  async update(actor: Actor, input: UpdateOrganizationRequest): Promise<OrganizationResponse> {
    requireOwner(actor)
    await this.db.organization.update({
      where: { id: actor.orgId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.defaultMarkupBps !== undefined
          ? { defaultMarkupBps: input.defaultMarkupBps }
          : {}),
        // Реквизиты для заказ-наряда: null очищает, отсутствие не трогает.
        ...(input.legalName !== undefined ? { legalName: input.legalName } : {}),
        ...(input.inn !== undefined ? { inn: input.inn } : {}),
        ...(input.ogrn !== undefined ? { ogrn: input.ogrn } : {}),
        ...(input.address !== undefined ? { address: input.address } : {}),
        ...(input.warrantyText !== undefined ? { warrantyText: input.warrantyText } : {}),
      },
    })
    return this.get(actor)
  }

  /** Новый код приглашения: старый перестаёт действовать (ушёл не тому — сменили). */
  async rotateInviteCode(actor: Actor): Promise<OrganizationResponse> {
    requireOwner(actor)
    await this.db.organization.update({
      where: { id: actor.orgId },
      data: { inviteCode: generateInviteCode() },
    })
    return this.get(actor)
  }

  /**
   * Перейти в другой автосервис по коду. Владелец с сотрудниками уйти не может —
   * иначе автосервис останется без хозяина. Личная корзина переезжает вместе с
   * пользователем, привязка к клиенту старого автосервиса снимается.
   */
  async join(actor: Actor, inviteCode: string): Promise<OrganizationResponse> {
    const target = await this.db.organization.findUnique({
      where: { inviteCode },
      select: { id: true },
    })
    if (!target) throw new AppError(404, 'NOT_FOUND', 'Код приглашения не найден')
    if (target.id === actor.orgId) return this.get(actor)

    if (actor.orgRole === 'OWNER') {
      const colleagues = await this.db.user.count({
        where: { orgId: actor.orgId, id: { not: actor.userId } },
      })
      if (colleagues > 0) {
        throw new AppError(
          400,
          'BAD_REQUEST',
          'Вы владелец автосервиса с сотрудниками — сначала переведите их в другой автосервис',
        )
      }
    }

    await this.db.$transaction([
      this.db.user.update({
        where: { id: actor.userId },
        data: { orgId: target.id, orgRole: 'MEMBER' },
      }),
      this.db.order.updateMany({
        where: { userId: actor.userId, status: 'DRAFT' },
        data: { orgId: target.id, customerId: null },
      }),
    ])
    return this.get({ orgId: target.id })
  }
}

function requireOwner(actor: Actor): void {
  if (actor.orgRole !== 'OWNER') {
    throw new AppError(403, 'FORBIDDEN', 'Настройки автосервиса меняет только владелец')
  }
}

type OrgRecord = {
  id: string
  name: string
  phone: string | null
  defaultMarkupBps: number
  inviteCode: string
  legalName: string | null
  inn: string | null
  ogrn: string | null
  address: string | null
  warrantyText: string | null
  createdAt: Date
  _count: { members: number }
}

function toDto(org: OrgRecord): OrganizationDto {
  return {
    id: org.id,
    name: org.name,
    phone: org.phone,
    defaultMarkupBps: org.defaultMarkupBps,
    inviteCode: org.inviteCode,
    legalName: org.legalName,
    inn: org.inn,
    ogrn: org.ogrn,
    address: org.address,
    warrantyText: org.warrantyText,
    memberCount: org._count.members,
    createdAt: org.createdAt.toISOString(),
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}
