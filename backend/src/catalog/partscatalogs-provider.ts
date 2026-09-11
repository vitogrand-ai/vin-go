import type { Part, Vehicle } from '@web-app-demo/contracts'

import { AppError } from '../http/errors'
import { CATALOG_SOURCE_KEY } from './fallback-catalog'
import { asArray, firstArray, int, isRecord, str } from './parse-utils'
import { partSynonyms } from './part-jargon'
import { positionRank } from './position-filter'
import { englishPartTerms } from './part-terms'
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
 *     Выдача parts2 прореживается (см. `collectParts`): узел целиком — это
 *     десятки болтов и пыльников вокруг нужной детали.
 *   • Локализовано только универсальное дерево каталога: у детали с `nameId`
 *     название на языке запроса, у остальных — оригинальное английское
 *     (`hasUniTree: false`, напр. subaru). Поэтому отбор идёт и по nameId, и по
 *     английским терминам запроса из `part-terms`.
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

/**
 * Сколько подсказок groups-suggest (sid) раскрываем в схемы — после
 * ранжирования (см. `rankSuggestions`). Пять, а не три: живьём на Subaru
 * «колодки тормозные» подсказка отдаёт четыре названия, и нужное («Диски
 * тормозные с колодками (комплект)») стоит последним.
 */
const MAX_PART_NAMES = 5

/**
 * Потолок вызовов parts2 на ОДНО название из подсказки — у популярных запросов
 * схем десятки. Названий перебирается до MAX_PART_NAMES, но перебор
 * останавливается на первом, которое дало детали, поэтому в типичном поиске
 * лишних вызовов не прибавляется.
 */
const MAX_GROUPS_PER_NAME = 3

/** Сколько раз повторяем поиск укороченным запросом, если деталей не нашлось. */
const MAX_SEARCH_PASSES = 2

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

