import { createHash } from 'node:crypto'

import type { Offer } from '@web-app-demo/contracts'

import { classifyQuality, isOriginalBrand } from './brand-quality'
import { asArray, firstArray, int, isRecord, num, str } from './parse-utils'
import { requestProviderJson } from './provider-http'
import type { SupplierProvider } from './providers'

/**
 * Адаптер клиентского API платформы ABCP — предложения (цена/наличие/срок)
 * по OEM-номеру. Через него подключаются магазины на ABCP, в т.ч. 4mycar.ru.
 * Это слой 4 продукта: после подбора детали автосервис видит, у кого купить.
 * Подключается в `createCatalogProviders` по `ABCP_LOGIN`+`ABCP_PASSWORD`+
 * `ABCP_API_URL` (оборачивается CachingSupplierProvider, как и мок).
 *
 * Сверено с документацией ABCP (www.abcp.ru/wiki/API.ABCP.Client, авг 2026):
 *   • Хост клиентского API — индивидуальный для магазина: `idNNNN.public.api.abcp.ru`
 *     (выдаёт поддержка магазина вместе с API-доступом). Универсального
 *     дефолтного хоста нет, поэтому `ABCP_API_URL` обязателен.
 *   • Авторизация: `userlogin` + `userpsw = md5(пароль)` в query каждого запроса.
 *   • Поиск двухшаговый: `search/brands` (бренды, делающие номер) →
 *     `search/articles` (number+brand; brand ОБЯЗАТЕЛЕН, ответ включает аналоги).
 *   • `deliveryPeriod` — срок поставки В ЧАСАХ (нормализуем в дни).
 *   • `availability`: >0 — точное количество; -1/-2/-3 — «есть, количество
 *     скрыто» (+/++/+++); -10 — под заказ.
 *   • Признака оригинальности в ответе НЕТ — оригинал определяем по бренду
 *     через общий справочник `brand-quality.ts` (тиры Эконом/Оптимальный/Оригинал).
 */

/** Пути клиентского API ABCP (сверены с документацией). */
export const ABCP_ENDPOINTS = {
  searchBrands: '/search/brands',
  searchArticles: '/search/articles',
} as const

/**
 * Потолок брендов на один номер: каждый бренд — отдельный вызов search/articles.
 * Обычно номер делают 1–3 бренда; потолок защищает от всплеска запросов
 * на «грязных» номерах. Ответ по каждому бренду и так включает аналоги.
 */
export const ABCP_MAX_BRANDS = 5

export type AbcpConfig = {
  login: string
  password: string
  /** Хост клиентского API магазина, напр. https://idNNNN.public.api.abcp.ru (даёт поддержка магазина). */
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
    // Схема авторизации ABCP: userpsw = md5-хэш пароля пользователя.
    this.userpsw = createHash('md5').update(config.password).digest('hex')
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  // region в клиентском API ABCP не передаётся: склады/офисы привязаны
  // к аккаунту магазина (officeId), а не к региону запроса.
  async getOffers(oemNumber: string): Promise<Offer[]> {
    const normalized = oemNumber.trim()
    if (!normalized) return []

    // Шаг 1: бренды, делающие этот номер. Пусто — штатное «не найдено».
    const brandsData = await this.request(ABCP_ENDPOINTS.searchBrands, { number: normalized })
    if (brandsData === null) return []
    const brands = extractBrands(brandsData).slice(0, ABCP_MAX_BRANDS)
    if (brands.length === 0) return []

    // Шаг 2: предложения по каждому бренду (параллельно). Сбой любого вызова —
    // отказ провайдера (502 из requestProviderJson), не маскируем под «пусто».
    const responses = await Promise.all(
      brands.map((brand) =>
        this.request(ABCP_ENDPOINTS.searchArticles, { number: normalized, brand }),
      ),
    )

    // Выдачи по брендам пересекаются аналогами — дедуп по контентному id.
    const seen = new Set<string>()
    return responses
      .flatMap((data) => (data === null ? [] : mapOffers(normalized, data)))
      .filter((offer) => (seen.has(offer.id) ? false : (seen.add(offer.id), true)))
  }

  /** Один HTTP-вызов к ABCP (см. requestProviderJson: 404/пусто→null, сбой→502). */
  private request(path: string, query: Record<string, string>): Promise<unknown | null> {
    const params = new URLSearchParams({
      userlogin: this.login,
      userpsw: this.userpsw,
      ...query,
    })
    return requestProviderJson({
      provider: 'ABCP',
      url: `${this.baseUrl}${path}?${params.toString()}`,
      fetchImpl: this.fetchImpl,
    })
  }
}

