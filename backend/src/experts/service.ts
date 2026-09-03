import {
  answerExpertRequestSchema,
  createExpertRequestSchema,
  type AnswerExpertRequest,
  type CreateExpertRequest,
  type ExpertRequestDto,
  type ExpertRequestResponse,
  type ExpertRequestsResponse,
  type ExpertRequestStatus,
} from '@web-app-demo/contracts'

import type { Actor } from '../auth/actor'
import type { CatalogProvider } from '../catalog/providers'
import type { DbClient } from '../db'
import type { Prisma } from '../generated/prisma/client'
import { AppError } from '../http/errors'
import type { NotificationService } from '../notifications/service'

type ExpertRequestRecord = {
  id: string
  number: number
  status: string
  vin: string
  vehicle: unknown
  query: string
  comment: string | null
  answerText: string | null
  answerOems: string[]
  createdAt: Date
  answeredAt: Date | null
  organization: { name: string }
}

const orgInclude = { organization: { select: { name: true } } }

/**
 * Заявки эксперту — «человек в цикле». Каталоги не покрывают всё (китайцы,
 * JDM, свежие модели), и вместо тупика «ничего не найдено» сотрудник
 * автосервиса отдаёт запрос живому подборщику. Отвечает оператор платформы,
 * автор получает push/Telegram и сразу видит предложения по номерам.
 */
export class ExpertsService {
  constructor(
    private readonly db: DbClient,
    private readonly catalog: CatalogProvider,
    private readonly notifications?: NotificationService,
  ) {}

  async create(actor: Actor, rawInput: CreateExpertRequest): Promise<ExpertRequestResponse> {
    const input = createExpertRequestSchema.parse(rawInput)
    const record = await this.db.expertRequest.create({
      data: {
        orgId: actor.orgId,
        userId: actor.userId,
        vin: input.vin,
        vehicle: await this.vehicleSnapshot(input.vin),
        query: input.query,
        comment: input.comment ?? null,
      },
      include: orgInclude,
    })
    return { request: toDto(record) }
  }

  /** Оператор платформы видит общую очередь (новые первыми), сотрудник — заявки своего автосервиса. */
  async list(actor: Actor): Promise<ExpertRequestsResponse> {
    const requests = await this.db.expertRequest.findMany({
      where: actor.role === 'OPERATOR' ? {} : { orgId: actor.orgId },
      include: orgInclude,
      // Порядок enum в Postgres = порядок объявления: NEW раньше ANSWERED/REJECTED.
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    })
    return { requests: requests.map(toDto) }
  }

  async get(actor: Actor, id: string): Promise<ExpertRequestResponse> {
    const record = await this.db.expertRequest.findFirst({
      where: actor.role === 'OPERATOR' ? { id } : { id, orgId: actor.orgId },
      include: orgInclude,
    })
    if (!record) throw new AppError(404, 'NOT_FOUND', 'Заявка не найдена')
    return { request: toDto(record) }
  }

  /** Ответ эксперта. Только оператор платформы; автор получает уведомление. */
  async answer(actor: Actor, rawInput: AnswerExpertRequest): Promise<ExpertRequestResponse> {
    if (actor.role !== 'OPERATOR') {
      throw new AppError(403, 'FORBIDDEN', 'Отвечать на заявки может только оператор')
    }
    const input = answerExpertRequestSchema.parse(rawInput)
    const existing = await this.db.expertRequest.findUnique({
      where: { id: input.id },
      select: { id: true, userId: true, status: true },
    })
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Заявка не найдена')

    const record = await this.db.expertRequest.update({
      where: { id: input.id },
      data: {
        status: input.status,
        answerText: input.answerText,
        answerOems: input.answerOems,
        answeredBy: actor.userId,
        answeredAt: new Date(),
      },
      include: orgInclude,
    })

    const oems = record.answerOems.length > 0 ? ` Номера: ${record.answerOems.join(', ')}.` : ''
    await this.notifications?.notifyUser(
      existing.userId,
      input.status === 'ANSWERED' ? 'Эксперт ответил' : 'Заявка эксперту отклонена',
      `Заявка № ${record.number} («${record.query}»): ${record.answerText}${oems}`,
    )

    return { request: toDto(record) }
  }

  /**
   * Снимок карточки авто для эксперта. Каталог может не знать VIN — заявка
   * ровно про такие случаи, поэтому любой отказ каталога = null, а не ошибка.
   */
  private async vehicleSnapshot(vin: string): Promise<Prisma.InputJsonValue | undefined> {
    try {
      const vehicle = await this.catalog.decodeVin(vin)
      if (!vehicle) return undefined
      return { make: vehicle.make, model: vehicle.model, year: vehicle.year ?? null }
    } catch {
      return undefined
    }
  }
}

function toDto(record: ExpertRequestRecord): ExpertRequestDto {
  const vehicle = record.vehicle as { make?: string; model?: string; year?: number } | null
  return {
    id: record.id,
    number: record.number,
    status: record.status as ExpertRequestStatus,
    vin: record.vin,
    vehicle:
      vehicle && typeof vehicle.make === 'string' && typeof vehicle.model === 'string'
        ? {
            make: vehicle.make,
            model: vehicle.model,
            year: typeof vehicle.year === 'number' ? vehicle.year : null,
          }
        : null,
    query: record.query,
    comment: record.comment,
    answerText: record.answerText,
    answerOems: record.answerOems,
    orgName: record.organization.name,
    createdAt: record.createdAt.toISOString(),
    answeredAt: record.answeredAt ? record.answeredAt.toISOString() : null,
  }
}