/** Название детали из справочника каталога (ответ groups-suggest). */
export type Suggestion = { sid: string; name: string }

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

    // Запрос отрабатывается целиком, а не по одному шагу: подсказка ищет по
    // ВСЕМУ справочнику названий каталога, а не по этой машине, поэтому на
    // «амортизатор передний» она отвечает единственным «Амортизатор передний
    // пневматической подвески», которого у машины нет, — и весь поиск
    // заканчивался пустотой. Если проход не дал ни одной детали, повторяем
    // укороченным запросом (слова отбрасываются с конца). Проходов не больше
    // MAX_SEARCH_PASSES: каждый — это вызовы schemas/parts2.
    const englishTerms = englishPartTerms(q)
    let passes = 0
    for (const attempt of shortenQuery(q)) {
      // Ранжируем по ИСХОДНОМУ запросу, а не по укороченному: на втором проходе
      // от «Крышка ГБЦ» остаётся «Крышка», и по ней любая крышка каталога
      // выглядит одинаково подходящей.
      const sids = rankSuggestions(await this.suggestPartNames(ref.catalogId, attempt), q)
      if (sids.length === 0) continue // подсказка не знает фразы — она ничего не стоила

      const parts = await this.collectFromSchemas(ref, sids, vehicle.make, englishTerms, q)
      if (parts.length > 0) return parts
      if (++passes >= MAX_SEARCH_PASSES) break
    }
    return []
  }

  /** Шаг 1: текст запроса → названия деталей справочника (русский работает напрямую). */
  private async suggestPartNames(catalogId: string, query: string): Promise<Suggestion[]> {
    const suggested = await this.request(
      `/catalogs/${encodeURIComponent(catalogId)}/groups-suggest?${new URLSearchParams({ q: query })}`,
    )
    const out: Suggestion[] = []
    for (const item of asArray(suggested) ?? []) {
      const sid = str(item, ['sid', 'id'])
      if (sid !== null) out.push({ sid, name: str(item, ['name']) ?? '' })
    }
    return out
  }

  /**
   * Шаги 2-3: sid → схемы узлов (groupId + название + картинка) → детали узла,
   * прореженные до того, что спрашивали (см. `collectParts`).
   */
  private async collectFromSchemas(
    ref: CarRef,
    sids: string[],
    brand: string | null,
    englishTerms: string[],
    query: string,
  ): Promise<Part[]> {
    // Кандидаты обходятся ПО ОДНОМУ, а не общим списком: подсказка ставит первым
    // не обязательно то, что спрашивали («блок цилиндров» → сперва «Прокладка
    // передней крышки блока цилиндров»), и раньше такой кандидат выбирал общий
    // лимит узлов, а до подходящего («Головка блока цилиндров») очередь уже не
    // доходила. Теперь каждое название получает свой шанс, а поиск
    // останавливается на первом, которое дало детали.
    const seen = new Set<string>()
    // Узлы запрашиваются по одному названию, а внутри узла годится деталь ЛЮБОГО
    // из названий запроса: подсказка на «коленвал» отдаёт и «Датчик положения
    // коленвала», и «Сальник коленвала», и они лежат в одном узле — сузить отбор
    // до одного названия значило бы потерять половину выдачи.
    const sidSet = new Set(sids)
    for (const sid of sids) {
      const parts = await this.collectForName(ref, sid, sidSet, brand, englishTerms, seen, query)
      if (parts.length > 0) return parts
    }
    return []
  }

  /** Узлы одного названия из справочника; детали — по всем названиям запроса. */
  private async collectForName(
    ref: CarRef,
    sid: string,
    sidSet: Set<string>,
    brand: string | null,
    englishTerms: string[],
    seen: Set<string>,
    query: string,
  ): Promise<Part[]> {
    const params = new URLSearchParams({ carId: ref.carId, partNameIds: sid })
    if (ref.criteria) params.set('criteria', ref.criteria)
    const data = await this.request(
      `/catalogs/${encodeURIComponent(ref.catalogId)}/schemas?${params}`,
    )

    // Узлы, отвечающие позиции из запроса, — вперёд, и только потом лимит.
    // Отсекать в порядке каталога нельзя: у колодок схем больше трёх, и
    // передний тормоз в них не попадал (см. `positionRank`).
    const groups = new Map<string, { category: string; imageUrl: string | null }>()
    for (const schema of rankByPosition(firstArray(data, ['list']) ?? [], query)) {
      const groupId = str(schema, ['groupId', 'id'])
      if (!groupId || groups.has(groupId)) continue
      groups.set(groupId, {
        category: str(schema, ['name']) ?? '',
        imageUrl: normalizeImageUrl(str(schema, ['img'])),
      })
      if (groups.size >= MAX_GROUPS_PER_NAME) break
    }

    const parts: Part[] = []
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
      collectParts(data, {
        category: group.category,
        imageUrl,
        brand,
        sidSet,
        englishTerms,
        seen,
        out: parts,
      })
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
  // `modelName` — читаемое имя модели («C4», «A-class»), а `title` у части
  // каталогов содержит код модификации («177.087     (A 200)») — показывать
  // его мастеру как модель нельзя. Полный title сохраняем в raw.
  const model = str(car, ['modelName', 'title', 'name'])
  const modification = str(car, ['title'])
  if (!make && !model) return null

  const yearParam = paramValue(car, ['year'], ['год', 'year'])
  return {
    vin: vinOrFrame,
    make: make ?? 'Не определено',
    model: model ?? 'Не определено',
    year: (yearParam ? Number.parseInt(yearParam, 10) : null) ?? parseYear(car),
    engine: paramValue(car, ['spec_engine', 'engine'], ['двигатель', 'engine', 'мотор']),
    bodyType: paramValue(car, ['body', 'body_type'], ['кузов', 'body']),
    // Только координаты каталога (нужны searchParts) и модификация; полный
    // ответ не тащим.
    raw: {
      ...carRefToRaw(carRefFromCar(car)),
      ...(modification && modification !== model ? { modification } : {}),
    },
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
 * Ответ parts2 (узел со схемой) → детали контракта. Узел целиком отдавать
 * нельзя: в живом ответе по переднему тормозу Subaru 36 разных деталей, из них
 * колодки — четыре, остальное крепёж, пыльники и скобы. Деталь проходит по
 * одному из двух признаков:
 *
 *   1. `nameId` — один из искомых sid. Точное попадание каталога: деталь есть в
 *      его универсальном дереве, название уже локализовано.
 *   2. Название содержит английский термин запроса. Обязательный второй путь:
 *      локализованное дерево неполное (у subaru `hasUniTree: false`), и деталь
 *      без nameId приходит с оригинальным английским названием — именно так
 *      живьём выглядят передние колодки («PAD KIT-FRONT DISK BRAKE», nameId
 *      null), из-за чего один только признак (1) отвечал «ничего не найдено».
 *
 * Точные попадания идут первыми — они называются так, как спрашивал мастер.
 * Записи без номера/названия и дубли (номер+название) пропускаются; общий
 * потолок — PARTSCATALOGS_MAX_PARTS.
 */
export function collectParts(
  data: unknown,
  ctx: {
    category: string
    /** Картинка схемы узла — общая для всех деталей этой группы. */
    imageUrl: string | null
    brand: string | null
    sidSet: Set<string>
    /** Английские термины запроса, см. `englishPartTerms`. */
    englishTerms: string[]
    seen: Set<string>
    out: Part[]
  },
): void {
  if (!isRecord(data)) return

  const exact: Part[] = []
  const byName: Part[] = []
  for (const group of asArray(data['partGroups']) ?? []) {
    for (const part of asArray(group['parts']) ?? []) {
      const oemNumber = str(part, ['number', 'id'])
      const name = str(part, ['name', 'notice'])
      if (!oemNumber || !name) continue

      const nameId = str(part, ['nameId'])
      const isExact = nameId !== null && ctx.sidSet.has(nameId)
      if (!isExact && !matchesTerms(name, ctx.englishTerms)) continue // сосед по узлу

      const key = `${oemNumber}|${name}`
      if (ctx.seen.has(key)) continue
      ctx.seen.add(key)

      const entry = { oemNumber, name, category: ctx.category, brand: ctx.brand, imageUrl: ctx.imageUrl }
      ;(isExact ? exact : byName).push(entry)
    }
  }

  for (const part of [...exact, ...byName]) {
    if (ctx.out.length >= PARTSCATALOGS_MAX_PARTS) return
    ctx.out.push(part)
  }
}

/**
 * Название детали отвечает запросу, если содержит любой из его терминов.
 *
 * Сравнение пословное, а не подстрочное: EPC пишет название в своём порядке и
 * со служебными вставками — «COIL ASSY-IGNITION» у катушки зажигания, «JOINT
 * ASSY-UNIVERSAL» у ШРУСа (живьём, Hyundai). Подстрока «ignition coil» такое
 * название не ловит, хотя это ровно то, что спрашивали. Слова термина должны
 * найтись в названии целиком — «pad» не совпадёт с «padding».
 */
function matchesTerms(name: string, terms: string[]): boolean {
  if (terms.length === 0) return false
  const nameWords = new Set(splitWords(name))
  return terms.some((term) => {
    const termWords = splitWords(term)
    return termWords.length > 0 && termWords.every((word) => nameWords.has(word))
  })
}

/** Слова названия: EPC разделяет их дефисами, запятыми и слэшами, не только пробелом. */
function splitWords(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/**
 * Схемы узлов в порядке соответствия позиции из запроса; порядок каталога
 * сохраняется внутри равных. Запрос без позиции ничего не меняет.
 */
export function rankByPosition(schemas: Record<string, unknown>[], query: string): Record<string, unknown>[] {
  return schemas
    .map((schema, order) => ({ schema, order, rank: positionRank(str(schema, ['name']) ?? '', query) }))
    .sort((a, b) => b.rank - a.rank || a.order - b.order)
    .map((ranked) => ranked.schema)
}

/**
 * Подсказки справочника, отсортированные по близости к детали из запроса.
 *
 * Подсказка нечёткая: справочнику хватает одного общего слова, поэтому на
 * «Крышка ГБЦ» он отдаёт и «Крышка расширительного бачка системы охлаждения».
 * Раньше выигрывало название, которое каталог поставил первым, и мастеру
 * уезжала схема чужого узла (живьём: Citroen C4, «клапанная крышка» →
 * расширительный бачок).
 *
 * Сверяемся не с одним написанием запроса, а со ВСЕМ синонимическим рядом
 * детали (`partSynonyms`): каждый каталог зовёт деталь по-своему, и заранее
 * неизвестно, какое из имён ряда он использует. Побеждает название, ближе
 * всего подошедшее хоть к одному имени ряда, и только потом список режется до
 * MAX_PART_NAMES — точное попадание не должно отсечься лимитом.
 *
 * Названия без общих слов НЕ выбрасываются: у каталогов без русского
 * универсального дерева справочник английский, и пустым оказался бы весь
 * список. Порядок каталога сохраняется внутри равных — сортировка стабильная.
 */
export function rankSuggestions(suggestions: Suggestion[], query: string): string[] {
  const names = [query, ...partSynonyms(query)]
    .map(wordKeys)
    .filter((keys) => keys.size > 0)

  return suggestions
    .map((suggestion, order) => ({
      sid: suggestion.sid,
      order,
      score: closeness(suggestion.name, names),
    }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_PART_NAMES)
    .map((ranked) => ranked.sid)
}

/** Насколько название подошло к ближайшему имени детали. */
function closeness(name: string, names: Set<string>[]): number {
  const words = wordList(name)
  const keys = new Set(words)
  let best = 0
  for (const candidate of names) {
    best = Math.max(best, similarity(words[0], keys, candidate))
  }
  return best
}

/**
 * Схожесть названия из справочника с одним из имён детали.
 *
 * Справочник пишет деталь ГЛАВНЫМ СЛОВОМ ВПЕРЁД, а уточнения — после:
 * «Подшипник генератора» — это подшипник, «Генератор озоновый» — генератор,
 * «Крышка ГБЦ» — крышка. Поэтому совпадение первого слова решает: с ним
 * схожесть лежит в верхней половине шкалы, без него — в нижней, и никакой
 * сосед по узлу не обойдёт саму деталь. Внутри половины порядок задаёт доля
 * общих слов (мера Жаккара): она отделяет «Крышка ГБЦ» от «Крышка
 * расширительного бачка системы охлаждения», у которых главное слово одно.
 *
 * Одной долей общих слов обойтись нельзя: она штрафует название за каждое
 * уточнение, и короткий чужой сосед обгонял точную, но подробную деталь.
 */
function similarity(head: string | undefined, keys: Set<string>, candidate: Set<string>): number {
  let common = 0
  for (const key of candidate) {
    if (keys.has(key)) common += 1
  }
  if (common === 0) return 0
  const jaccard = common / (keys.size + candidate.size - common)
  return head !== undefined && candidate.has(head) ? (1 + jaccard) / 2 : jaccard / 2
}

/**
 * Слова строки по порядку, огрублённые до пятибуквенного начала: так «головки»
 * и «головка» считаются одним словом, и русская морфология не мешает сравнению
 * без настоящего стемминга. Порядок важен — первое слово несёт саму деталь.
 */
function wordList(value: string): string[] {
  return value
    .toLowerCase()
    .replaceAll('ё', 'е')
    .split(/[^a-zа-я0-9]+/)
    .filter(Boolean)
    .map((word) => word.slice(0, 5))
}

function wordKeys(value: string): Set<string> {
  return new Set(wordList(value))
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
 * либо отбрасываем. Уменьшенную копию заменяем оригиналом (см. `toOriginalSize`).
 */
export function normalizeImageUrl(raw: string | null): string | null {
  if (!raw) return null
  const value = raw.trim()
  if (value.startsWith('//')) return toOriginalSize(`https:${value}`)
  if (value.startsWith('http://') || value.startsWith('https://')) return toOriginalSize(value)
  return null
}

/**
 * Список схем отдаёт превью — путь с сегментом размера («/r/300x430/…», реально
 * 300×410). На схеме узла подписаны номера позиций, и в таком масштабе мастер их
 * не прочитает. Оригинал лежит по тому же адресу без этого сегмента и оказывается
 * крупнее (787×1076) и при этом легче (80 КБ против 91 КБ: превью отдаётся
 * интерлейсным). Больший запрошенный размер каталог не апскейлит — отдаёт тот же
 * оригинал, поэтому просто убираем сегмент.
 */
function toOriginalSize(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.pathname = parsed.pathname.replace(/^\/r\/\d+x\d+\//, '/')
    return parsed.toString()
  } catch {
    // Адрес не разобрался — отдаём как есть: превью лучше, чем ничего.
    return url
  }
}
