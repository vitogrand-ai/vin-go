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

export type SendPhotoOptions = SendMessageOptions & {
  /** Подпись под фото (лимит Telegram — 1024 символа). */
  caption?: string
}

/** Лимит Bot API на загрузку фото файлом. Схемы узлов — десятки килобайт. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024
/** Картинка не должна задерживать long-polling, если CDN каталога подвис. */
const PHOTO_TIMEOUT_MS = 15_000

/** Абстракция клиента — для подмены фейком в тестах. */
export interface TelegramClient {
  getUpdates(offset: number, timeoutSeconds: number): Promise<TgUpdate[]>
  sendMessage(chatId: number, text: string, options?: SendMessageOptions): Promise<void>
  /**
   * Отправка фото по URL. Картинку скачивает КЛИЕНТ и загружает файлом (см.
   * `HttpTelegramClient.sendPhoto`). Ошибка (недоступная картинка, отказ
   * Telegram) пробрасывается — вызывающая сторона шлёт текстовый фолбэк.
   */
  sendPhoto(chatId: number, photoUrl: string, options?: SendPhotoOptions): Promise<void>
  /**
   * Тот же файл документом — Telegram его не пережимает. Нужен для схемы узла
   * в исходном разрешении: у фото номера позиций теряются при сжатии.
   */
  sendDocument(chatId: number, fileUrl: string, options?: SendPhotoOptions): Promise<void>
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>
  /**
   * Скачивает вложение по file_id. Возвращает null, если файл недоступен
   * (истёк, слишком большой для Bot API, сетевой сбой) — вызывающая сторона
   * должна ответить подсказкой, а не падать.
   */
  downloadFile(fileId: string): Promise<Uint8Array | null>
}

export class HttpTelegramClient implements TelegramClient {
  /**
   * `fetchImpl` внедряется так же, как у провайдеров каталога
   * (`provider-http.ts`): тесты подставляют стаб через конструктор, а не
   * подменяют глобальный fetch.
   */
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`
  }

  private async call<T>(method: string, body: unknown): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(this.url(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (error) {
      // Сетевую ошибку не пробрасываем как есть: см. describeNetworkError.
      throw new Error(`Telegram ${method}: ${describeNetworkError(error)}`)
    }
    return this.parseResult<T>(method, response)
  }

  /** Разбор конверта Bot API: `ok: false` — отказ метода, а не сетевой сбой. */
  private async parseResult<T>(method: string, response: Response): Promise<T> {
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

  /**
   * Фото уходит ФАЙЛОМ, а не ссылкой.
   *
   * По ссылке картинку качает сам Telegram, и на схемах узлов parts-catalogs он
   * отвечал «Bad Request: failed to get HTTP URL content» (живой бот,
   * 11.09.2026): CDN каталога не отдаёт файл его серверам, хотя нам отдаёт
   * (HTTP 200 и с VPS, и снаружи). Скачиваем сами — доставка схемы зависит
   * только от нашего доступа к каталогу, а не от маршрута Telegram к чужому CDN.
   */
  async sendPhoto(chatId: number, photoUrl: string, options?: SendPhotoOptions): Promise<void> {
    await this.sendFile('sendPhoto', 'photo', chatId, photoUrl, options)
  }

  /**
   * Та же картинка, но документом: фото Telegram пережимает в JPEG и на схеме
   * узла расплываются номера позиций — ради них мастер её и открывает. Документ
   * доходит байт в байт, поэтому кнопка «схема крупнее» шлёт именно его.
   */
  async sendDocument(chatId: number, fileUrl: string, options?: SendPhotoOptions): Promise<void> {
    await this.sendFile('sendDocument', 'document', chatId, fileUrl, options)
  }

  /** Общая отправка файла: качаем сами (см. `sendPhoto`) и грузим multipart-ом. */
  private async sendFile(
    method: 'sendPhoto' | 'sendDocument',
    field: 'photo' | 'document',
    chatId: number,
    fileUrl: string,
    options?: SendPhotoOptions,
  ): Promise<void> {
    const file = await this.fetchPhoto(method, fileUrl)

    const form = new FormData()
    form.set('chat_id', String(chatId))
    form.set(field, file, fileNameFromUrl(fileUrl))
    if (options?.caption !== undefined) form.set('caption', options.caption)
    if (options?.parseMode !== undefined) form.set('parse_mode', options.parseMode)
    if (options?.replyMarkup !== undefined) {
      form.set('reply_markup', JSON.stringify(options.replyMarkup))
    }

    let response: Response
    try {
      // Content-Type не ставим руками: fetch сам добавит boundary multipart.
      response = await this.fetchImpl(this.url(method), { method: 'POST', body: form })
    } catch (error) {
      throw new Error(`Telegram ${method}: ${describeNetworkError(error)}`)
    }
    await this.parseResult(method, response)
  }

  /**
   * Забирает картинку у каталога. Любой отказ — обычная ошибка: у вызывающей
   * стороны есть текстовый фолбэк, схема не критична для выдачи.
   */
  private async fetchPhoto(method: string, photoUrl: string): Promise<Blob> {
    let response: Response
    try {
      response = await this.fetchImpl(photoUrl, { signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS) })
    } catch (error) {
      throw new Error(`Telegram ${method}: картинка не скачана (${describeNetworkError(error)})`)
    }
    if (!response.ok) {
      throw new Error(`Telegram ${method}: картинка не скачана (HTTP ${response.status})`)
    }

    // Ошибку CDN, отданную страницей с кодом 200, ловим до загрузки в Telegram —
    // иначе он ответит невнятным Bad Request.
    const type = response.headers.get('content-type')
    if (type && !type.startsWith('image/')) {
      throw new Error(`Telegram ${method}: вместо картинки пришёл ${type}`)
    }

    const blob = await response.blob()
    if (blob.size === 0) throw new Error(`Telegram ${method}: картинка пустая`)
    if (blob.size > MAX_PHOTO_BYTES) {
      throw new Error(`Telegram ${method}: картинка ${blob.size} Б больше лимита Bot API`)
    }
    return blob
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

      const response = await this.fetchImpl(
        `https://api.telegram.org/file/bot${this.token}/${file.file_path}`,
      )
      if (!response.ok) {
        console.warn(`[telegram] файл ${fileId} не скачан: HTTP ${response.status}`)
        return null
      }
      return new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      console.warn(`[telegram] файл ${fileId} не скачан: ${describeNetworkError(error)}`)
      return null
    }
  }
}

/**
 * Имя файла для multipart. Telegram определяет формат по содержимому, имя лишь
 * попадает в свойства сообщения — поэтому неожиданное расширение заменяем.
 */
function fileNameFromUrl(photoUrl: string): string {
  const name = photoUrl.split('?')[0]?.split('/').pop()
  return name && /\.(png|jpe?g|webp)$/i.test(name) ? name : 'scheme.png'
}

/**
 * Короткое описание сетевого сбоя БЕЗ адреса запроса.
 *
 * Каждый вызов Bot API несёт токен прямо в пути URL, а объект ошибки fetch
 * хранит этот URL в поле `path` — значит `console.error(error)` печатает токен
 * в журнал открытым текстом (так он и утёк в journald на боевом сервере).
 * Наружу отдаём только код сбоя: для диагностики нужен именно он
 * («ConnectionRefused», «TimeoutError»), а адрес и так известен.
 */
export function describeNetworkError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code) return code
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string' && name) return name
  }
  return 'сетевая ошибка'
}
