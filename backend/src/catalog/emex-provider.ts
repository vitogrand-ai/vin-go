import type { Offer } from '@web-app-demo/contracts'

import { classifyQuality, isOriginalBrand } from './brand-quality'
import { asArray, bool, firstArray, int, num, str } from './parse-utils'
import { requestProviderJson } from './provider-http'
import type { SupplierProvider } from './providers'

/**
 * Адаптер поставщика Emex (emex.ru) — второй источник предложений по OEM-номеру.
 * Вместе с ABCP стоит за `MergingSupplierProvider`: выдачи объединяются, СТО
 * сравнивает цены из нескольких источников, тиры выбираются из общего списка.
 * Подключается в `createCatalogProviders` по env-ключу `EMEX_API_KEY`.
 *
 * ⚠️ ВАЖНО — СКЕЛЕТ ПОД ДОСТУП. Пути (`EMEX_ENDPOINTS`), авторизация (заголовок
 * в `request`; у Emex может быть логин/пароль или ключ в query) и имена полей
 * ответа (`mapOffers`) — ПРЕДПОЛОЖЕНИЕ, сверить с документацией B2B API Emex.
 * Всё собрано здесь; остальной код не трогается. Berg/Армтек — копия этого файла.
 */

/** Базовый URL API. ⚠️ Сверить хост/версию; переопределяется `EMEX_BASE_URL`. */
export const EMEX_DEFAULT_BASE_URL = 'https://api.emex.ru'

/** Пути эндпоинтов. ⚠️ ПРЕДПОЛОЖЕНИЕ — сверить с документацией Emex. */
export const EMEX_ENDPOINTS = {
  search: '/v1/search',
} as const

export type EmexConfig = {
  apiKey: string
  baseUrl: string
  /** Инъекция fetch — для тестов; по умолчанию глобальный fetch. */
  fetchImpl?: typeof fetch
}

export class EmexSupplierProvider implements SupplierProvider {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(config: EmexConfig) {
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  async getOffers(oemNumber: string, region?: string): Promise<Offer[]> {
    const normalized = oemNumber.trim()
    if (!normalized) return []

    const params = new URLSearchParams({ number: normalized })
    // ⚠️ Маппинг региона на параметр Emex (город/склад доставки) — предположение.
    if (region) params.set('region', region)

    const data = await this.request(`${EMEX_ENDPOINTS.search}?${params.toString()}`)
    // Нет предложений — штатный пустой результат, а не ошибка.
    if (data === null) return []
    return mapOffers(normalized, data)
  }

  /** Один HTTP-вызов к Emex (см. requestProviderJson: 404/пусто→null, сбой→502). */
  private request(path: string): Promise<unknown | null> {
    return requestProviderJson({
      provider: 'Emex',
      url: `${this.baseUrl}${path}`,
      fetchImpl: this.fetchImpl,
      // ⚠️ Схема авторизации — ПРЕДПОЛОЖЕНИЕ. Сверить с доками Emex.
      headers: { Authorization: `Bearer ${this.apiKey}` },
    })
  }
}

/**
 * Ответ Emex → список предложений. Записи без цены отбрасываются. Цена — в
 * копейки (контракт хранит деньги в int-копейках). Класс качества и оригинал —
 * из общего справочника брендов. ⚠️ Имена полей — предположение.
 */
export function mapOffers(oemNumber: string, data: unknown): Offer[] {
  const list = asArray(data) ?? firstArray(data, ['offers', 'items', 'result', 'searchResults'])
  if (!list) return []

  const normalized = oemNumber.trim().toUpperCase()

  const offers: (Offer | null)[] = list.map((item, index) => {
    const priceRub = num(item, ['price', 'priceRub', 'resultPrice'])
    if (priceRub === null) return null // без цены предложение бесполезно для выдачи

    const brand = str(item, ['brand', 'makeName', 'brandName']) ?? 'Бренд не указан'
    const article = str(item, ['number', 'detailNum', 'articleCode', 'code']) ?? normalized
    const quantity = int(item, ['quantity', 'availability', 'count']) ?? 0
    // ⚠️ Emex может отдавать срок в часах/датой — при сверке нормализовать в дни.
    const deliveryDays = int(item, ['deliveryDays', 'deliveryPeriod', 'delivery']) ?? 0
    // Стабильный id для резолва выбора корзиной (см. CachingSupplierProvider).
    const itemKey = str(item, ['id', 'offerId', 'key']) ?? `${article}-${brand}-${index}`
    // Оригинал: явный флаг поставщика, иначе — по бренду автопроизводителя.
    const originalFlag = bool(item, ['isOriginal', 'is_original', 'oe'])
    const isOriginal = originalFlag ?? isOriginalBrand(brand)

    return {
      id: `EMEX-${itemKey}`,
      oemNumber: normalized,
      brand,
      articleNumber: article,
      name: str(item, ['description', 'name', 'detailName']) ?? `${brand} ${article}`,
      price: { amount: Math.round(priceRub * 100), currency: 'RUB' },
      quality: isOriginal ? 'OEM' : classifyQuality(brand),
      isOriginal,
      inStock: quantity > 0,
      quantityAvailable: quantity > 0 ? quantity : 0,
      deliveryDays: deliveryDays > 0 ? deliveryDays : 0,
      supplierName: str(item, ['supplierName', 'warehouse', 'supplier']) ?? 'Emex',
    }
  })

  return offers.filter((offer): offer is Offer => offer !== null)
}
