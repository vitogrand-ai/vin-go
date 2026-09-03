import type { Part, Vehicle } from '@web-app-demo/contracts'

import { AppError } from '../http/errors'
import { CATALOG_SOURCE_KEY } from './fallback-catalog'
import { asArray, firstArray, int, isRecord, str } from './parse-utils'
import { requestProviderJson } from './provider-http'
import type { CatalogProvider } from './providers'

/**
 * Адаптер каталога parts-catalogs.com — мировой OEM-каталог (легковые + грузовые,
 * от Subaru/Kia до BMW/Scania), поиск по VIN и по FRAME. Подключается в
 * `createCatalogProviders` по `PARTSCATALOGS_API_KEY`.
 *
 * Сверено с документацией (docs.parts-catalogs.ru, сент 2026):
 *   • Авторизация: заголовок `Authorization: <ключ>` (без Bearer). Доступ
 *     дополнительно привязан к IP-allowlist на стороне провайдера (ошибка 1003).
 *   • Язык: API локализован, среди поддерживаемых — русский. Шлём
 *     `Accept-Language: ru`, поэтому русский поисковый запрос работает напрямую,
 *     без словаря перевода (в отличие от 17vin).
 *   • Поиск детали — трёхшаговая навигация EPC:
 *       GET /car/info?q=<VIN|frame>                       → catalogId/carId/criteria
 *       GET /catalogs/{id}/groups-suggest?q=<текст>       → sid названий деталей
 *       GET /catalogs/{id}/schemas?carId&partNameIds=sid  → схемы (groupId)
 *       GET /catalogs/{id}/parts2?carId&groupId           → детали (nameId = sid)
 *     Выдача parts2 фильтруется по nameId ∈ найденным sid — иначе показали бы
 *     всю схему целиком (соседние детали узла).
 *   • Ошибки — коды 1xxx (1001 ACCESS_DENY, 1003 IP_DENY, 1004 QUOTA_DENY,
 *     1005 RESOURCE_DENY, 1101 IP_BANNED). Живой формат (сверен запросом с
 *     невнесённого в allowlist IP): HTTP 4xx + тело {code: <http>, errorCode:
 *     1003, message}. Любой такой ответ — отказ провайдера (502), НЕ «не
 *     найдено»: исчерпанная квота не должна маскироваться под пустой результат.
 *   • Не поддержан текстовый поиск в каталогах грузовиков и китайцев (FAQ) —
 *     там groups-suggest отвечает пусто, для нас это штатное «не нашли».
 */

/** Базовый URL API (из документации); переопределяется `PARTSCATALOGS_BASE_URL`. */
export const PARTSCATALOGS_DEFAULT_BASE_URL = 'https://api.parts-catalogs.com/v1'

/** Потолок деталей в ответе поиска — не тащим всю выдачу узлов через контракт в UI. */
export const PARTSCATALOGS_MAX_PARTS = 100

/** Сколько первых подсказок groups-suggest (sid) раскрываем в схемы. */
const MAX_PART_NAMES = 3

/** Потолок вызовов parts2 на один поиск — у популярных запросов схем десятки. */
const MAX_GROUPS = 4

/** Имя источника в fallback-цепочке (см. createCatalogProviders). */
const SOURCE_NAME = 'partscatalogs'

export type PartsCatalogsConfig = {
  apiKey: string
  baseUrl?: string
  /** Инъекция fetch — для тестов; по умолчанию глобальный fetch. */
  fetchImpl?: typeof fetch
}

/** Координаты авто в каталоге — сохраняются в raw при decodeVin, нужны поиску. */
type CarRef = { catalogId: string; carId: string; criteria: string | null }

