import type {
  TelegramLinkCodeResponse,
  TelegramStatusResponse,
} from '@web-app-demo/contracts'

import type { DbClient } from '../db'

const CODE_TTL_MS = 15 * 60 * 1000

/**
 * Привязка Telegram-аккаунта к пользователю. Веб генерирует одноразовый код,
 * бот гасит его при `/start <code>` и связывает Telegram-аккаунт с кабинетом.
 */
export class TelegramLinkService {
  constructor(
    private readonly db: DbClient,
    private readonly botUsername?: string,
  ) {}

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
}

function generateCode(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()
}
