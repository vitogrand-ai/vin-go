import { vinOrFrameSchema } from '@web-app-demo/contracts'

import type { VinOcrProvider, VinPhoto } from './vin-ocr'
import type { VoiceTranscriber } from './voice-transcribe'

/**
 * Фото VIN и голосовые через Яндекс Облако (Vision OCR и SpeechKit).
 *
 * Зачем Яндекс, а не Claude Vision и Whisper: сервер продукта стоит в России,
 * а Anthropic и OpenAI отвечают на российские адреса 403 «страна не
 * поддерживается» (проверено с VPS 23.09.2026). Обходить это прокси — нарушать
 * их условия. Яндекс работает из России и берёт оплату в рублях.
 *
 * Ключ — API-ключ сервисного аккаунта (`YANDEX_API_KEY`), каталог облака —
 * `YANDEX_FOLDER_ID`. Для ключа сервисного аккаунта каталог необязателен: сервис
 * берёт каталог, где аккаунт создан (документация SpeechKit), поэтому
 * передаётся, только если задан.
 */

export const YANDEX_OCR_URL = 'https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText'
export const YANDEX_STT_URL = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize'

/** Лимиты синхронного распознавания SpeechKit v1: 1 МБ и 30 секунд. */
export const YANDEX_STT_MAX_BYTES = 1024 * 1024
export const YANDEX_STT_MAX_SECONDS = 30

/** Мастер ждёт ответа в чате: лучше признать неудачу, чем висеть. */
const TIMEOUT_MS = 20_000

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export type YandexConfig = {
  apiKey: string
  folderId?: string
  /** Подмена сети в тестах. */
  fetchImpl?: FetchLike
}

/** Форматы, которые принимает Vision OCR (JPEG, PNG, PDF). */
const OCR_MIME: Partial<Record<VinPhoto['mediaType'], string>> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
}

export class YandexVinOcrProvider implements VinOcrProvider {
  private readonly apiKey: string
  private readonly folderId: string | undefined
  private readonly fetchImpl: FetchLike

