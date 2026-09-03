import type {
  OrgRole,
  TelegramLinkCodeResponse,
  TelegramStatusResponse,
  UserRole,
} from '@web-app-demo/contracts'

import type { Actor } from '../auth/actor'
import type { DbClient } from '../db'
import { OrganizationService } from '../org/service'

const CODE_TTL_MS = 15 * 60 * 1000

/**
 * Привязка Telegram-аккаунта к пользователю. Веб генерирует одноразовый код,
 * бот гасит его при `/start <code>` и связывает Telegram-аккаунт с кабинетом.
 */
export class TelegramLinkService {
  private readonly organizations: OrganizationService

  constructor(
    private readonly db: DbClient,
    private readonly botUsername?: string,
  ) {
    this.organizations = new OrganizationService(db)
  }

  async createLinkCode(userId: string): Promise<TelegramLinkCodeResponse> {
    await this.db.telegramLinkCode.deleteMany({ where: { userId } })
    const code = generateCode()
    const expiresAt = new Date(Date.now() + CODE_TTL_MS)
    await this.db.telegramLinkCode.create({ data: { code, userId, expiresAt } })
    return {
      code,
      deepLink: this.botUsername ? `https://t.me/${this.botUsername}?start=${code}` : null,
      expiresAt: expiresAt.toISOString(),
    }
  }

  async status(userId: string): Promise<TelegramStatusResponse> {
    const account = await this.db.telegramAccount.findUnique({ where: { userId } })
    return { linked: Boolean(account) }
  }

  /** Гасит код и привязывает Telegram-аккаунт. Возвращает userId или null. */
  async consumeCode(code: string, telegramUserId: bigint): Promise<string | null> {
    const record = await this.db.telegramLinkCode.findUnique({ where: { code } })
    if (!record || record.expiresAt < new Date()) return null

    await this.db.$transaction([
      // Этот Telegram мог быть привязан к другому аккаунту — отвязываем.
      this.db.telegramAccount.deleteMany({ where: { telegramUserId } }),
      this.db.telegramAccount.upsert({
        where: { userId: record.userId },
        create: { userId: record.userId, telegramUserId },
        update: { telegramUserId },
      }),
      this.db.telegramLinkCode.deleteMany({ where: { userId: record.userId } }),
    ])
    return record.userId
  }

  async resolveUser(telegramUserId: bigint): Promise<string | null> {
    const account = await this.db.telegramAccount.findUnique({ where: { telegramUserId } })
    return account?.userId ?? null
  }

  /**
   * Пользователь бота как участник автосервиса — то, с чем работают сервисы
   * кабинета. Организация старой записи создаётся тут же, как и в API.
   */
  async resolveActor(telegramUserId: bigint): Promise<Actor | null> {
    const account = await this.db.telegramAccount.findUnique({
      where: { telegramUserId },
      include: { user: { select: { id: true, role: true, orgId: true, orgRole: true } } },
    })
    if (!account) return null
    const { user } = account
    const org = user.orgId
      ? { orgId: user.orgId, orgRole: user.orgRole as OrgRole }
      : await this.organizations.ensureForUser(user.id)
    return { userId: user.id, role: user.role as UserRole, orgId: org.orgId, orgRole: org.orgRole }
  }
}

function generateCode(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()
}
