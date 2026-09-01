import type { DbClient } from '../db'
import type { TranslationProvider } from './translation-provider'

/**
 * Перевод названий деталей и категорий каталога на русский с кэшем в БД.
 *
 * Три слоя, в порядке проверки:
 *   1. `RU_OVERRIDES` — ручной словарь. Стоит первым, поэтому правка формулировки
 *      действует сразу и не требует чистки кэша.
 *   2. Таблица `catalog_translations` — то, что уже переводила модель. Ключ —
 *      исходная строка провайдера; перевод общий для всех пользователей.
 *   3. Провайдер перевода (модель). Только для строк, которых нет в первых двух.
 *
 * Отказ перевода не считается ошибкой: строка возвращается как есть, поиск
 * продолжает работать. Каталог важнее косметики названий.
 */
export class CatalogTranslator {
  constructor(
    private readonly db: DbClient,
    private readonly provider: TranslationProvider,
  ) {}

  /**
   * Возвращает карту «исходная строка → русский перевод». Строки, которые
   * перевести не удалось, в карту не попадают — вызывающая сторона оставляет
   * оригинал.
   */
  async translate(texts: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    const pending = new Set<string>()

    for (const text of texts) {
      const source = text.trim()
      if (!isTranslatable(source) || result.has(source) || pending.has(source)) continue

      const override = RU_OVERRIDES.get(normalizeSource(source))
      if (override) {
        result.set(source, override)
        continue
      }

      pending.add(source)
    }

    if (pending.size === 0) return result

    const missing = await this.readCache([...pending], result)
    if (missing.length === 0) return result

    // Пакеты уходят параллельно: перевод блокирует выдачу поиска, а первый
    // запрос по новому автомобилю приносит до сотни новых названий сразу.
    const batches = chunk(missing, TRANSLATION_BATCH_SIZE)
    const translated = await Promise.all(
      batches.map(async (batch) => ({ batch, values: await this.provider.translate(batch) })),
    )

    const fresh: { source: string; ru: string }[] = []
    for (const { batch, values } of translated) {
      if (!values) continue
      batch.forEach((source, index) => {
        const ru = values[index]?.trim()
        if (!ru) return
        result.set(source, ru)
        fresh.push({ source, ru })
      })
    }

    await this.writeCache(fresh)
    return result
  }

  /** Достаёт готовые переводы из БД; возвращает строки, которых там нет. */
  private async readCache(sources: string[], into: Map<string, string>): Promise<string[]> {
    let cached: { source: string; ru: string }[] = []
    try {
      cached = await this.db.catalogTranslation.findMany({
        where: { source: { in: sources } },
        select: { source: true, ru: true },
      })
    } catch (error) {
      // Недоступный кэш не должен ронять поиск — просто переведём заново.
      console.warn('[translation] чтение кэша не удалось', error)
    }

    for (const row of cached) into.set(row.source, row.ru)
    return sources.filter((source) => !into.has(source))
  }

  private async writeCache(rows: { source: string; ru: string }[]): Promise<void> {
    if (rows.length === 0) return
    try {
      await this.db.catalogTranslation.createMany({
        data: rows.map((row) => ({ ...row, model: this.provider.model })),
        skipDuplicates: true,
      })
    } catch (error) {
      // Потеря записи в кэш стоит лишнего вызова модели в следующий раз, не более.
      console.warn('[translation] запись кэша не удалась', error)
    }
  }
}

/** Размер пакета: держит ответ модели в пределах max_tokens и даёт параллелизм. */
const TRANSLATION_BATCH_SIZE = 40

/**
 * Предел длины исходной строки. Ключ кэша — btree-индекс по тексту (лимит
 * ~2704 байта), да и названия деталей столько не занимают: всё длиннее —
 * мусор от провайдера, его не переводим.
 */
const MAX_SOURCE_LENGTH = 200

/**
 * Ручные переопределения: `нормализованный исходный текст → русское название`.
 * Пополняется, когда формулировка модели не устраивает — правка действует
 * сразу, кэш чистить не нужно. Ключ нормализуется `normalizeSource`
 * (верхний регистр, схлопнутые пробелы), значение пишется как надо показать.
 */
export const RU_OVERRIDES = new Map<string, string>([
  ['ENGINE', 'Двигатель'],
  ['TRANSMISSION', 'Трансмиссия'],
  ['BODY', 'Кузов'],
  ['ELECTRICAL', 'Электрооборудование'],
])

/** Приводит исходный текст к ключу словаря переопределений. */
export function normalizeSource(source: string): string {
  return source.trim().replace(/\s+/g, ' ').toUpperCase()
}

/**
 * Переводим только то, что имеет смысл переводить: непустой текст разумной
 * длины, ещё не на русском, в котором есть настоящее слово — иероглифы или
 * латинское слово от трёх букв без цифр. Иначе это каталожный номер вроде
 * «06K103495AM»: переводить в нём нечего, а вызов модели стоил бы денег.
 */
export function isTranslatable(source: string): boolean {
  if (source.length === 0 || source.length > MAX_SOURCE_LENGTH) return false
  if (/[а-яё]/i.test(source)) return false
  if (/[一-鿿]/.test(source)) return true
  return source.split(/[^A-Za-z0-9]+/).some((token) => /^[A-Za-z]{3,}$/.test(token))
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
}
