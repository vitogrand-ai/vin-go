import type {
  CatalogStatusResponse,
  DealerPrice,
  DecodeVinResponse,
  OffersResponse,
  ResolvePlateResponse,
  SearchPartsResponse,
} from '@web-app-demo/contracts'

import type { Part } from '@web-app-demo/contracts'

import { AppError } from '../http/errors'
import { MOCK_PROVIDERS_META, type CatalogProvidersMeta } from './factory'
import { MockCatalogProvider, MockPlateProvider, MockSupplierProvider } from './mock-providers'
import { expandPartQuery } from './part-jargon'
import { closeness, queryNamesForOrder } from './part-match'
import { filterByPosition } from './position-filter'
import type {
  CatalogProvider,
  DealerPriceProvider,
  PlateProvider,
  SupplierProvider,
} from './providers'
import { selectTiers } from './tiering'

/**
 * Сервис подбора: связывает провайдер каталога, провайдер поставщиков и
 * логику тиров. Провайдеры внедряются, поэтому переход с мока на реальные
 * API (Laximo, TecDoc, ABCP/Emex) не затрагивает маршруты и контракты.
 */
export class CatalogService {
  constructor(
    private readonly catalog: CatalogProvider,
    private readonly suppliers: SupplierProvider,
    private readonly plates: PlateProvider,
    /**
     * Что подключено. Ответы поиска и предложений несут отметку источника, чтобы
     * веб и бот показывали «демо-цены», когда поставщиков нет, — выдуманные
     * цены не должны выглядеть настоящими.
     */
    private readonly meta: CatalogProvidersMeta = MOCK_PROVIDERS_META,
    /** Цена оригинала у дилеров — ориентир рядом с предложениями, если источник есть. */
    private readonly dealerPrices?: DealerPriceProvider,
  ) {}

  /** Состояние источников данных: каталог, поставщики, реестр госномеров. */
  status(): CatalogStatusResponse {
    return {
      catalog: this.meta.catalog,
      suppliers: this.meta.suppliers,
      plates: this.meta.plates,
    }
  }

  async decodeVin(vin: string): Promise<DecodeVinResponse> {
    const vehicle = await this.catalog.decodeVin(vin)
    if (!vehicle) {
      throw new AppError(404, 'NOT_FOUND', 'Автомобиль по этому VIN не найден')
    }
    return { vehicle }
  }

  async resolvePlate(plate: string): Promise<ResolvePlateResponse> {
    const vin = await this.plates.resolvePlate(plate)
    if (!vin) {
      throw new AppError(404, 'NOT_FOUND', 'Автомобиль по этому госномеру не найден')
    }
    return this.decodeVin(vin)
  }

  /**
   * Поиск запчасти с пониманием жаргона мастера.
   *
   * Каталоги знают «ШРУС» и «Фильтр воздушный», а в чате пишут «гранатка» и
   * «воздухан» — прямой запрос возвращает пусто. Поэтому запрос разворачивается
   * в несколько вариантов (см. `expandPartQuery`) от самого чистого к исходному,
   * и берётся первый, который дал результат. Нормализация живёт здесь, а не в
   * провайдерах и не в боте, чтобы веб, Telegram и мобильное вели себя одинаково.
   */
  async searchParts(vin: string, query: string): Promise<SearchPartsResponse> {
    const { vehicle } = await this.decodeVin(vin)

    const variants = expandPartQuery(query)
    for (const variant of variants) {
      const found = await this.catalog.searchParts(vehicle, variant)
      if (found.length === 0) continue

      // Провайдеры отдают одну деталь несколькими строками применимости, а
      // нечёткий поиск теряет уточнение позиции — чистим выдачу здесь, чтобы
      // веб, бот и мобильное видели одно и то же. Фильтр по позиции идёт от
      // ИСХОДНОГО запроса: канонизация жаргона позицию не меняет.
      const parts = orderByRelevance(filterByPosition(dedupeByOem(found), query), query)
      if (parts.length === 0) continue

      // Подсказку отдаём, только если искали не тем, что ввёл пользователь.
      const resolvedQuery = variant.toLowerCase() === query.trim().toLowerCase() ? undefined : variant
      return { vehicle, parts, resolvedQuery, source: this.meta.catalog }
    }

    logSearchMiss(vehicle, query, variants, this.meta.catalog)
    return { vehicle, parts: [], source: this.meta.catalog }
  }

  /**
   * Детали узла по номеру на схеме.
   *
   * Мастер смотрит на картинку и называет номер выноски: на схеме фары «9» —
   * это жгут проводов освещения, названия которого он и не спросил бы. Отбора
   * по запросу здесь нет вовсе — номер уже и есть выбор детали; дубли одной
   * детали по применимости чистятся так же, как в обычной выдаче.
   */
  async schemeParts(vin: string, schemeId: string, position: string): Promise<SearchPartsResponse> {
    const { vehicle } = await this.decodeVin(vin)
    if (!this.catalog.schemeParts) return { vehicle, parts: [], source: this.meta.catalog }

    const all = await this.catalog.schemeParts(vehicle, schemeId)
    const wanted = position.trim()
    return {
      vehicle,
      parts: dedupeByOem(all.filter((part) => (part.position ?? '').trim() === wanted)),
      source: this.meta.catalog,
    }
  }