export class PartsCatalogsCatalogProvider implements CatalogProvider {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(config: PartsCatalogsConfig) {
    this.apiKey = config.apiKey
    this.baseUrl = (config.baseUrl ?? PARTSCATALOGS_DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  async decodeVin(vinOrFrame: string): Promise<Vehicle | null> {
    const normalized = vinOrFrame.trim().toUpperCase()
    if (!normalized) return null
    // Один эндпоинт понимает и VIN, и FRAME — разводить формат не нужно.
    const data = await this.request(`/car/info?q=${encodeURIComponent(normalized)}`)
    if (data === null) return null
    return mapVehicle(normalized, data)
  }

  async searchParts(vehicle: Vehicle, query: string): Promise<Part[]> {
    const q = query.trim()
    if (!q) return []

    // Координаты каталога кладутся в raw при decodeVin. Если авто определял
    // ДРУГОЙ каталог (best-effort ветка FallbackCatalogProvider), raw чужой —
    // его catalogId/carId имели бы чужую семантику, поэтому декодируем заново.
    const source = vehicle.raw?.[CATALOG_SOURCE_KEY]
    let ref = source === undefined || source === SOURCE_NAME ? carRefFromRaw(vehicle.raw) : null
    if (!ref) {
      const data = await this.request(
        `/car/info?q=${encodeURIComponent(vehicle.vin.trim().toUpperCase())}`,
      )
      ref = data === null ? null : carRefFromCarInfo(data)
      if (!ref) return []
    }

    // Шаг 1: текст запроса → sid названий деталей (русский работает напрямую).
    // Подсказка знает названия деталей («Колодки тормозные»), а мастер шлёт
    // уточнённую фразу («Колодки тормозные передние») — на пустом ответе
    // пробуем укороченные варианты, отбрасывая слова с конца.
    let sids: string[] = []
    for (const attempt of shortenQuery(q)) {
      const suggested = await this.request(
        `/catalogs/${encodeURIComponent(ref.catalogId)}/groups-suggest?${new URLSearchParams({ q: attempt })}`,
      )
      sids = (asArray(suggested) ?? [])
        .map((item) => str(item, ['sid', 'id']))
        .filter((sid): sid is string => sid !== null)
        .slice(0, MAX_PART_NAMES)
      if (sids.length > 0) break
    }
    if (sids.length === 0) return []
    const sidSet = new Set(sids)

    // Шаг 2: sid → схемы узлов, где такая деталь встречается
    // (groupId + название + картинка схемы).
    const groups = new Map<string, { category: string; imageUrl: string | null }>()
    for (const sid of sids) {
      if (groups.size >= MAX_GROUPS) break
      const params = new URLSearchParams({ carId: ref.carId, partNameIds: sid })
      if (ref.criteria) params.set('criteria', ref.criteria)
      const data = await this.request(
        `/catalogs/${encodeURIComponent(ref.catalogId)}/schemas?${params}`,
      )
      for (const schema of firstArray(data, ['list']) ?? []) {
        const groupId = str(schema, ['groupId', 'id'])
        if (!groupId || groups.has(groupId)) continue
        groups.set(groupId, {
          category: str(schema, ['name']) ?? '',
          imageUrl: normalizeImageUrl(str(schema, ['img'])),
        })
        if (groups.size >= MAX_GROUPS) break
      }
    }

    // Шаг 3: схема → детали; оставляем только детали искомых sid (см. collectParts).
    const parts: Part[] = []
    const seen = new Set<string>()
    for (const [groupId, group] of groups) {
      if (parts.length >= PARTSCATALOGS_MAX_PARTS) break
      const params = new URLSearchParams({ carId: ref.carId, groupId })
      if (ref.criteria) params.set('criteria', ref.criteria)
      const data = await this.request(
        `/catalogs/${encodeURIComponent(ref.catalogId)}/parts2?${params}`,
      )
      if (data === null) continue
      // У parts2 своя копия картинки схемы — берём её, если в списке схем пусто.
      const imageUrl = group.imageUrl ?? (isRecord(data) ? normalizeImageUrl(str(data, ['img'])) : null)
      collectParts(data, { category: group.category, imageUrl, brand: vehicle.make, sidSet, seen, out: parts })
    }
    return parts
  }

  /**
   * Один вызов API: ключ в Authorization, данные на русском. null — штатное
   * «нет данных» (HTTP 404 / пустое тело). HTTP-ошибки (в т.ч. 403 с errorCode
   * 1xxx) превращаются в 502 внутри requestProviderJson; конверт с errorCode
   * при HTTP 200 ловим дополнительно — квота (1004) не должна выглядеть как
   * «ничего не найдено».
   */
  private async request(path: string): Promise<unknown | null> {
    const data = await requestProviderJson({
      provider: 'parts-catalogs',
      url: `${this.baseUrl}${path}`,
      fetchImpl: this.fetchImpl,
      headers: { Authorization: this.apiKey, 'Accept-Language': 'ru' },
    })
    if (isRecord(data)) {
      const code = int(data, ['errorCode', 'code'])
      if (code !== null && code >= 1000) {
        const msg = str(data, ['message', 'msg', 'type']) ?? 'без описания'
        throw new AppError(502, 'INTERNAL_ERROR', `Провайдер parts-catalogs отказал (code ${code}: ${msg})`)
      }
    }
    return data
  }
}

/**
 * Ответ /car/info (массив модификаций) → карточка авто. Берётся первая
 * модификация — для полного VIN каталог обычно отдаёт одну. null — если
 * не удалось определить ни марку, ни модель.
 */
export function mapVehicle(vinOrFrame: string, data: unknown): Vehicle | null {
  const car = (asArray(data) ?? [])[0]
  if (!car) return null

  const make = str(car, ['brand'])
  const model = str(car, ['title', 'modelName', 'name'])
  if (!make && !model) return null

  const yearParam = paramValue(car, ['year'], ['год', 'year'])
  return {
    vin: vinOrFrame,
    make: make ?? 'Не определено',
    model: model ?? 'Не определено',
    year: (yearParam ? Number.parseInt(yearParam, 10) : null) ?? parseYear(car),
    engine: paramValue(car, ['spec_engine', 'engine'], ['двигатель', 'engine', 'мотор']),
    bodyType: paramValue(car, ['body', 'body_type'], ['кузов', 'body']),
    // Только координаты каталога — они нужны searchParts; полный ответ не тащим.
    raw: carRefToRaw(carRefFromCar(car)),
  }
}

/**
 * Значение из `parameters` живого ответа /car/info: элементы вида
 * {key: "spec_engine", name: "Двигатель", value: "CWVA"} (name локализован).
 * Ищем по машинному key, затем по префиксу локализованного name.
 */
function paramValue(car: Record<string, unknown>, keys: string[], names: string[]): string | null {
  for (const param of asArray(car['parameters']) ?? []) {
    const value = str(param, ['value'])
    if (!value) continue
    const key = str(param, ['key'])?.toLowerCase()
    if (key && keys.includes(key)) return value
    const name = str(param, ['name'])?.toLowerCase()
    if (name && names.some((prefix) => name.startsWith(prefix))) return value
  }
  return null
}

/**
 * Запасной разбор года, когда параметра year нет: год зашит в `criteria`
 * («b4*XW8AN…(2018!aebbed60») и в `description` («2018-2021. Название…»).
 * В criteria год всегда открывается скобкой — так не спутаем с цифрами VIN.
 */
function parseYear(car: Record<string, unknown>): number | null {
  const fromCriteria = (str(car, ['criteria']) ?? '').match(/\(((?:19|20)\d{2})/)
  if (fromCriteria) return Number.parseInt(fromCriteria[1]!, 10)
  const fromDescription = (str(car, ['description']) ?? '').match(/(?:19|20)\d{2}/)
  return fromDescription ? Number.parseInt(fromDescription[0], 10) : null
}

/** Первая модификация ответа /car/info → координаты каталога (для поиска). */
function carRefFromCarInfo(data: unknown): CarRef | null {
  const car = (asArray(data) ?? [])[0]
  return car ? carRefFromCar(car) : null
}

function carRefFromCar(car: Record<string, unknown>): CarRef | null {
  const catalogId = str(car, ['catalogId'])
  const carId = str(car, ['carId'])
  if (!catalogId || !carId) return null
  return { catalogId, carId, criteria: str(car, ['criteria']) }
}

function carRefToRaw(ref: CarRef | null): Record<string, unknown> {
  if (!ref) return {}
  return {
    catalogId: ref.catalogId,
    carId: ref.carId,
    ...(ref.criteria ? { criteria: ref.criteria } : {}),
  }
}

function carRefFromRaw(raw: Record<string, unknown> | undefined): CarRef | null {
  if (!raw) return null
  const catalogId = raw['catalogId']
  const carId = raw['carId']
  if (typeof catalogId !== 'string' || typeof carId !== 'string') return null
  const criteria = raw['criteria']
  return { catalogId, carId, criteria: typeof criteria === 'string' ? criteria : null }
}

/**
 * Ответ parts2 (узел со схемой) → детали контракта. Деталь попадает в выдачу,
 * только если её nameId — один из искомых sid: живой ответ показал, что без
 * nameId идут крепёж и мелочь узла («винт», «уплотнительное кольцо»), а у
 * значимых деталей nameId проставлен. Записи без номера/названия и дубли
 * (номер+название) пропускаются; общий потолок — PARTSCATALOGS_MAX_PARTS.
 */
export function collectParts(
  data: unknown,
  ctx: {
    category: string
    /** Картинка схемы узла — общая для всех деталей этой группы. */
    imageUrl: string | null
    brand: string | null
    sidSet: Set<string>
    seen: Set<string>
    out: Part[]
  },
): void {
  if (!isRecord(data)) return
  for (const group of asArray(data['partGroups']) ?? []) {
    for (const part of asArray(group['parts']) ?? []) {
      if (ctx.out.length >= PARTSCATALOGS_MAX_PARTS) return

      const nameId = str(part, ['nameId'])
      if (nameId === null || !ctx.sidSet.has(nameId)) continue // соседняя деталь/крепёж узла

      const oemNumber = str(part, ['number', 'id'])
      const name = str(part, ['name', 'notice'])
      if (!oemNumber || !name) continue

      const key = `${oemNumber}|${name}`
      if (ctx.seen.has(key)) continue
      ctx.seen.add(key)

      ctx.out.push({ oemNumber, name, category: ctx.category, brand: ctx.brand, imageUrl: ctx.imageUrl })
    }
  }
}

/**
 * Варианты запроса для groups-suggest: исходный, затем без последних слов
 * («колодки тормозные передние» → «колодки тормозные» → «колодки»). Подсказка
 * ищет по названиям деталей, где уточнений позиции обычно нет.
 */
export function shortenQuery(query: string): string[] {
  const words = query.split(/\s+/).filter(Boolean)
  const out: string[] = []
  for (let count = words.length; count >= 1; count--) {
    out.push(words.slice(0, count).join(' '))
  }
  return out
}

/**
 * Картинки схем приходят протокол-относительными («//ru.img.parts-catalogs.com/…»)
 * или с шаблонным плейсхолдером «{IMG_URL}» (пустая схема) — приводим к https
 * либо отбрасываем.
 */
export function normalizeImageUrl(raw: string | null): string | null {
  if (!raw) return null
  const value = raw.trim()
  if (value.startsWith('//')) return `https:${value}`
  if (value.startsWith('http://') || value.startsWith('https://')) return value
  return null
}
