import { createHash } from 'node:crypto'

import type { Offer } from '@web-app-demo/contracts'

import { classifyQuality, isOriginalBrand } from './brand-quality'
import { asArray, bool, firstArray, int, num, str } from './parse-utils'
import { requestProviderJson } from './provider-http'
import type { SupplierProvider } from './providers'

/**
 * Адаптер слоя поставщиков ABCP — предложения (цена/наличие/срок) по OEM-номеру.
 * Это слой 4 продукта: после подбора детали автосервис видит, у кого купить.
 * Подключается в `createCatalogProviders` по `ABCP_LOGIN`+`ABCP_PASSWORD`
 * (оборачивается CachingSupplierProvider, как и мок).
 *
 * ⚠️ ВАЖНО — СКЕЛЕТ ПОД ДОСТУП. Зависящее от реального API ABCP собрано в трёх
 * местах и требует сверки с документацией при получении логина/пароля:
 *   1) пути/хост (`ABCP_ENDPOINTS`, `ABCP_DEFAULT_BASE_URL`);
 *   2) авторизация (`userlogin` + `userpsw = md5(password)` в query — схема ABCP);
 *   3) имена полей ответа (`mapOffers`).
 *
 * Класс качества/оригинальность берутся из общего справочника `brand-quality.ts`
 * (тиры Эконом/Оптимальный/Оригинал). Ещё один узел под сверку:
 *   • ABCP-поиск часто двухшаговый: `/search/brands` (бренды по номеру) →
 *     `/search/articles` (number+brand). Если аккаунт возвращает пусто без
 *     brand — здесь нужно добавить шаг brands. Сейчас — одиночный запрос.
 */

/** Базовый URL API. ⚠️ У ABCP API обычно на домене магазина — сверить/переопределить `ABCP_API_URL`. */
export const ABCP_DEFAULT_BASE_URL = 'https://api.abcp.ru'

/** Пути эндпоинтов. ⚠️ ПРЕДПОЛОЖЕНИЕ — сверить с документацией ABCP. */
export const ABCP_ENDPOINTS = {
  searchArticles: '/search/articles',
} as const

export type AbcpConfig = {
  login: string
  password: string
  baseUrl: string
  /** Инъекция fetch — для тестов; по умолчанию глобальный fetch. */
  fetchImpl?: typeof fetch
}

export class AbcpSupplierProvider implements SupplierProvider {
  private readonly login: string
  private readonly userpsw: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(config: AbcpConfig) {
    this.login = config.login
    // ⚠️ ABCP ожидает userpsw = md5(пароль). Сверить со своей версией API.
    this.userpsw = createHash('md5').update(config.password).digest('hex')
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  async getOffers(oemNumber: string, region?: string): Promise<Offer[]> {
    const normalized = oemNumber.trim()
    if (!normalized) return []

    const params = new URLSearchParams({
      userlogin: this.login,
      userpsw: this.userpsw,
      number: normalized,
    })
    // ⚠️ Маппинг региона на параметр ABCP — предположение (склад/доставка). Сверить.
    if (region) params.set('locale', region)

    const data = await this.request(`${ABCP_ENDPOINTS.searchArticles}?${params.toString()}`)
    // Нет предложений — это штатный пустой результат, а не ошибка.
    if (data === null) return []
    return mapOffers(normalized, data)
  }

  /** Один HTTP-вызов к ABCP (см. requestProviderJson: 404/пусто→null, сбой→502). */
  private request(path: string): Promise<unknown | null> {
    return requestProviderJson({
      provider: 'ABCP',
      url: `${this.baseUrl}${path}`,
      fetchImpl: this.fetchImpl,
    })
  }
}

/**
 * Ответ ABCP → список предложений. Записи без цены отбрасываются (бесполезны).
 * Цена конвертируется в копейки (контракт хранит деньги в int-копейках).
 * ⚠️ Имена полей — предположение, сверить с реальным ответом ABCP.
 */
export function mapOffers(oemNumber: string, data: unknown): Offer[] {
  const list = asArray(data) ?? firstArray(data, ['articles', 'items', 'result'])
  if (!list) return []

  const normalized = oemNumber.trim().toUpperCase()

  const offers: (Offer | null)[] = list.map((item, index) => {
    const priceRub = num(item, ['price', 'priceRub'])
    if (priceRub === null) return null // без цены предложение бесполезно для выдачи

    const brand = str(item, ['brand', 'brandName']) ?? 'Бренд не указан'
    const article = str(item, ['number', 'numberFix', 'articleCode', 'code']) ?? normalized
    const quantity = int(item, ['availability', 'quantity', 'inStock']) ?? 0
    // ⚠️ ABCP может отдавать срок в часах/периоде — при сверке нормализовать в дни.
    const deliveryDays = int(item, ['deliveryPeriod', 'deliveryDays', 'delivery']) ?? 0
    // Стабильный id для резолва выбора корзиной (см. CachingSupplierProvider).
    const itemKey = str(item, ['itemKey', 'id']) ?? `${article}-${brand}-${index}`
    // Оригинал: явный флаг поставщика, иначе — по бренду автопроизводителя.
    const originalFlag = bool(item, ['isOriginal', 'is_original', 'oe'])
    const isOriginal = originalFlag ?? isOriginalBrand(brand)

    return {
      id: `ABCP-${itemKey}`,
      oemNumber: normalized,
      brand,
      articleNumber: article,
      name: str(item, ['description', 'name']) ?? `${brand} ${article}`,
      price: { amount: Math.round(priceRub * 100), currency: 'RUB' },
      quality: isOriginal ? 'OEM' : classifyQuality(brand),
      isOriginal,
      inStock: quantity > 0,
      quantityAvailable: quantity > 0 ? quantity : 0,
      deliveryDays: deliveryDays > 0 ? deliveryDays : 0,
      supplierName:
        str(item, ['supplierDescription', 'distributorName', 'supplier', 'supplierCode']) ??
        'Поставщик ABCP',
    }
  })

  return offers.filter((offer): offer is Offer => offer !== null)
}
