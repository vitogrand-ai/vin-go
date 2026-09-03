import type { Part, Vehicle } from '@web-app-demo/contracts'

import { int, isRecord, str } from './parse-utils'
import { requestProviderJson } from './provider-http'
import type { CatalogProvider } from './providers'

/**
 * Адаптер PartsAPI.ru — REST поверх TecDoc 2025Q4 и CrossBase (~428 млн кроссов).
 *
 * В отличие от скелетов acat/PartsIndex, это перенос БОЕВОЙ интеграции из
 * Python-прототипа (VINGO, `bot/services/partsapi.py`): имена полей, значения
 * `lang` и последовательность вызовов проверены живыми запросами на пилоте,
 * а не взяты из документации. Ключи у проекта уже оплачены.
 *
 * Цепочка TecDoc, по которой ходит поиск:
 *   1. `VINdecode` — VIN → модификации автомобиля; даёт `carId`;
 *   2. `getSearchTree` — `carId` → дерево товарных групп на русском;
 *   3. `getArticles` — узел дерева + `carId` → применимые артикулы с брендами.
 *
 * Шаг 2 обязателен: артикулы запрашиваются не по названию, а по узлу дерева,
 * поэтому текстовый запрос сначала сопоставляется с именами узлов. Канонизацией
 * запроса занимается слой выше (`part-jargon.ts`), сюда приходит уже «Фильтр
 * масляный», а не «масляник».
 *
 * ⚠️ Требуется российский IP: на зарубежных адресах API висит до таймаута.
 */

export const PARTSAPI_DEFAULT_BASE_URL = 'https://api.partsapi.ru'

/** Код русского языка в TecDoc. Проверено на пилоте: дерево приходит по-русски. */
const LANG_RU = 16

/** Тип техники TecDoc: PC — легковые. CV — коммерческие, Motorcycle — мото. */
const CAR_TYPE_PASSENGER = 'PC'

/**
 * PartsAPI отвечает медленнее прочих провайдеров (на пилоте — до 45 с через VPN).
 * Дефолтные 5 с общего слоя обрывали бы почти каждый запрос, поэтому таймаут
 * свой; он всё равно ограничен, чтобы зависший upstream не держал пользователя.
 */
const PARTSAPI_TIMEOUT_MS = 20_000

export type PartsApiConfig = {
  /**
   * Общий ключ. На демо-тарифе PartsAPI выдаёт отдельный ключ на каждый метод —
   * тогда они передаются в `methodKeys`, а сюда идёт любой из них как запасной.
   */
  apiKey: string
  /** Ключи под конкретные методы (демо-тариф). Имя метода — как в API. */
  methodKeys?: Partial<Record<PartsApiMethod, string>>
  baseUrl?: string
  fetchImpl?: typeof fetch
}

export type PartsApiMethod = 'VINdecode' | 'getSearchTree' | 'getArticles'