  async getOffers(oemNumber: string, region?: string): Promise<OffersResponse> {
    const [offers, dealerPrice] = await Promise.all([
      this.suppliers.getOffers(oemNumber, region),
      this.lookupDealerPrice(oemNumber),
    ])
    const sorted = [...offers].sort((a, b) => a.price.amount - b.price.amount)
    return {
      oemNumber: oemNumber.trim().toUpperCase(),
      picks: selectTiers(sorted),
      offers: sorted,
      source: this.meta.suppliers,
      dealerPrice,
    }
  }

  /**
   * Цена у дилера — справка, а не предложение: её сбой не должен оставлять
   * мастера без цен поставщиков. Поэтому ошибка источника глушится с логом.
   */
  private async lookupDealerPrice(oemNumber: string): Promise<DealerPrice | null> {
    if (!this.dealerPrices) return null
    try {
      return await this.dealerPrices.dealerPrice(oemNumber)
    } catch (error) {
      console.warn(`[catalog] цена у дилера для ${oemNumber} не получена`, error)
      return null
    }
  }
}

/**
 * Выдача в порядке близости названия к запросу — самое похожее первой строкой.
 *
 * Каталог кладёт деталь в узел вместе с соседями и отдаёт их в своём порядке:
 * на «крышку ГБЦ» у Lexus первыми приходили два БОЛТА крышки, а сама крышка
 * третьей — мастер жал первую кнопку и получал не ту деталь. Порядок наводится
 * здесь, а не в адаптере, потому что касается любого источника: у 17vin своей
 * сортировки нет вовсе.
 *
 * Сортировка стабильная: детали, одинаково отвечающие запросу, остаются в
 * порядке каталога — он осмысленный (позиции на схеме узла идут подряд).
 */
function orderByRelevance(parts: Part[], query: string): Part[] {
  const names = queryNamesForOrder(query)
  if (names.length === 0) return parts
  return parts
    .map((part, order) => ({ part, order, score: closeness(part.name, names) }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((ranked) => ranked.part)
}

/** Метка промаха в журнале — по ней собираются запросы для словаря. */
export const SEARCH_MISS_TAG = '[catalog:miss]'

/**
 * Запрос, по которому каталог не дал ничего, — в журнал.
 *
 * Это единственный источник, из которого словарь жаргона пополняется реальными
 * словами мастеров, а не догадками: как деталь называют на практике, видно
 * только по живым промахам. Пишется здесь, а не в боте, потому что промах
 * одинаково важен для веба, Telegram и мобильного.
 *
 * Одной строкой и с устойчивой меткой — чтобы на сервере собиралось грепом
 * (`journalctl -u vingo-bot | grep '[catalog:miss]'`). Печатаются и варианты
 * запроса: по ним видно, что именно ушло в каталог, — сам по себе исходный
 * текст не говорит, промахнулся словарь или каталог.
 */
function logSearchMiss(
  vehicle: SearchPartsResponse['vehicle'],
  query: string,
  variants: string[],
  source: CatalogProvidersMeta['catalog'],
): void {
  const car = [vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(' ')
  console.warn(
    `${SEARCH_MISS_TAG} ${vehicle.vin} ${car} | запрос: «${query.trim()}» | ` +
      `искали: ${variants.join(', ')} | каталог: ${source.names.join('+') || 'нет'}`,
  )
}

/**
 * Схлопывает дубли по OEM-номеру: номер идентифицирует деталь, а каталоги
 * присылают её по строке на каждую позицию применимости. Первое вхождение
 * задаёт название; схема, выноска и узел добираются из любого дубля, у
 * которого они есть, — иначе выбор детали цифрой со схемы зависел бы от того,
 * какая строка применимости пришла первой.
 */
function dedupeByOem(parts: Part[]): Part[] {
  const byOem = new Map<string, Part>()
  for (const part of parts) {
    const existing = byOem.get(part.oemNumber)
    if (!existing) {
      byOem.set(part.oemNumber, part)
      continue
    }
    // Подробности каталога могут лежать у любой строки применимости, а не
    // только у первой: берём первое непустое значение каждого поля.
    const merged: Part = {
      ...existing,
      imageUrl: existing.imageUrl ?? part.imageUrl ?? null,
      position: existing.position ?? part.position ?? null,
      schemeId: existing.schemeId ?? part.schemeId ?? null,
      schemeHotspot: existing.schemeHotspot ?? part.schemeHotspot ?? null,
      quantity: existing.quantity ?? part.quantity ?? null,
      replacedBy: existing.replacedBy ?? part.replacedBy ?? null,
      note: existing.note ?? part.note ?? null,
      appliesPeriod: existing.appliesPeriod ?? part.appliesPeriod ?? null,
    }
    byOem.set(part.oemNumber, merged)
  }
  return [...byOem.values()]
}

/** Сервис на мок-провайдерах (используется ботом и тестами). */
export function createMockCatalogService(): CatalogService {
  return new CatalogService(
    new MockCatalogProvider(),
    new MockSupplierProvider(),
    new MockPlateProvider(),
  )
}
