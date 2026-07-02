import type { DbClient } from '../db'

export type PushSend = (tokens: string[], title: string, body: string) => Promise<void>
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
    await this.opts.pushSend(
      tokens.map((device) => device.token),
      title,
      body,
    )
  }
}

/** Реальная отправка push через Expo Push API. */
export function makeExpoPushSend(): PushSend {
  return async (tokens, title, body) => {
    const messages = tokens.map((to) => ({ to, title, body, sound: 'default' }))
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    }).catch(() => undefined)
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
