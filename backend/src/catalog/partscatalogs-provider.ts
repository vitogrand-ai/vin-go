import type { Part, Vehicle } from '@web-app-demo/contracts'

import { AppError } from '../http/errors'
import { CATALOG_SOURCE_KEY } from './fallback-catalog'
import { asArray, firstArray, int, isRecord, str } from './parse-utils'
import { isPositionWord, positionRank } from './position-filter'
import { NAME_MATCH, NODE_MATCH, closeness, queryNames, queryNamesForOrder, wordKeys } from './part-match'
import { englishPartTerms } from './part-terms'
import { requestProviderJson } from './provider-http'
import type { CatalogProvider } from './providers'
import { vinModelYear } from './vin-year'

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

/**
 * Запасной путь через дерево узлов машины (см. `searchByTree`): сколько узлов
 * дерева раскрываем и сколько держим дерево машины в памяти. Дерево — один
 * вызов на машину (живьём 0.2 с и ~50 КБ у Skoda Kodiaq), и за час оно не
 * меняется.
 */
const MAX_TREE_LEAVES = 3
const TREE_TTL_MS = 60 * 60 * 1000

/** Лист дерева узлов машины: по нему открываются схемы (`schemas?branchId=`). */
type TreeLeaf = { id: string; name: string; path: string }

/** Сколько раз повторяем поиск укороченным запросом, если деталей не нашлось. */
const MAX_SEARCH_PASSES = 2

/** Имя источника в fallback-цепочке (см. createCatalogProviders). */
const SOURCE_NAME = 'partscatalogs'

/**
 * Таймаут одного вызова. Общих пяти секунд с боевого сервера не хватает: живьём
 * 22.09.2026 шаг `schemas` с VPS обрывался по таймауту, а тот же запрос с
 * ноутбука отвечал — поиск падал на одной машине и проходил на соседней. Поиск
 * идёт цепочкой вызовов (подсказка → схемы → узел), поэтому потолок — на вызов,
 * а бот всё это время показывает «печатает…».
 */
const PARTSCATALOGS_TIMEOUT_MS = 15_000

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

/** Чем сверяется деталь узла и куда складывается: один пакет на весь поиск. */
type SearchCtx = {
  ref: CarRef
  brand: string | null
  /** Запрос в том виде, в каком ушёл в каталог: из него читается позиция. */
  query: string
  /** sid названий подсказки — точное попадание в универсальное дерево. */
  sidSet: Set<string>
  englishTerms: string[]
  /** Имена детали из словаря, огрублённые до слов (см. `queryNames`). */
  names: Set<string>[]
  seen: Set<string>
}

export class PartsCatalogsCatalogProvider implements CatalogProvider {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  /** Листья дерева узлов по машине — для запасного пути, см. `searchByTree`. */
  private readonly trees = new Map<string, { at: number; leaves: TreeLeaf[] }>()

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

    const ref = await this.resolveRef(vehicle)
    if (!ref) return []