/**
 * Ответ search/brands → список брендов без дублей (регистронезависимо).
 * Документированный формат — массив структур {brand, number, numberFix, …};
 * на всякий случай терпим и объект-карту {"0": {…}} (встречается у PHP-бэкендов).
 */
export function extractBrands(data: unknown): string[] {
  const list =
    asArray(data) ??
    firstArray(data, ['brands']) ??
    (isRecord(data) ? Object.values(data).filter(isRecord) : null)
  if (!list) return []

  const seen = new Set<string>()
  const brands: string[] = []
  for (const item of list) {
    const brand = str(item, ['brand'])
    if (!brand || seen.has(brand.toUpperCase())) continue
    seen.add(brand.toUpperCase())
    brands.push(brand)
  }
  return brands
}

/**
 * Ответ search/articles → список предложений. Записи без цены отбрасываются
 * (бесполезны). Цена конвертируется в копейки (контракт хранит деньги в
 * int-копейках), срок — из часов в дни (вверх: 30 часов = 2 дня).
 */
export function mapOffers(oemNumber: string, data: unknown): Offer[] {
  const list = asArray(data) ?? firstArray(data, ['articles', 'items', 'result'])
  if (!list) return []

  const normalized = oemNumber.trim().toUpperCase()

  const offers: (Offer | null)[] = list.map((item) => {
    const priceRub = num(item, ['price'])
    if (priceRub === null) return null // без цены предложение бесполезно для выдачи

    const brand = str(item, ['brand']) ?? 'Бренд не указан'
    const article = str(item, ['numberFix', 'number']) ?? normalized
    // availability: >0 — количество; -1/-2/-3 — «есть, скрыто»; -10 — под заказ; 0 — нет.
    const availability = int(item, ['availability']) ?? 0
    const inStock = availability > 0 || (availability < 0 && availability !== -10)
    // deliveryPeriod — В ЧАСАХ по документации ABCP; в контракте — дни.
    const deliveryHours = int(item, ['deliveryPeriod']) ?? 0
    const supplierName = str(item, ['supplierDescription', 'supplierCode']) ?? 'Поставщик ABCP'
    // Оригинальность в ответе ABCP не передаётся — определяем по бренду.
    const isOriginal = isOriginalBrand(brand)

    return {
      // Контентный id: детерминирован между поисками и схлопывает дубли
      // аналогов из выдач разных брендов. itemKey ABCP для этого не годится —
      // документация прямо говорит, что он не уникален.
      id: `ABCP-${offerFingerprint(brand, article, supplierName, priceRub, deliveryHours, availability)}`,
      oemNumber: normalized,
      brand,
      articleNumber: article,
      name: str(item, ['description']) ?? `${brand} ${article}`,
      price: { amount: Math.round(priceRub * 100), currency: 'RUB' },
      quality: isOriginal ? 'OEM' : classifyQuality(brand),
      isOriginal,
      inStock,
      quantityAvailable: availability > 0 ? availability : 0,
      deliveryDays: deliveryHours > 0 ? Math.ceil(deliveryHours / 24) : 0,
      supplierName,
    }
  })

  return offers.filter((offer): offer is Offer => offer !== null)
}

/** Короткий стабильный отпечаток содержимого предложения для id/дедупа. */
function offerFingerprint(...parts: (string | number)[]): string {
  return createHash('md5').update(parts.join('|').toUpperCase()).digest('hex').slice(0, 12)
}
