import type { Part, Vehicle } from '@web-app-demo/contracts'

import { asArray, firstArray, firstRecord, int, isRecord, str } from './parse-utils'
import { requestProviderJson } from './provider-http'
import type { CatalogProvider } from './providers'

/**
 * Адаптер каталога acat.online — 400+ марок, поиск по VIN/Frame (кратно шире
 * Laximo). Кандидат в основной OEM-источник; закрывает пробел «не находит авто
 * по VIN» на китайцах/свежих моделях. Подключается в `createCatalogProviders`
 * по env-ключу `ACAT_API_KEY` (тот же паттерн, что боевой ЮKassa).
 *
 * ⚠️ ВАЖНО — СКЕЛЕТ ПОД ДЕМО-КЛЮЧ. Точные пути эндпоинтов (`ACAT_ENDPOINTS`),
 * схема авторизации (заголовок в `request`) и имена полей ответа (мапперы
 * `mapVehicle`/`mapParts`) — это ПРЕДПОЛОЖЕНИЕ. Их нужно сверить с документацией
 * acat.online при получении демо-доступа. Всё, что зависит от их формата,
 * специально собрано в этих трёх местах — при подключении ключа правится только
 * оно, остальной код (сервис, роуты, веб, бот) не трогается.
 *
 * Мапперы читают поля защитно (несколько возможных имён, отсутствующие поля
 * терпимы), чтобы небольшое расхождение формата не роняло весь ответ.
 */

/** Базовый URL API. ⚠️ Сверить хост/версию с доками acat; переопределяется `ACAT_BASE_URL`. */
export const ACAT_DEFAULT_BASE_URL = 'https://api.acat.online'

/** Пути эндпоинтов. ⚠️ ПРЕДПОЛОЖЕНИЕ — сверить с документацией acat по демо-ключу. */
export const ACAT_ENDPOINTS = {
  decodeVin: '/v1/vehicle',
  searchParts: '/v1/parts',
} as const

export type AcatConfig = {
  apiKey: string
  baseUrl: string
  /** Инъекция fetch — для тестов; по умолчанию глобальный fetch. */
  fetchImpl?: typeof fetch
}

export class AcatCatalogProvider implements CatalogProvider {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(config: AcatConfig) {
    this.apiKey = config.apiKey
    // Убираем хвостовой слэш, чтобы не получить двойной при склейке с путём.
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  async decodeVin(vin: string): Promise<Vehicle | null> {
    const params = new URLSearchParams({ vin })
    const data = await this.request(`${ACAT_ENDPOINTS.decodeVin}?${params.toString()}`)
    // request вернул null → каталог не знает такой VIN (HTTP 404 / пустой ответ).
    if (data === null) return null
    return mapVehicle(vin, data)
  }

  async searchParts(vehicle: Vehicle, query: string): Promise<Part[]> {
    // ⚠️ Реальному acat для поиска, вероятно, нужен идентификатор каталога/узла
    // из шага decodeVin (лежит в vehicle.raw). Сверить требуемые параметры по докам.
    const params = new URLSearchParams({ vin: vehicle.vin, q: query })
    const data = await this.request(`${ACAT_ENDPOINTS.searchParts}?${params.toString()}`)
    if (data === null) return []
    return mapParts(data)
  }

  /** Один HTTP-вызов к acat (см. requestProviderJson: 404/пусто→null, сбой→502). */
  private request(path: string): Promise<unknown | null> {
    return requestProviderJson({
      provider: 'acat.online',
      url: `${this.baseUrl}${path}`,
      fetchImpl: this.fetchImpl,
      // ⚠️ Схема авторизации — ПРЕДПОЛОЖЕНИЕ. У acat это может быть X-Api-Key
      // или query-параметр. Сверить с доками при получении демо-ключа.
      headers: { Authorization: `Bearer ${this.apiKey}` },
    })
  }
}

/**
 * Ответ acat → карточка авто. Возвращает null, если марку/модель определить не
 * удалось (трактуем как «VIN не опознан»). ⚠️ Имена полей — предположение.
 */
export function mapVehicle(vin: string, data: unknown): Vehicle | null {
  if (!isRecord(data)) return null
  // Авто может лежать в корне или во вложенном поле — берём гибко.
  const v = firstRecord(data, ['vehicle', 'car', 'auto']) ?? data

  const make = str(v, ['make', 'brand', 'manufacturer'])
  const model = str(v, ['model', 'modelName', 'modelTitle'])
  if (!make && !model) return null

  return {
    vin,
    make: make ?? 'Не определено',
    model: model ?? 'Не определено',
    year: int(v, ['year', 'modelYear', 'productionYear']),
    engine: str(v, ['engine', 'engineCode', 'motor']),
    bodyType: str(v, ['bodyType', 'body', 'kuzov']),
    raw: v,
  }
}

/** Ответ acat → список запчастей. Пропускает записи без OEM-номера или названия. */
export function mapParts(data: unknown): Part[] {
  const list = asArray(data) ?? firstArray(data, ['parts', 'items', 'details', 'results'])
  if (!list) return []

  return list
    .map((p) => ({
      oemNumber: str(p, ['oemNumber', 'oem', 'number', 'partNumber']) ?? '',
      name: str(p, ['name', 'title', 'partName']) ?? '',
      category: str(p, ['category', 'group', 'unit']) ?? '',
      brand: str(p, ['brand', 'manufacturer']),
    }))
    .filter((p) => p.oemNumber !== '' && p.name !== '')
}
