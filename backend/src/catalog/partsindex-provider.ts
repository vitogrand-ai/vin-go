import type { Part, Vehicle } from '@web-app-demo/contracts'

import { asArray, firstArray, firstRecord, int, isRecord, str } from './parse-utils'
import { requestProviderJson } from './provider-http'
import type { CatalogProvider } from './providers'

/**
 * Адаптер каталога PartsIndex (parts-index.ru) — поиск по VIN/марке, включает
 * свежих китайцев (Chery, Changan, Exeed, Haval, Omoda) и коммерческий транспорт.
 * Второй OEM-источник в связке: acat как широкий primary, PartsIndex добивает
 * пробел «китайцы/новые модели». Оба стоят за `FallbackCatalogProvider` в
 * `createCatalogProviders` и включаются каждый своим ключом (`PARTSINDEX_API_KEY`).
 *
 * ⚠️ ВАЖНО — СКЕЛЕТ ПОД ДОСТУП. Пути (`PARTSINDEX_ENDPOINTS`), авторизация
 * (заголовок в `request`) и имена полей ответа (мапперы `mapVehicle`/`mapParts`)
 * — ПРЕДПОЛОЖЕНИЕ, сверить с документацией PartsIndex по ключу. Всё это собрано
 * здесь; остальной код (сервис, роуты, веб, бот) не трогается.
 *
 * Мапперы читают поля защитно (несколько возможных имён), поэтому небольшое
 * расхождение формата не роняет ответ.
 */

/** Базовый URL API. ⚠️ Сверить хост/версию; переопределяется `PARTSINDEX_BASE_URL`. */
export const PARTSINDEX_DEFAULT_BASE_URL = 'https://api.parts-index.ru'

/** Пути эндпоинтов. ⚠️ ПРЕДПОЛОЖЕНИЕ — сверить с документацией PartsIndex. */
export const PARTSINDEX_ENDPOINTS = {
  decodeVin: '/v1/vehicle',
  searchParts: '/v1/parts',
} as const

export type PartsIndexConfig = {
  apiKey: string
  baseUrl: string
  /** Инъекция fetch — для тестов; по умолчанию глобальный fetch. */
  fetchImpl?: typeof fetch
}

export class PartsIndexCatalogProvider implements CatalogProvider {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(config: PartsIndexConfig) {
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  async decodeVin(vin: string): Promise<Vehicle | null> {
    const params = new URLSearchParams({ vin })
    const data = await this.request(`${PARTSINDEX_ENDPOINTS.decodeVin}?${params.toString()}`)
    if (data === null) return null
    return mapVehicle(vin, data)
  }

  async searchParts(vehicle: Vehicle, query: string): Promise<Part[]> {
    const params = new URLSearchParams({ vin: vehicle.vin, q: query })
    const data = await this.request(`${PARTSINDEX_ENDPOINTS.searchParts}?${params.toString()}`)
    if (data === null) return []
    return mapParts(data)
  }

  /** Один HTTP-вызов к PartsIndex (см. requestProviderJson: 404/пусто→null, сбой→502). */
  private request(path: string): Promise<unknown | null> {
    return requestProviderJson({
      provider: 'PartsIndex',
      url: `${this.baseUrl}${path}`,
      fetchImpl: this.fetchImpl,
      // ⚠️ Схема авторизации — ПРЕДПОЛОЖЕНИЕ. Сверить с доками PartsIndex.
      headers: { Authorization: `Bearer ${this.apiKey}` },
    })
  }
}

/**
 * Ответ PartsIndex → карточка авто. Возвращает null, если марку/модель определить
 * не удалось (трактуем как «VIN не опознан»). ⚠️ Имена полей — предположение.
 */
export function mapVehicle(vin: string, data: unknown): Vehicle | null {
  if (!isRecord(data)) return null
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

/** Ответ PartsIndex → список запчастей. Пропускает записи без OEM-номера или названия. */
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
