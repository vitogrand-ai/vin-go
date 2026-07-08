import type { Part, Vehicle } from '@web-app-demo/contracts'

import { asArray, firstArray, firstRecord, int, isRecord, str } from './parse-utils'
import { requestProviderJson } from './provider-http'
import type { CatalogProvider } from './providers'

/**
 * Адаптер JDM-каталога (epcdata.ru / amayama) — японцы с правым рулём, серый
 * импорт. Ключевое отличие: такие авто идентифицируются FRAME-номером кузова
 * (например SXA10-0012345), а не 17-символьным VIN — контракт `vinOrFrameSchema`
 * пропускает оба формата, и в `decodeVin` сюда может прийти любой из них.
 * Третий источник в fallback-цепочке каталогов (после acat и PartsIndex):
 * по frame первые два отвечают «не найдено», и запрос доходит сюда.
 *
 * ⚠️ ВАЖНО — СКЕЛЕТ ПОД ДОГОВОРЁННОСТЬ. У epcdata.ru/amayama НЕТ публично
 * продаваемого API (в отличие от acat/PartsIndex/ABCP) — доступ обсуждается с
 * ними напрямую (партнёрка/B2B). Пути (`EPCDATA_ENDPOINTS`), авторизация и
 * имена полей ответа — ПРЕДПОЛОЖЕНИЕ под типовой JSON-API; если договоримся с
 * другим JDM-источником (japancats и т.п.) — меняется только этот файл.
 */

/** Базовый URL API. ⚠️ Сверить при получении доступа; переопределяется `EPCDATA_BASE_URL`. */
export const EPCDATA_DEFAULT_BASE_URL = 'https://api.epcdata.ru'

/** Пути эндпоинтов. ⚠️ ПРЕДПОЛОЖЕНИЕ — сверить при получении доступа. */
export const EPCDATA_ENDPOINTS = {
  decodeVin: '/v1/vehicle',
  searchParts: '/v1/parts',
} as const

export type EpcdataConfig = {
  apiKey: string
  baseUrl: string
  /** Инъекция fetch — для тестов; по умолчанию глобальный fetch. */
  fetchImpl?: typeof fetch
}

export class EpcdataCatalogProvider implements CatalogProvider {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(config: EpcdataConfig) {
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  async decodeVin(vinOrFrame: string): Promise<Vehicle | null> {
    // Каталог ищет и по frame, и по VIN — параметр разводим по формату
    // (17 сплошных символов = VIN, с дефисом = frame). ⚠️ Имя параметра — сверить.
    const key = vinOrFrame.includes('-') ? 'frame' : 'vin'
    const params = new URLSearchParams({ [key]: vinOrFrame })
    const data = await this.request(`${EPCDATA_ENDPOINTS.decodeVin}?${params.toString()}`)
    if (data === null) return null
    return mapVehicle(vinOrFrame, data)
  }

  async searchParts(vehicle: Vehicle, query: string): Promise<Part[]> {
    const key = vehicle.vin.includes('-') ? 'frame' : 'vin'
    const params = new URLSearchParams({ [key]: vehicle.vin, q: query })
    const data = await this.request(`${EPCDATA_ENDPOINTS.searchParts}?${params.toString()}`)
    if (data === null) return []
    return mapParts(data)
  }

  /** Один HTTP-вызов к epcdata (см. requestProviderJson: 404/пусто→null, сбой→502). */
  private request(path: string): Promise<unknown | null> {
    return requestProviderJson({
      provider: 'epcdata',
      url: `${this.baseUrl}${path}`,
      fetchImpl: this.fetchImpl,
      // ⚠️ Схема авторизации — ПРЕДПОЛОЖЕНИЕ. Сверить при получении доступа.
      headers: { Authorization: `Bearer ${this.apiKey}` },
    })
  }
}

/**
 * Ответ epcdata → карточка авто. Идентификатором остаётся исходный VIN/frame.
 * Возвращает null, если марку/модель определить не удалось. ⚠️ Имена полей —
 * предположение.
 */
export function mapVehicle(vinOrFrame: string, data: unknown): Vehicle | null {
  if (!isRecord(data)) return null
  const v = firstRecord(data, ['vehicle', 'car', 'auto']) ?? data

  const make = str(v, ['make', 'brand', 'manufacturer'])
  const model = str(v, ['model', 'modelName', 'modelTitle'])
  if (!make && !model) return null

  return {
    vin: vinOrFrame,
    make: make ?? 'Не определено',
    model: model ?? 'Не определено',
    year: int(v, ['year', 'modelYear', 'productionYear']) ?? 0,
    engine: str(v, ['engine', 'engineCode', 'motor']),
    bodyType: str(v, ['bodyType', 'body', 'kuzov']),
    raw: v,
  }
}

/** Ответ epcdata → список запчастей. Пропускает записи без OEM-номера или названия. */
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
