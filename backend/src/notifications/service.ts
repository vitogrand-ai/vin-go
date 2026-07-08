import type { DbClient } from '../db'

/** Отправка push. Возвращает токены, которые Expo счёл невалидными (удаляем их). */
export type PushSend = (
  tokens: string[],
  title: string,
  body: string,
) => Promise<{ invalidTokens: string[] }>
export type TelegramSend = (chatId: string, text: string) => Promise<void>

/**
 * Уведомления пользователю по всем привязанным каналам: push (Expo) на
 * устройства и сообщение в Telegram. Сендеры внедряются (реальные в app.ts,
 * фейковые в тестах). notifyUser никогда не бросает — фоновое уведомление не
 * должно ломать основную операцию.
 */
export class NotificationService {
  constructor(
    private readonly db: DbClient,
    private readonly opts: { pushSend?: PushSend; telegramSend?: TelegramSend },
  ) {}

  async notifyUser(userId: string, title: string, body: string): Promise<void> {
    await Promise.allSettled([
      this.notifyTelegram(userId, title, body),
      this.notifyPush(userId, title, body),
    ])
  }

  private async notifyTelegram(userId: string, title: string, body: string): Promise<void> {
    if (!this.opts.telegramSend) return
    const account = await this.db.telegramAccount.findUnique({ where: { userId } })
    if (!account) return
    await this.opts.telegramSend(account.telegramUserId.toString(), `${title}\n${body}`)
  }

  private async notifyPush(userId: string, title: string, body: string): Promise<void> {
    if (!this.opts.pushSend) return
    const tokens = await this.db.deviceToken.findMany({
      where: { userId },
      select: { token: true },
    })
    if (tokens.length === 0) return
    const { invalidTokens } = await this.opts.pushSend(
      tokens.map((device) => device.token),
      title,
      body,
    )
    // Чистим мёртвые токены (DeviceNotRegistered), чтобы они не копились.
    if (invalidTokens.length > 0) {
      await this.db.deviceToken.deleteMany({ where: { token: { in: invalidTokens } } })
    }
  }
}

const EXPO_PUSH_CHUNK = 100

type ExpoTicket = { status?: string; details?: { error?: string } }

/** Реальная отправка push через Expo Push API (чанки по 100, чистка мёртвых токенов). */
export function makeExpoPushSend(): PushSend {
  return async (tokens, title, body) => {
    const invalidTokens: string[] = []
    for (let start = 0; start < tokens.length; start += EXPO_PUSH_CHUNK) {
      const chunk = tokens.slice(start, start + EXPO_PUSH_CHUNK)
      try {
        const response = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(chunk.map((to) => ({ to, title, body, sound: 'default' }))),
        })
        const payload = (await response.json()) as { data?: ExpoTicket[] }
        payload.data?.forEach((ticket, index) => {
          if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
            const token = chunk[index]
            if (token) invalidTokens.push(token)
          }
        })
      } catch {
        // Сеть/Expo недоступны — не критично, токены не трогаем.
      }
    }
    return { invalidTokens }
  }
}

/** Реальная отправка сообщения в Telegram (из API-процесса, по токену бота). */
export function makeTelegramSend(botToken: string): TelegramSend {
  return async (chatId, text) => {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    }).catch(() => undefined)
  }
}
