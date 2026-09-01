import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'

/**
 * Провайдер перевода текстов каталога на русский. Интерфейс отделён от
 * реализации по той же причине, что и остальные провайдеры каталога: боевой
 * адаптер включается ключом в env, а тесты и офлайн-сценарии подставляют свой.
 */
export interface TranslationProvider {
  /** Идентификатор модели — пишется в кэш, чтобы можно было сбросить переводы старой модели. */
  readonly model: string
  /**
   * Переводит строки пакетом, сохраняя порядок. Возвращает null, если перевод
   * не удался: вызывающая сторона должна показать исходный текст, а не падать.
   */
  translate(texts: string[]): Promise<string[] | null>
}

/** Ответ модели — массив переводов той же длины, что и запрос. */
const translationsSchema = z.array(z.string())

export const DEFAULT_TRANSLATION_MODEL = 'claude-sonnet-5'

/**
 * Системная инструкция. Держим её неизменной: она уходит одним и тем же
 * префиксом в каждый запрос и потому кэшируется на стороне API.
 *
 * Правила выведены из реальных ответов 17vin (Toyota EPC): названия приходят
 * в заводском стиле — инверсия через запятую, сокращения (ASSY, W/, RH) и
 * опечатки самого завода («ELEMEMT»). Дословный перевод такого текста читается
 * как машинный, поэтому модель просят разворачивать его в нормальное русское
 * название, каким деталь называют в магазине.
 */
const SYSTEM_PROMPT = `Ты переводишь названия автозапчастей и категорий из заводского каталога (EPC) на русский язык.

Вход — JSON-массив строк на английском или китайском.
Ответ — ТОЛЬКО JSON-массив строк той же длины и в том же порядке. Без пояснений, без markdown.

Правила перевода:
- Пиши так, как деталь называют в российских магазинах автозапчастей.
- Раскрывай сокращения каталога: ASSY/ASSEMBLY — «в сборе», SUB-ASSY — «узел в сборе», W/ — «с», W/O — «без», RH — «правый», LH — «левый», FR/FRONT — «передний», RR/REAR — «задний», NO.1 — «№1».
- Заводскую инверсию через запятую разворачивай в естественный порядок слов: «CAP ASSY, OIL FILTER» → «Крышка масляного фильтра в сборе».
- Опечатки завода переводи по смыслу: «ELEMEMT» — это «element».
- Каталожные номера, коды и обозначения моделей оставляй без изменений.
- Первая буква заглавная, остальной текст строчными, кроме имён собственных и кодов.
- Строку, которая уже на русском, возвращай без изменений.`

export type AnthropicTranslationConfig = {
  apiKey: string
  model?: string
  /** Подмена клиента в тестах. */
  client?: Pick<Anthropic, 'messages'>
}

/**
 * Перевод через Claude. Модель задаётся `TRANSLATION_MODEL`; по умолчанию
 * `claude-sonnet-5` — компромисс между качеством на EPC-жаргоне и задержкой:
 * перевод происходит внутри пользовательского поиска, поэтому рассуждения
 * выключены, а усилие снижено. Для лучшего качества можно поставить
 * `claude-opus-5`, для минимальной цены — `claude-haiku-4-5`.
 */
export class AnthropicTranslationProvider implements TranslationProvider {
  readonly model: string
  private readonly client: Pick<Anthropic, 'messages'>

  constructor(config: AnthropicTranslationConfig) {
    this.model = config.model ?? DEFAULT_TRANSLATION_MODEL
    this.client =
      config.client ??
      new Anthropic({
        apiKey: config.apiKey,
        // Перевод идёт внутри запроса пользователя: лучше отдать оригинальные
        // названия, чем держать поиск полминуты. Дефолтные 10 минут не годятся.
        timeout: 20_000,
        maxRetries: 1,
      })
  }

  async translate(texts: string[]): Promise<string[] | null> {
    if (texts.length === 0) return []

    let response: Anthropic.Message
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        // Рассуждения выключены, усилие минимальное: перевод терминов — задача
        // механическая, а ждёт его живой пользователь в поиске. Старые модели
        // этих параметров не принимают, поэтому им уходит голый запрос.
        ...(supportsEffort(this.model)
          ? { thinking: { type: 'disabled' as const }, output_config: { effort: 'low' as const } }
          : {}),
        messages: [{ role: 'user', content: JSON.stringify(texts) }],
      })
    } catch (error) {
      console.warn('[translation] запрос к модели не удался', error)
      return null
    }

    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
      console.warn(`[translation] ответ модели непригоден (stop_reason=${response.stop_reason})`)
      return null
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')

    return parseTranslations(text, texts.length)
  }
}

/**
 * Поддерживает ли модель `output_config.effort` и настройку рассуждений.
 * Умеют поколения 4.6+ и пятое; Haiku 4.5 и более ранние отвечают на такой
 * запрос ошибкой 400, поэтому по умолчанию считаем, что не умеет.
 */
export function supportsEffort(model: string): boolean {
  return /^claude-(fable|mythos|opus|sonnet)-(5|4-(6|7|8))/.test(model)
}

/**
 * Разбор ответа модели. Ошибка формата не должна ломать поиск, поэтому любой
 * сбой — это null (показываем оригинальные названия), а не исключение.
 */
export function parseTranslations(text: string, expectedLength: number): string[] | null {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }

  const result = translationsSchema.safeParse(parsed)
  if (!result.success || result.data.length !== expectedLength) return null
  return result.data
}