  constructor(config: YandexConfig) {
    this.apiKey = config.apiKey
    this.folderId = config.folderId
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  async extractVin(image: VinPhoto): Promise<string | null> {
    const mimeType = OCR_MIME[image.mediaType]
    if (!mimeType) return null // Telegram шлёт фото в JPEG; экзотику в API не носим

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Api-Key ${this.apiKey}`,
      // Фото СТС и ПТС — персональные данные, в журналах Яндекса им не место.
      'x-data-logging-enabled': 'false',
    }
    if (this.folderId) headers['x-folder-id'] = this.folderId

    let fullText: string
    try {
      const response = await this.fetchImpl(YANDEX_OCR_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          mimeType,
          languageCodes: ['*'],
          model: 'page',
          content: Buffer.from(image.bytes).toString('base64'),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!response.ok) {
        console.warn(`[vin-ocr] Yandex Vision ответил HTTP ${response.status}`)
        return null
      }
      fullText = ocrFullText(await response.json())
    } catch (error) {
      console.warn('[vin-ocr] запрос к Yandex Vision не удался', error)
      return null
    }
    return findVinInText(fullText)
  }
}

/** Полный текст снимка: `result.textAnnotation.fullText` (или без обёртки `result`). */
function ocrFullText(data: unknown): string {
  const root = isRecord(data) && isRecord(data['result']) ? data['result'] : data
  const annotation = isRecord(root) ? root['textAnnotation'] : null
  const text = isRecord(annotation) ? annotation['fullText'] : null
  return typeof text === 'string' ? text : ''
}

/**
 * VIN (или номер кузова японца) в распознанном тексте снимка.
 *
 * OCR отдаёт всё, что видно на табличке или СТС: марку, массу, коды. VIN ищем
 * как 17 знаков подряд; на табличках его печатают группами через пробел, поэтому
 * пробуем и склейку соседних слов строки. Буквы I, O, Q в VIN не бывает — это
 * 1, 0, 0, которые распознавание путает. Два РАЗНЫХ кандидата — ответ null,
 * если только ровно один не подписан «VIN»: чужой VIN уводит мастера на чужую
 * машину, отказ лишь просит переснять.
 */
export function findVinInText(text: string): string | null {
  const lines = text.toUpperCase().split(/\r?\n/)
  const vins = collect(lines, (line) => whole(line))
  const found = vins.size > 0 ? vins : collect(lines, (line) => joined(line))
  const picked = pick(found)
  if (picked) return picked
  if (found.size > 0) return null

  const frames = collect(lines, (line) =>
    (line.match(/[A-Z][A-Z0-9]{1,7}-\d{4,8}/g) ?? []).filter((frame) => vinOrFrameSchema.safeParse(frame).success),
  )
  return pick(frames)
}

/** Кандидат → строки, где он встретился (нужно для подписи «VIN»). */
function collect(lines: string[], candidatesOf: (line: string) => string[]): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const line of lines) {
    for (const candidate of candidatesOf(line)) found.set(candidate, [...(found.get(candidate) ?? []), line])
  }
  return found
}

function pick(found: Map<string, string[]>): string | null {
  if (found.size === 1) return [...found.keys()][0]!
  const labelled = [...found].filter(([, lines]) => lines.some((line) => /\bVIN\b/.test(line)))
  return labelled.length === 1 ? labelled[0]![0] : null
}

function words(line: string): string[] {
  return line.split(/[^A-Z0-9]+/).filter(Boolean)
}

/** Слова строки, которые сами по себе — VIN. */
function whole(line: string): string[] {
  return words(line).map(asVin).filter((vin): vin is string => vin !== null)
}

/** VIN, напечатанный группами: соседние слова строки, дающие ровно 17 знаков. */
function joined(line: string): string[] {
  const parts = words(line)
  const out: string[] = []
  for (let start = 0; start < parts.length; start += 1) {
    let acc = ''
    for (let end = start; end < parts.length && acc.length < 17; end += 1) {
      acc += parts[end]
      const vin = acc.length === 17 ? asVin(acc) : null
      if (vin) out.push(vin)
    }
  }
  return out
}

function asVin(token: string): string | null {
  if (token.length !== 17 || !/\d/.test(token) || !/[A-Z]/.test(token)) return null
  const fixed = token.replaceAll('I', '1').replaceAll('O', '0').replaceAll('Q', '0')
  return vinOrFrameSchema.safeParse(fixed).success ? fixed : null
}

export class YandexVoiceTranscriber implements VoiceTranscriber {
  readonly maxSeconds = YANDEX_STT_MAX_SECONDS
  private readonly apiKey: string
  private readonly folderId: string | undefined
  private readonly fetchImpl: FetchLike

  constructor(config: YandexConfig) {
    this.apiKey = config.apiKey
    this.folderId = config.folderId
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  async transcribe(audio: Uint8Array): Promise<string | null> {
    if (audio.length === 0) return null
    if (audio.length > YANDEX_STT_MAX_BYTES) {
      console.warn(`[voice] файл ${audio.length} Б больше лимита SpeechKit (${YANDEX_STT_MAX_BYTES} Б)`)
      return null
    }

    // Голосовые Telegram — opus в контейнере ogg, родной формат SpeechKit.
    const params = new URLSearchParams({ lang: 'ru-RU', format: 'oggopus' })
    if (this.folderId) params.set('folderId', this.folderId)
    const body = new ArrayBuffer(audio.byteLength)
    new Uint8Array(body).set(audio)

    try {
      const response = await this.fetchImpl(`${YANDEX_STT_URL}?${params}`, {
        method: 'POST',
        headers: { Authorization: `Api-Key ${this.apiKey}` },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!response.ok) {
        console.warn(`[voice] SpeechKit ответил HTTP ${response.status}`)
        return null
      }
      const data: unknown = await response.json()
      const text = isRecord(data) && typeof data['result'] === 'string' ? data['result'].trim() : ''
      return text.length > 0 ? text : null
    } catch (error) {
      console.warn('[voice] запрос к SpeechKit не удался', error)
      return null
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
