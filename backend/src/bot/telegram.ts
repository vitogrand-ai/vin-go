/**
 * Минимальный клиент Telegram Bot API на fetch (без сторонних зависимостей).
 * Используется long-polling — публичный webhook/HTTPS не требуется.
 */

export type TgChat = { id: number }
export type TgUser = { id: number; first_name?: string }
/** Один из размеров фото, которые Telegram делает из присланного снимка. */
export type TgPhotoSize = {
  file_id: string
  width: number
  height: number
  file_size?: number
}
export type TgVoice = {
  file_id: string
  duration: number
  mime_type?: string
  file_size?: number
}
/** Фото, отправленное файлом («без сжатия») — качество лучше для чтения VIN. */
export type TgDocument = {
  file_id: string
  mime_type?: string
  file_size?: number
}
export type TgMessage = {
  message_id: number
  chat: TgChat
  from?: TgUser
  text?: string
  caption?: string
  /** Размеры одного снимка, от меньшего к большему. */
  photo?: TgPhotoSize[]
  voice?: TgVoice
  document?: TgDocument
}
export type TgCallbackQuery = {
  id: string
  from: TgUser
  message?: TgMessage
  data?: string
}
export type TgUpdate = {
  update_id: number
  message?: TgMessage
  callback_query?: TgCallbackQuery
}

export type InlineButton = { text: string; callback_data: string }
export type InlineKeyboard = { inline_keyboard: InlineButton[][] }

export type SendMessageOptions = {
  replyMarkup?: InlineKeyboard
  /** Формат разметки текста. */
  parseMode?: 'HTML' | 'Markdown'
}

/** Абстракция клиента — для подмены фейком в тестах. */
export interface TelegramClient {
  getUpdates(offset: number, timeoutSeconds: number): Promise<TgUpdate[]>
  sendMessage(chatId: number, text: string, options?: SendMessageOptions): Promise<void>
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>
  /**
   * Скачивает вложение по file_id. Возвращает null, если файл недоступен
   * (истёк, слишком большой для Bot API, сетевой сбой) — вызывающая сторона
   * должна ответить подсказкой, а не падать.
   */
  downloadFile(fileId: string): Promise<Uint8Array | null>
}

export class HttpTelegramClient implements TelegramClient {
  constructor(private readonly token: string) {}

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`
  }

  private async call<T>(method: string, body: unknown): Promise<T> {
    const response = await fetch(this.url(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await response.json()) as { ok: boolean; result?: T; description?: string }
    if (!data.ok) {
      throw new Error(`Telegram ${method}: ${data.description ?? response.status}`)
    }
    return data.result as T
  }

  async getUpdates(offset: number, timeoutSeconds: number): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>('getUpdates', {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ['message', 'callback_query'],
    })
  }

  async sendMessage(chatId: number, text: string, options?: SendMessageOptions): Promise<void> {
    await this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: options?.parseMode,
      reply_markup: options?.replyMarkup,
    })
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, text })
  }

  /**
   * Скачивание в два шага, как требует Bot API: getFile отдаёт временный путь,
   * затем файл забирается с file-хоста. Ограничение Bot API — 20 МБ на скачивание.
   */
  async downloadFile(fileId: string): Promise<Uint8Array | null> {
    try {
      const file = await this.call<{ file_path?: string }>('getFile', { file_id: fileId })
      if (!file.file_path) return null

      const response = await fetch(
        `https://api.telegram.org/file/bot${this.token}/${file.file_path}`,
      )
      if (!response.ok) {
        console.warn(`[telegram] файл ${fileId} не скачан: HTTP ${response.status}`)
        return null
      }
      return new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      console.warn(`[telegram] файл ${fileId} не скачан`, error)
      return null
    }
  }
}