    // Запрос отрабатывается целиком, а не по одному шагу: подсказка ищет по
    // ВСЕМУ справочнику названий каталога, а не по этой машине, поэтому на
    // «амортизатор передний» она отвечает единственным «Амортизатор передний
    // пневматической подвески», которого у машины нет, — и весь поиск
    // заканчивался пустотой. Если проход не дал ни одной детали, повторяем
    // укороченным запросом (слова отбрасываются с конца). Проходов не больше
    // MAX_SEARCH_PASSES: каждый — это вызовы schemas/parts2.
    const englishTerms = englishPartTerms(q)
    const names = queryNames(q)
    let passes = 0
    for (const attempt of shortenQuery(q)) {
      // Ранжируем по ИСХОДНОМУ запросу, а не по укороченному: на втором проходе
      // от «Крышка ГБЦ» остаётся «Крышка», и по ней любая крышка каталога
      // выглядит одинаково подходящей.
      const sids = rankSuggestions(await this.suggestPartNames(ref.catalogId, attempt), q)
      if (sids.length === 0) continue // подсказка не знает фразы — она ничего не стоила

      const parts = await this.collectFromSchemas(
        { ref, brand: vehicle.make, query: q, sidSet: new Set(sids), englishTerms, names, seen: new Set() },
        sids,
      )
      if (parts.length > 0) return parts
      if (++passes >= MAX_SEARCH_PASSES) break
    }
    return this.searchByTree({
      ref, brand: vehicle.make, query: q, sidSet: new Set(), englishTerms, names, seen: new Set(),
    })
  }

  /**
   * Весь узел по его идентификатору: мастер смотрит на схему и называет номер
   * позиции. Отбора по названию здесь нет — на схеме фары под номером 9 стоит
   * «Жгут проводов освещения», которого мастер словами и не спросил бы.
   */
  async schemeParts(vehicle: Vehicle, schemeId: string): Promise<Part[]> {
    const ref = await this.resolveRef(vehicle)
    if (!ref) return []

    const params = new URLSearchParams({ carId: ref.carId, groupId: schemeId })
    if (ref.criteria) params.set('criteria', ref.criteria)
    const data = await this.request(
      `/catalogs/${encodeURIComponent(ref.catalogId)}/parts2?${params}`,
    )
    if (!isRecord(data)) return []

    const imageUrl = normalizeImageUrl(str(data, ['img']))
    const parts: Part[] = []
    const seen = new Set<string>()
    for (const group of asArray(data['partGroups']) ?? []) {
      for (const part of asArray(group['parts']) ?? []) {
        if (parts.length >= PARTSCATALOGS_MAX_PARTS) return parts
        const oemNumber = str(part, ['number', 'id'])
        const name = str(part, ['name', 'notice'])
        if (!oemNumber || !name) continue
        const key = `${oemNumber}|${name}`
        if (seen.has(key)) continue
        seen.add(key)
        parts.push({
          oemNumber,
          name,
          category: str(group, ['name']) ?? '',
          brand: vehicle.make,
          imageUrl,
          position: str(part, ['positionNumber']),
          schemeId,
          ...partDetails({ name, notice: str(part, ['notice']), description: str(part, ['description']) }),
        })
      }
    }
    return parts
  }

  /**
   * Координаты машины в каталоге. Кладутся в raw при decodeVin; если авто
   * определял ДРУГОЙ каталог (best-effort ветка FallbackCatalogProvider), raw
   * чужой — его catalogId/carId имели бы чужую семантику, поэтому декодируем
   * заново.
   */
  private async resolveRef(vehicle: Vehicle): Promise<CarRef | null> {
    const source = vehicle.raw?.[CATALOG_SOURCE_KEY]
    const own = source === undefined || source === SOURCE_NAME ? carRefFromRaw(vehicle.raw) : null
    if (own) return own

    const vin = vehicle.vin.trim().toUpperCase()
    const data = await this.request(`/car/info?q=${encodeURIComponent(vin)}`)
    return data === null ? null : carRefFromCarInfo(vin, data)
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
  private async collectFromSchemas(ctx: SearchCtx, sids: string[]): Promise<Part[]> {
    // Кандидаты обходятся ПО ОДНОМУ, а не общим списком: подсказка ставит первым
    // не обязательно то, что спрашивали («блок цилиндров» → сперва «Прокладка
    // передней крышки блока цилиндров»), и раньше такой кандидат выбирал общий
    // лимит узлов, а до подходящего («Головка блока цилиндров») очередь уже не
    // доходила. Теперь каждое название получает свой шанс, а поиск
    // останавливается на первом, которое дало детали.
    // Узлы запрашиваются по одному названию, а внутри узла годится деталь ЛЮБОГО
    // из названий запроса: подсказка на «коленвал» отдаёт и «Датчик положения
    // коленвала», и «Сальник коленвала», и они лежат в одном узле — сузить отбор
    // до одного названия значило бы потерять половину выдачи.
    for (const sid of sids) {
      const parts = await this.collectForName(ctx, sid)
      if (parts.length > 0) return parts
    }
    return []
  }

  /** Узлы одного названия из справочника; детали — по всем названиям запроса. */
  private async collectForName(ctx: SearchCtx, sid: string): Promise<Part[]> {
    const { ref, query } = ctx
    const params = new URLSearchParams({ carId: ref.carId, partNameIds: sid })
    if (ref.criteria) params.set('criteria', ref.criteria)
    const data = await this.request(
      `/catalogs/${encodeURIComponent(ref.catalogId)}/schemas?${params}`,
    )

    return this.collectFromGroups(ctx, schemaGroups(data, query))
  }

  /**
   * Запасной путь: узлы, похожие на запрос, по ДЕРЕВУ узлов машины.
   *
   * Основной путь спрашивает схемы по названию детали (`schemas?partNameIds=`),
   * а у части машин каталог на этот вызов отдаёт одну и ту же схему на любую
   * деталь: живьём 22.09.2026 Skoda Kodiaq на термостат, стартер, генератор и
   * сцепление отвечала «Насосом системы охлаждения», Ford на сцепление —
   * охлаждением. Детали чужого узла отсекались отбором, и восемь ходовых
   * запросов (термостат, генератор, стартер, сцепление, глушитель, дворники,
   * турбина, бензонасос) не находились ни на одной из 13 машин пилота. Дерево
   * машины (`groups-tree`) и схемы по узлу (`schemas?branchId=`) этим не
   * страдают: там у Kodiaq честные «Стартер» и «Генератор».
   *
   * Путь запасной, а не основной: на основном держатся выверенные случаи
   * корзины (точные sid, позиция, английские названия). Узел дерева берётся,
   * только если его название само близко к запросу (NAME_MATCH, а не
   * NODE_MATCH) — якоря sid здесь нет, и узел должен быть той деталью, а не
   * её окрестностью. Детали узла проходят тот же отбор, что и в основном пути.
   *
   * Сбой дерева «не найдено» в отказ не превращает: основной путь уже честно
   * ответил пусто, запасной только добирает.
   */
  private async searchByTree(ctx: SearchCtx): Promise<Part[]> {
    let leaves: TreeLeaf[]
    try {
      leaves = await this.treeLeaves(ctx.ref)
    } catch (error) {
      console.warn('[parts-catalogs] дерево узлов не получено, запасной путь пропущен', error)
      return []
    }

    for (const leaf of pickLeaves(leaves, ctx.query)) {
      const params = new URLSearchParams({ carId: ctx.ref.carId, branchId: leaf.id })
      if (ctx.ref.criteria) params.set('criteria', ctx.ref.criteria)
      const data = await this.request(
        `/catalogs/${encodeURIComponent(ctx.ref.catalogId)}/schemas?${params}`,
      )
      const parts = await this.collectFromGroups(ctx, schemaGroups(data, ctx.query))
      if (parts.length > 0) return parts
    }
    return []
  }

  /** Листья дерева узлов машины, из кэша на TREE_TTL_MS. */
  private async treeLeaves(ref: CarRef): Promise<TreeLeaf[]> {
    const key = `${ref.catalogId}|${ref.carId}|${ref.criteria ?? ''}`
    const cached = this.trees.get(key)
    if (cached && Date.now() - cached.at < TREE_TTL_MS) return cached.leaves

    const params = new URLSearchParams({ carId: ref.carId })
    if (ref.criteria) params.set('criteria', ref.criteria)
    const data = await this.request(`/catalogs/${encodeURIComponent(ref.catalogId)}/groups-tree?${params}`)
    const leaves = treeLeavesOf(asArray(data) ?? [], [])
    this.trees.set(key, { at: Date.now(), leaves })
    return leaves
  }

  /** Схемы узлов → детали, прореженные до того, что спрашивали (`collectParts`). */
  private async collectFromGroups(
    ctx: SearchCtx,
    groups: Map<string, { category: string; imageUrl: string | null }>,
  ): Promise<Part[]> {
    const { ref } = ctx
    const parts: Part[] = []
    for (const [groupId, group] of groups) {
      if (parts.length >= PARTSCATALOGS_MAX_PARTS) break
      const params = new URLSearchParams({ carId: ref.carId, groupId })
      if (ref.criteria) params.set('criteria', ref.criteria)
      const data = await this.request(
        `/catalogs/${encodeURIComponent(ref.catalogId)}/parts2?${params}`,
      )
      if (data === null) continue
      if (foreignNode(data, ctx.sidSet, group.category, ctx.query)) {
        console.warn(`[parts-catalogs] узел «${group.category}» не о том, что спрашивали: каталог отдал чужую схему`)
        continue
      }
      // У parts2 своя копия картинки схемы — берём её, если в списке схем пусто.
      const imageUrl = group.imageUrl ?? (isRecord(data) ? normalizeImageUrl(str(data, ['img'])) : null)
      collectParts(data, { ...ctx, category: group.category, imageUrl, schemeId: groupId, out: parts })
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
      timeoutMs: PARTSCATALOGS_TIMEOUT_MS,
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
 * Схемы узлов из ответа `schemas` → узлы для parts2.
 *
 * Узлы, отвечающие позиции из запроса, — вперёд, и только потом лимит; узлы
 * ПРОТИВОПОЛОЖНОЙ стороны отбрасываются совсем. Иначе поиск залипает на
 * негодном названии: живьём у Subaru передние колодки лежат под «Колодки
 * тормозные (ремкомплект)», а первым подсказка отдаёт «Колодки тормозные
 * дисковые», у которых узел только задний. Перебор названий останавливался на
 * нём, фильтр позиции в сервисе вырезал всю выдачу, и мастер видел «не
 * найдено» при живых колодках. Отбросив заведомо чужой узел, перебор доходит
 * до нужного названия.
 */
function schemaGroups(
  data: unknown,
  query: string,
): Map<string, { category: string; imageUrl: string | null }> {
  const groups = new Map<string, { category: string; imageUrl: string | null }>()
  for (const schema of rankByPosition(firstArray(data, ['list']) ?? [], query)) {
    const groupId = str(schema, ['groupId', 'id'])
    const category = str(schema, ['name']) ?? ''
    if (!groupId || groups.has(groupId)) continue
    if (positionRank(category, query) < 0) continue // узел другой стороны
    groups.set(groupId, { category, imageUrl: normalizeImageUrl(str(schema, ['img'])) })
    if (groups.size >= MAX_GROUPS_PER_NAME) break
  }
  return groups
}

/**
 * Узел из ответа parts2 — чужой: у его деталей есть идентификаторы названий
 * (`nameId`), но ни одного из тех, что спрашивали.
 *
 * Каталог отдаёт узлы на запрос ПО НАЗВАНИЮ детали (`schemas?partNameIds=`), и
 * в честном ответе хоть одна деталь узла этим названием и помечена. У части
 * машин вызов отдаёт одну схему на любую деталь (см. `searchByTree`), и отбор
 * по похожему слову пропускал из чужого узла: живьём 22.09.2026 Toyota Prado
 * на «тормозные диски» получала «Ротор - якорь генератора», на «ступичный
 * подшипник» — «Подшипник генератора».
 *
 * Одного nameId мало: у subaru дерево локализовано частично, и в своём узле
 * «Передний тормоз» nameId есть у скобы суппорта, а у самих колодок — нет.
 * Поэтому узел чужой, только если против него ОБА признака: искомого nameId
 * нет, и название узла на запрос не похоже (NODE_MATCH). «Передний тормоз» на
 * «колодки передние» похож — свой; «Генератор» на «тормозные диски» — нет.
 *
 * Правило молчит, когда судить не по чему: у деталей нет nameId вовсе, а в
 * запасном пути по дереву искомых sid нет — там узел выбран по своему названию.
 */
function foreignNode(data: unknown, sidSet: Set<string>, category: string, query: string): boolean {
  if (sidSet.size === 0 || !isRecord(data)) return false
  if (closeness(category, queryNamesForOrder(query)) >= NODE_MATCH) return false
  let labelled = false
  for (const group of asArray(data['partGroups']) ?? []) {
    for (const part of asArray(group['parts']) ?? []) {
      const nameId = str(part, ['nameId'])
      if (nameId === null) continue
      if (sidSet.has(nameId)) return false
      labelled = true
    }
  }
  return labelled
}

/** Дерево `groups-tree` ({id, name, subGroups}) → листья с путём от корня. */
function treeLeavesOf(nodes: Record<string, unknown>[], path: string[]): TreeLeaf[] {
  const out: TreeLeaf[] = []
  for (const node of nodes) {
    const id = str(node, ['id'])
    const name = str(node, ['name'])
    if (!id || !name) continue
    const children = asArray(node['subGroups']) ?? []
    const here = [...path, name]
    if (children.length === 0) out.push({ id, name, path: here.join(' > ') })
    else out.push(...treeLeavesOf(children, here))
  }
  return out
}

/**
 * Листья, которые сами называют запрошенную деталь: «Стартер» на «стартер»,
 * «Термостат системы охлаждения ДВС» на «термостат». Узел противоположной
 * стороны отбрасывается, как и в основном пути.
 */
function pickLeaves(leaves: TreeLeaf[], query: string): TreeLeaf[] {
  const names = queryNames(query)
  return leaves
    .map((leaf, order) => ({ leaf, order, score: closeness(leaf.name, names) }))
    .filter((item) => item.score >= NAME_MATCH && positionRank(item.leaf.path, query) >= 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_TREE_LEAVES)
    .map((item) => item.leaf)
}

/**
 * Ответ /car/info (массив модификаций) → карточка авто. Модификацию выбирает
 * `pickCar`. null — если не удалось определить ни марку, ни модель.
 */
export function mapVehicle(vinOrFrame: string, data: unknown): Vehicle | null {
  const car = pickCar(vinOrFrame, data)
  if (!car) return null

  const make = str(car, ['brand'])
  // `modelName` — читаемое имя модели («C4», «A-class»), а `title` у части
  // каталогов содержит код модификации («177.087     (A 200)») — показывать
  // его мастеру как модель нельзя. Полный title сохраняем в raw.
  const model = str(car, ['modelName', 'title', 'name'])
  const modification = str(car, ['title'])
  if (!make && !model) return null

  return {
    vin: vinOrFrame,
    make: make ?? 'Не определено',
    model: model ?? 'Не определено',
    year: carYear(car),
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
 * Выбор модификации из ответа /car/info.
 *
 * По одному VIN каталог отдаёт не одну машину, а список — и это РАЗНЫЕ машины
 * с разными `carId`, то есть с разными деталями. Живой случай: VW
 * `LFV3B2FY2N3102396` → «Jetta 1992 (1991-2012)», «Jetta 2022 (2020-2027
 * Limousine)» и «Jetta 2022 (2020-2027 SUV)». Первая в списке — машина
 * тридцатилетней давности: мастер получал и чужой год, и чужие детали.
 *
 * Разводит их модельный год из самого VIN (`vinModelYear`): берём модификацию,
 * чей год каталога совпал с ним, иначе — чей диапазон лет («2020-2027») его
 * накрывает. Гипотезу из VIN применяем ТОЛЬКО когда каталог её подтвердил:
 * у европейских Mercedes года в VIN нет вовсе, и там список остаётся в
 * исходном порядке — как и для единственной модификации.
 */
export function pickCar(vinOrFrame: string, data: unknown): Record<string, unknown> | null {
  const cars = asArray(data) ?? []
  if (cars.length <= 1) return cars[0] ?? null

  const vinYear = vinModelYear(vinOrFrame)
  if (vinYear === null) return cars[0]!
  return (
    cars.find((car) => carYear(car) === vinYear) ??
    cars.find((car) => yearsCover(car, vinYear)) ??
    cars[0]!
  )
}

/** Год модификации: параметр каталога, иначе год из criteria/description. */
function carYear(car: Record<string, unknown>): number | null {
  const param = paramValue(car, ['year'], ['год', 'year'])
  const parsed = param ? Number.parseInt(param, 10) : Number.NaN
  return Number.isFinite(parsed) ? parsed : parseYear(car)
}

/** Накрывает ли диапазон выпуска модификации («2020-2027 SUV») этот год? */
function yearsCover(car: Record<string, unknown>, year: number): boolean {
  const range = (str(car, ['description']) ?? '').match(/\b((?:19|20)\d{2})\s*-\s*((?:19|20)\d{2})\b/)
  if (!range) return false
  return year >= Number.parseInt(range[1]!, 10) && year <= Number.parseInt(range[2]!, 10)
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
 *
 * В description год — только отдельным словом: там же лежат характеристики
 * мотора, и «Двигатель: 2000CC DOHC NA» у Subaru Forester 2021 года давал в
 * карточке «Год: 2000» (живьём 22.09.2026). Неверный год хуже пустого.
 */
function parseYear(car: Record<string, unknown>): number | null {
  const fromCriteria = (str(car, ['criteria']) ?? '').match(/\(((?:19|20)\d{2})/)
  if (fromCriteria) return Number.parseInt(fromCriteria[1]!, 10)
  const fromDescription = (str(car, ['description']) ?? '').match(/(?<![\p{L}\p{N}])(?:19|20)\d{2}(?![\p{L}\p{N}])/u)
  return fromDescription ? Number.parseInt(fromDescription[0], 10) : null
}

/** Выбранная модификация ответа /car/info → координаты каталога (для поиска). */
function carRefFromCarInfo(vinOrFrame: string, data: unknown): CarRef | null {
  const car = pickCar(vinOrFrame, data)
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
 *   2. Название близко к одному из имён детали в словаре (`queryNames`).
 *      Деталь без nameId приходит ОРИГИНАЛЬНЫМ названием каталога, и оно
 *      бывает русским: живьём у Citroen сама клапанная крышка лежит как
 *      «КРЫШКА ГОЛОВКИ ЦИЛИНДРОВ» без nameId, тогда как nameId есть у её
 *      ПРОКЛАДКИ — без этого признака мастер получал прокладку вместо крышки.
 *   3. Название содержит английский термин запроса — для каталогов, где
 *      оригинальные названия английские (у subaru `hasUniTree: false`, и
 *      передние колодки лежат как «PAD KIT-FRONT DISK BRAKE», nameId null).
 *
 * Порядок — по близости названия к запросу, при равенстве точное попадание в
 * дерево вперёд: мастер должен увидеть то, что спрашивал, первой строкой.
 * Записи без номера/названия и дубли (номер+название) пропускаются; общий
 * потолок — PARTSCATALOGS_MAX_PARTS.
 */
export function collectParts(
  data: unknown,
  ctx: {
    category: string
    /** Картинка схемы узла — общая для всех деталей этой группы. */
    imageUrl: string | null
    /** Идентификатор узла: по нему потом открывается вся схема по номерам. */
    schemeId?: string
    brand: string | null
    sidSet: Set<string>
    /** Английские термины запроса, см. `englishPartTerms`. */
    englishTerms: string[]
    /** Имена детали из словаря, см. `queryNames`. */
    names: Set<string>[]
    seen: Set<string>
    out: Part[]
  },
): void {
  if (!isRecord(data)) return

  const picked: { part: Part; score: number; exact: boolean; order: number }[] = []
  for (const group of asArray(data['partGroups']) ?? []) {
    for (const part of asArray(group['parts']) ?? []) {
      const oemNumber = str(part, ['number', 'id'])
      const name = str(part, ['name', 'notice'])
      if (!oemNumber || !name) continue

      const nameId = str(part, ['nameId'])
      const exact = nameId !== null && ctx.sidSet.has(nameId)
      const score = closeness(name, ctx.names)
      if (!exact && score < NAME_MATCH && !matchesTerms(name, ctx.englishTerms)) continue // сосед по узлу

      const key = `${oemNumber}|${name}`
      if (ctx.seen.has(key)) continue
      ctx.seen.add(key)

      const entry = {
        oemNumber,
        name,
        category: ctx.category,
        brand: ctx.brand,
        imageUrl: ctx.imageUrl,
        position: str(part, ['positionNumber']),
        schemeId: ctx.schemeId ?? null,
        ...partDetails({ name, notice: str(part, ['notice']), description: str(part, ['description']) }),
      }
      picked.push({ part: entry, score, exact, order: picked.length })
    }
  }

  picked.sort((a, b) => b.score - a.score || Number(b.exact) - Number(a.exact) || a.order - b.order)
  for (const { part } of picked) {
    if (ctx.out.length >= PARTSCATALOGS_MAX_PARTS) return
    ctx.out.push(part)
  }
}

/**
 * Чем деталь отличается от соседей по той же позиции узла.
 *
 * Название исполнения не различает: у Ford Mondeo под позицией 10655 пять АКБ,
 * и все пять — «Батарея аккумуляторная». Ёмкость и пусковой ток, сторона фары,
 * код модели и даты выпуска лежат в `description` (иногда в `notice`), а без
 * них мастер выбирает вслепую — ровно то, за чем он уходит в чужой каталог.
 *
 * Формат `description` у каталогов разный (живьём, сент 2026):
 *   • строки «Ключ: значение» — Ford, Subaru, Hyundai, Citroen, Mercedes; у Ford
 *     «Описание» продолжается следующими строками без ключа;
 *   • таблица «[Наименование] [Прим.] [К-во]» — VW/Skoda.
 * Даты выпуска и количество уходят в свои поля, остальное — в примечание.
 * `notice` берётся, только если описание примечания не дало и notice не
 * повторяет название: у Ford он — урезанная копия описания (без ёмкости у
 * одного из АКБ), у Mercedes — то же название строчными.
 */
export function partDetails(part: {
  name: string
  notice: string | null
  description: string | null
}): Pick<Part, 'note' | 'appliesPeriod' | 'quantity'> {
  const parsed = part.description
    ? /^\s*\[/.test(part.description)
      ? parseTableDescription(part.description)
      : parseKeyedDescription(part.description)
    : { notes: [], from: null, to: null, quantity: null }

  const name = part.name.trim().toLowerCase()
  const notes = parsed.notes.filter((item) => item.toLowerCase() !== name)
  const notice = part.notice?.trim() ?? ''
  if (notes.length === 0 && notice && notice.toLowerCase() !== name) notes.push(notice)

  return {
    note: notes.length > 0 ? notes.join('; ') : null,
    appliesPeriod: formatDayPeriod(parsed.from, parsed.to),
    quantity: parsed.quantity,
  }
}

type ParsedDescription = {
  notes: string[]
  from: string | null
  to: string | null
  quantity: number | null
}

/** «Ключ: значение» построчно; строка без ключа продолжает предыдущий. */
function parseKeyedDescription(description: string): ParsedDescription {
  const entries: { key: string; values: string[] }[] = []
  for (const raw of description.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const keyed = line.match(/^([\p{L}][^:]{0,40}|):\s*(.*)$/u)
    if (keyed) entries.push({ key: keyed[1]!.trim(), values: keyed[2] ? [keyed[2].trim()] : [] })
    else entries.at(-1)?.values.push(line)
  }

  const out: ParsedDescription = { notes: [], from: null, to: null, quantity: null }
  const described: string[] = []
  for (const { key, values } of entries) {
    const value = values.join(' ').trim()
    if (!key) continue // у Ford «: 1» без подписи — не угадываем, что это
    if (/^дата производства/i.test(key)) {
      const [from, to] = value.split(/\s+-\s*|\s*-\s+/)
      out.from = parseDay(from)
      out.to = parseDay(to)
    } else if (/^диапазон от/i.test(key)) {
      out.from = parseDay(value)
    } else if (/^диапазон до/i.test(key)) {
      out.to = parseDay(value)
    } else if (/^кол-?во|^количество|^qty|^quantity/i.test(key)) {
      out.quantity = positiveInt(value)
    } else if (/^описание/i.test(key)) {
      described.push(...values)
    } else if (value) {
      out.notes.push(`${key}: ${value}`)
    }
  }
  // Описание — суть исполнения, служебные коды (инженерный номер) — после него.
  out.notes = [...described, ...out.notes]
  return out
}

/** Таблица VW/Skoda: строка шапки, затем строки «текст … количество». */
function parseTableDescription(description: string): ParsedDescription {
  const out: ParsedDescription = { notes: [], from: null, to: null, quantity: null }
  const rows = description.split('\n').slice(1)
  for (const raw of rows) {
    let row = raw.replace(/\s+/g, ' ').trim()
    if (!row) continue
    const counted = row.match(/^(.*\S)\s+(\d+)$/)
    if (counted && out.quantity === null) {
      row = counted[1]!
      out.quantity = positiveInt(counted[2]!)
    }
    out.notes.push(row)
  }
  return out
}

/** «29/09/2014», «20200201», «2007-12-31» → «29.09.2014». */
function parseDay(value: string | undefined): string | null {
  const text = value?.trim() ?? ''
  let match = text.match(/^(\d{2})\/(\d{2})\/((?:19|20)\d{2})$/)
  if (match) return `${match[1]}.${match[2]}.${match[3]}`
  match = text.match(/^((?:19|20)\d{2})-?(\d{2})-?(\d{2})$/)
  if (match) return `${match[3]}.${match[2]}.${match[1]}`
  return null
}

/** Тот же вид периода, что у 17vin (`formatPeriod`), только с точностью до дня. */
function formatDayPeriod(from: string | null, to: string | null): string | null {
  if (from && to) return `${from} — ${to}`
  if (from) return `с ${from}`
  if (to) return `до ${to}`
  return null
}

function positiveInt(value: string): number | null {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : null
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
 * Названия дальше NODE_MATCH выбрасываются: узел не о том, что спрашивали.
 * Живьём на Chery подсказка на «тормозные» отдавала единственный «Насос
 * вакуумный тормозной системы», и мастер получал насос вместо честного «не
 * найдено» — пустой результат честнее чужой детали. Сверка идёт по ряду
 * ВМЕСТЕ с английскими терминами: у каталогов без русского универсального
 * дерева справочник английский, и по одному русскому ряду пустым оказался бы
 * весь список. Порядок каталога сохраняется внутри равных — сортировка
 * стабильная.
 */
export function rankSuggestions(suggestions: Suggestion[], query: string): string[] {
  const names = queryNamesForOrder(query)
  const ranked = suggestions.map((suggestion, order) => ({
    sid: suggestion.sid,
    order,
    score: closeness(suggestion.name, names),
  }))

  // Порог применяется, только когда мы вообще понимаем язык справочника: хоть
  // одно название отозвалось на слова запроса. Сплошные нули значат, что
  // справочник говорит словами, которых в словаре нет, — там порог отрезал бы
  // весь поиск, и лучше довериться порядку каталога, как было раньше.
  const understood = ranked.some((item) => item.score > 0)
  return ranked
    .filter((item) => !understood || item.score >= NODE_MATCH)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_PART_NAMES)
    .map((item) => item.sid)
}

/**
 * Варианты запроса для groups-suggest: исходный, затем без уточнений позиции
 * в конце («колодки тормозные передние» → «колодки тормозные»). Подсказка ищет
 * по названиям деталей, где позиции обычно нет.
 *
 * Отрезаются ТОЛЬКО слова позиции. Прежде отрезалось любое последнее слово, и
 * вместе с позицией уходила суть запроса: «ремень грм» становился «ремнём», и
 * мастер получал ремень безопасности (Mercedes) или приводной (Citroen, Skoda,
 * Ford, Chery) — живьём 22.09.2026; «стойка стабилизатора» — любой «стойкой».
 */
export function shortenQuery(query: string): string[] {
  const words = query.split(/\s+/).filter(Boolean)
  const out = [words.join(' ')]
  while (words.length > 1 && isPositionWord(words[words.length - 1]!)) {
    words.pop()
    out.push(words.join(' '))
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
