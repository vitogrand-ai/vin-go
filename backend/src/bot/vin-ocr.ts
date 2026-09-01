import Anthropic from '@anthropic-ai/sdk'
import { vinOrFrameSchema } from '@web-app-demo/contracts'

import { supportsEffort } from '../catalog/translation-provider'

/**
 * Распознавание VIN с фотографии шильдика, таблички кузова, ПТС или СТС.
 *
 * Зачем: мастер стоит под капотом с телефоном в одной руке. Набрать 17 символов
 * без ошибки трудно — путаются 0/O, 1/I, 5/S, а неверный VIN даёт неверную
 * машину и не ту деталь. Сфотографировать табличку быстрее и надёжнее.
 *
 * Перенесено из Python-прототипа (VINGO, `bot/services/vin_ocr.py`), где та же
 * задача решалась через OpenAI Vision. Здесь используется Claude — ключ
 * `ANTHROPIC_API_KEY` в проекте уже есть под перевод каталога, второй провайдер
 * ради одной функции не нужен.
 */
export interface VinOcrProvider {
  /**
   * Возвращает VIN (или frame-номер) с фотографии, либо null, если на снимке
   * его нет или распознать не удалось. Не бросает: бот должен ответить
   * подсказкой, а не молчать из-за сбоя модели.
   */
  extractVin(image: VinPhoto): Promise<string | null>
}

/** Фотография из Telegram: байты и MIME-тип, который вернул мессенджер. */
export type VinPhoto = {
  bytes: Uint8Array
  mediaType: SupportedImageMediaType
}

/** Типы изображений, которые принимает Claude Vision. */
export type SupportedImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

const SUPPORTED_MEDIA_TYPES: readonly SupportedImageMediaType[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]

/**
 * Определяет тип изображения по сигнатуре файла. Telegram присылает путь без
 * надёжного MIME, а угадывать по расширению нельзя: сжатое фото приходит .jpg
 * даже когда исходник был png. Возвращает null для неподдерживаемых форматов
 * (например HEIC с айфона) — такой снимок в модель не отправляем.
 */
export function detectImageMediaType(bytes: Uint8Array): SupportedImageMediaType | null {
  if (bytes.length < 12) return null

  /** Совпадает ли сигнатура с байтами начиная с `offset`. */
  const matches = (offset: number, ...signature: number[]): boolean =>
    signature.every((byte, index) => bytes[offset + index] === byte)

  if (matches(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (matches(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (matches(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  // WebP: контейнер RIFF, у которого на 8-м байте стоит метка формата.
  if (matches(0, 0x52, 0x49, 0x46, 0x46) && matches(8, 0x57, 0x45, 0x42, 0x50)) {
    return 'image/webp'
  }
  return null
}

export function isSupportedImageMediaType(value: string): value is SupportedImageMediaType {
  return (SUPPORTED_MEDIA_TYPES as readonly string[]).includes(value)
}

/** Модель по умолчанию. Переопределяется `VIN_OCR_MODEL`. */
export const VIN_OCR_DEFAULT_MODEL = 'claude-opus-5'

/**
 * Инструкция намеренно требует голый JSON и разрешает честное «не вижу».
 * Выдуманный VIN хуже отказа: он уводит мастера на чужую машину, и ошибка
 * всплывёт только когда придёт не та деталь.
 */
const SYSTEM_PROMPT = `Ты распознаёшь VIN автомобиля на фотографии для автосервиса.

На снимке может быть: шильдик под капотом, табличка на стойке двери, выбитый на кузове номер, ПТС, СТС или скан документа.

VIN — 17 символов латиницей и цифрами. Букв I, O, Q в VIN не бывает: если символ похож на них, это 1, 0 и 0 соответственно.
У японских машин для внутреннего рынка VIN может отсутствовать — тогда на табличке стоит номер кузова (frame) вида SXA10-0012345.

Ответ — ТОЛЬКО JSON, без markdown и пояснений:
{"vin": "<17 символов>"} — если номер читается уверенно;
{"vin": null} — если номера на фото нет, он смазан, перекрыт или читается неоднозначно.

Не угадывай и не восстанавливай нечитаемые символы: неверный VIN приведёт мастера к чужой машине. Лучше вернуть null.`

export type AnthropicVinOcrConfig = {
  apiKey: string
  model?: string
  /** Подмена клиента в тестах. */
  client?: Pick<Anthropic, 'messages'>
}

export class AnthropicVinOcrProvider implements VinOcrProvider {
  readonly model: string
  private readonly client: Pick<Anthropic, 'messages'>

  constructor(config: AnthropicVinOcrConfig) {
    this.model = config.model ?? VIN_OCR_DEFAULT_MODEL
    this.client =
      config.client ??
      new Anthropic({
        apiKey: config.apiKey,
        // Мастер ждёт ответа в чате: лучше признать неудачу, чем висеть минуту.
        timeout: 30_000,
        maxRetries: 1,
      })
  }

  async extractVin(image: VinPhoto): Promise<string | null> {
    let response: Anthropic.Message
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: 200,
        system: SYSTEM_PROMPT,
        // Распознавание символов — задача механическая, глубокие рассуждения
        // только добавили бы задержку живому пользователю.
        ...(supportsEffort(this.model) ? { output_config: { effort: 'low' as const } } : {}),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: image.mediaType,
                  data: Buffer.from(image.bytes).toString('base64'),
                },
              },
              { type: 'text', text: 'Найди VIN или номер кузова на этом фото.' },
            ],
          },
        ],
      })
    } catch (error) {
      console.warn('[vin-ocr] запрос к модели не удался', error)
      return null
    }

    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
      console.warn(`[vin-ocr] ответ модели непригоден (stop_reason=${response.stop_reason})`)
      return null
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')

    return parseVinAnswer(text)
  }
}

/**
 * Разбор ответа модели. Любой сбой формата — это null: бот попросит прислать
 * VIN текстом. Результат дополнительно проверяется контрактом, поэтому
 * галлюцинация «почти VIN» из 16 символов до поиска не дойдёт.
 */
export function parseVinAnswer(text: string): string | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const value = (parsed as { vin?: unknown }).vin
  if (typeof value !== 'string') return null

  const candidate = vinOrFrameSchema.safeParse(value.replace(/\s+/g, ''))
  return candidate.success ? candidate.data : null
}
