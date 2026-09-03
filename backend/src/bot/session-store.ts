import type { DbClient } from '../db'
import type { Prisma } from '../generated/prisma/client'
import type { ChatSession } from './bot'

/**
 * Хранилище контекста чата. Бот держит сессии в памяти, но процесс
 * перезапускается при каждом деплое — без внешнего хранилища мастер посреди
 * разговора получал «сначала пришлите VIN». Хранилище опционально: тесты и
 * запуск без БД работают на одной памяти.
 */
export interface SessionStore {
  load(chatId: number): Promise<ChatSession | null>
  save(chatId: number, session: ChatSession): Promise<void>
}

export class PrismaSessionStore implements SessionStore {
  constructor(private readonly db: Pick<DbClient, 'botSession'>) {}

  async load(chatId: number): Promise<ChatSession | null> {
    try {
      const record = await this.db.botSession.findUnique({ where: { chatId: BigInt(chatId) } })
      if (!record || typeof record.state !== 'object' || record.state === null) return null
      return record.state as ChatSession
    } catch (error) {
      console.warn('[bot] не удалось загрузить сессию чата, начинаем с пустой', error)
      return null
    }
  }

  async save(chatId: number, session: ChatSession): Promise<void> {
    const state = JSON.parse(JSON.stringify(session)) as Prisma.InputJsonObject
    try {
      await this.db.botSession.upsert({
        where: { chatId: BigInt(chatId) },
        create: { chatId: BigInt(chatId), state },
        update: { state },
      })
    } catch (error) {
      console.warn('[bot] не удалось сохранить сессию чата', error)
    }
  }
}