export class PartsApiCatalogProvider implements CatalogProvider {
  private readonly apiKey: string
  private readonly methodKeys: Partial<Record<PartsApiMethod, string>>
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(config: PartsApiConfig) {
    this.apiKey = config.apiKey
    this.methodKeys = config.methodKeys ?? {}
    this.baseUrl = (config.baseUrl ?? PARTSAPI_DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  async decodeVin(vin: string): Promise<Vehicle | null> {
    const data = await this.call('VINdecode', { vin, lang: 'ru' })
    if (data === null) return null

    const variants = extractVariants(data)
    if (variants.length === 0) return null

    // Берём первую модификацию, остальные кладём в raw: у машины без года
    // вариантов бывает несколько (разные двигатели), и выбор мастера — это
    // отдельный шаг UI. Поиск деталей всё равно идёт по carId выбранного.
    const chosen = variants[0]!
    return mapVehicle(vin, chosen, variants)
  }

  async searchParts(vehicle: Vehicle, query: string): Promise<Part[]> {
    const carId = carIdOf(vehicle)
    if (!carId) return []

    const tree = await this.call('getSearchTree', {
      carId: String(carId),
      carType: CAR_TYPE_PASSENGER,
      lang: String(LANG_RU),
    })
    if (tree === null) return []

    const nodes = extractTreeNodes(tree)
    const matched = matchNodes(nodes, query)
    if (matched.length === 0) return []

    // Узлов-кандидатов может быть несколько («Фильтр масляный» встречается в
    // разных ветках). Спрашиваем их последовательно и берём первый непустой:
    // каждый вызов платный, перебирать всё дерево незачем.
    for (const node of matched) {
      const articles = await this.call('getArticles', {
        strId: String(node.strId),
        carId: String(carId),
        carType: CAR_TYPE_PASSENGER,
        lang: String(LANG_RU),
      })
      if (articles === null) continue

      const parts = mapArticles(articles, node.name)
      if (parts.length > 0) return parts
    }

    return []
  }

  /** Ключ метода: на демо-тарифе свой у каждого, иначе общий. */
  private keyFor(method: PartsApiMethod): string {
    return this.methodKeys[method] ?? this.apiKey
  }

  /** Один вызов PartsAPI. Все методы дергают один URL, отличаясь параметром `method`. */
  private call(
    method: PartsApiMethod,
    params: Record<string, string>,
  ): Promise<unknown | null> {
    const search = new URLSearchParams({ method, key: this.keyFor(method), ...params })
    return requestProviderJson({
      provider: 'PartsAPI',
      url: `${this.baseUrl}/?${search.toString()}`,
      fetchImpl: this.fetchImpl,
      timeoutMs: PARTSAPI_TIMEOUT_MS,
    })
  }
}

/** Узел дерева товарных групп TecDoc. */
type TreeNode = {
  strId: number
  name: string
  /** Полный путь-хлебные крошки: «Двигатель > Система смазки > Фильтр масляный». */
  path: string
}

/**
 * VINdecode отдаёт модификации словарём с числовыми ключами
 * (`{"result": {"0": {...}, "1": {...}}}`), а не массивом. Часть развёртываний
 * возвращает массив — поддерживаем оба варианта.
 */
export function extractVariants(data: unknown): Record<string, unknown>[] {
  if (!isRecord(data)) return []
  const result = data.result
  if (Array.isArray(result)) return result.filter(isRecord)
  if (isRecord(result)) return Object.values(result).filter(isRecord)
  return []
}

/** Карточка автомобиля из модификации TecDoc. */
function mapVehicle(
  vin: string,
  variant: Record<string, unknown>,
  allVariants: Record<string, unknown>[],
): Vehicle | null {
  const make = str(variant, ['manuName', 'manuShortName'])
  const model = str(variant, ['modelName'])
  if (!make || !model) return null

  const typeName = str(variant, ['typeName'])
  const capacityLiters = str(variant, ['cylinderCapacityLiter'])

  return {
    vin,
    make,
    model,
    // Год выпуска модификации — начало производства; точного года по VIN
    // TecDoc не даёт (для этого в прототипе подключался Автокод).
    year: int(variant, ['yearOfConstrFrom', 'yearFrom']),
    engine: [typeName, capacityLiters ? `${capacityLiters} л` : null].filter(Boolean).join(', ') || null,
    bodyType: str(variant, ['bodyStyle']),
    raw: {
      // carId нужен всем последующим методам TecDoc — без него поиск деталей
      // невозможен, поэтому он часть карточки, а не локальная переменная.
      carId: int(variant, ['carId']),
      modId: int(variant, ['modId']),
      manuId: int(variant, ['manuId']),
      fuelType: str(variant, ['fuelType']),
      powerHp: int(variant, ['powerHpFrom', 'powerHpTo']),
      /** Все найденные модификации — для выбора мастером «не та модификация?». */
      variants: allVariants,
    },
  }
}

/** carId из карточки автомобиля; null, если машина пришла не от PartsAPI. */
function carIdOf(vehicle: Vehicle): number | null {
  const raw = vehicle.raw
  if (!isRecord(raw)) return null
  const carId = raw.carId
  return typeof carId === 'number' && carId > 0 ? carId : null
}

/**
 * getSearchTree отдаёт плоский список узлов с полями в стиле TecDoc
 * (`STR_ID`, `STR_NODE_NAME`, `STR_PATH`). Иерархия нам не нужна: ищем по имени.
 */
export function extractTreeNodes(data: unknown): TreeNode[] {
  const items = collectItems(data)
  const nodes: TreeNode[] = []
  for (const item of items) {
    const strId = int(item, ['STR_ID', 'strId'])
    const name = str(item, ['STR_NODE_NAME', 'name'])
    if (!strId || !name) continue
    nodes.push({ strId, name, path: str(item, ['STR_PATH', 'path']) ?? name })
  }
  return nodes
}

/**
 * Узлы, подходящие под запрос: сначала точные совпадения имени, затем
 * вхождения. Порядок важен — «Фильтр масляный» должен опередить «Корпус
 * масляного фильтра», иначе мастеру придёт не та деталь.
 */
export function matchNodes(nodes: TreeNode[], query: string): TreeNode[] {
  const needle = normalize(query)
  if (!needle) return []

  const exact: TreeNode[] = []
  const partial: TreeNode[] = []
  for (const node of nodes) {
    const name = normalize(node.name)
    if (name === needle) exact.push(node)
    else if (name.includes(needle) || needle.includes(name)) partial.push(node)
  }
  // Короткое имя узла — более общая категория, она надёжнее длинной уточняющей.
  partial.sort((a, b) => a.name.length - b.name.length)
  return [...exact, ...partial]
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
}

/** Артикулы TecDoc → запчасти контракта. */
export function mapArticles(data: unknown, fallbackCategory: string): Part[] {
  const items = collectItems(data)
  const parts: Part[] = []
  const seen = new Set<string>()

  for (const item of items) {
    const article = str(item, ['ART_ARTICLE_NR', 'artArticleNr', 'article'])
    if (!article) continue
    // Один и тот же артикул приходит от нескольких поставщиков данных —
    // в выдаче он должен быть один.
    if (seen.has(article)) continue
    seen.add(article)

    parts.push({
      oemNumber: article,
      name: str(item, ['PRODUCT GROUP', 'genericName', 'name', 'shortName']) ?? fallbackCategory,
      category: fallbackCategory,
      brand: str(item, ['ART_SUP_BRAND', 'supBrand', 'brand']),
    })
  }
  return parts
}

/**
 * Ответы PartsAPI приходят то массивом, то объектом `{result: [...]}`, то
 * словарём с числовыми ключами. Приводим к списку записей.
 */
function collectItems(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter(isRecord)
  if (!isRecord(data)) return []

  const result = data.result
  if (Array.isArray(result)) return result.filter(isRecord)
  if (isRecord(result)) return Object.values(result).filter(isRecord)
  return []
}
