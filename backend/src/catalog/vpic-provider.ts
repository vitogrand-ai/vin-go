import type { Part, Vehicle } from '@web-app-demo/contracts'

import { isRecord } from './parse-utils'
import { requestProviderJson } from './provider-http'
import type { CatalogProvider } from './providers'

/**
 * Бесплатный государственный декодер VIN — NHTSA vPIC (vpic.nhtsa.dot.gov).
 * Единственный легальный источник без ключа и договора: API открытое, лимитов
 * и регистрации нет. Но это ТОЛЬКО расшифровка VIN: деталей, номеров и схем у
 * vPIC не бывает, поэтому в цепочке каталогов адаптер стоит последним и с
 * пометкой `decodeOnly` — мастер хотя бы увидит карточку машины и кнопку
 * «Спросить эксперта» вместо «автомобиль не найден».
 *
 * Чему верить нельзя: vPIC расшифровывает по правилам рынка США. Европейские
 * VIN он «декодирует» уверенно и неверно (живой случай — Mercedes W177 2019
 * года, которому vPIC ставит 2001-й: в европейском VIN год не закодирован).
 * Поэтому адаптер сам отсекает не-американские номера ДО запроса — по
 * контрольной цифре (9-я позиция VIN): она обязательна в США/Канаде (49 CFR
 * 565) и почти никогда не сходится у номеров других рынков. Не сошлась —
 * честный null без сетевого вызова.
 */

/** Базовый URL API vPIC; переопределяется `VPIC_BASE_URL` (тесты, прокси). */
export const VPIC_DEFAULT_BASE_URL = 'https://vpic.nhtsa.dot.gov/api'

export type VpicConfig = {
  baseUrl: string
  /** Инъекция fetch — для тестов; по умолчанию глобальный fetch. */
  fetchImpl?: typeof fetch
}

export class VpicCatalogProvider implements CatalogProvider {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(config: VpicConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  async decodeVin(vinOrFrame: string): Promise<Vehicle | null> {
    const vin = vinOrFrame.trim().toUpperCase()
    // Frame-номера и VIN других рынков vPIC знать не может — не тратим вызов.
    if (!hasValidCheckDigit(vin)) return null

    // Плоский формат DecodeVinValues: один объект со всеми полями строками.
    const data = await requestProviderJson({
      provider: 'vpic',
      url: `${this.baseUrl}/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`,
      fetchImpl: this.fetchImpl,
    })
    if (data === null) return null
    return mapVehicle(vinOrFrame, data)
  }

  /** vPIC — декодер, а не каталог: деталей у него нет и не будет. */
  async searchParts(): Promise<Part[]> {
    return []
  }
}

/**
 * Транслитерация букв VIN для контрольной суммы (49 CFR 565.15): I, O, Q в VIN
 * не встречаются, остальные буквы получают вес 1-9.
 */
const CHECK_VALUES: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
}

/** Весовые коэффициенты позиций 1-17; девятая позиция — сама контрольная цифра. */
const CHECK_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2]

/**
 * Сходится ли контрольная цифра VIN (9-я позиция) по правилу рынка США.
 * Экспортирована ради тестов и как общий фильтр «американский ли VIN».
 */
export function hasValidCheckDigit(vin: string): boolean {
  if (vin.length !== 17) return false

  let sum = 0
  for (let i = 0; i < 17; i++) {
    const char = vin[i]!
    const value = /[0-9]/.test(char) ? Number(char) : CHECK_VALUES[char]
    if (value === undefined) return false
    sum += value * CHECK_WEIGHTS[i]!
  }

  const remainder = sum % 11
  const expected = remainder === 10 ? 'X' : String(remainder)
  return vin[8] === expected
}

/**
 * Ответ vPIC → карточка авто. Плоский формат: `Results[0]` — объект, где все
 * значения строки, пустые поля — пустые строки. Без марки или модели vPIC
 * машину не опознал (расшифровался только WMI) — это честный null.
 */
export function mapVehicle(vinOrFrame: string, data: unknown): Vehicle | null {
  if (!isRecord(data) || !Array.isArray(data.Results)) return null
  const v = data.Results[0]
  if (!isRecord(v)) return null

  const make = text(v, 'Make')
  const model = text(v, 'Model')
  if (!make || !model) return null

  const year = Number(text(v, 'ModelYear'))
  const displacement = text(v, 'DisplacementL')
  const engine =
    text(v, 'EngineModel') ?? (displacement ? `${trimZeros(displacement)} л` : null)

  return {
    vin: vinOrFrame,
    make: titleCase(make),
    model,
    year: Number.isInteger(year) && year > 1900 ? year : null,
    engine,
    bodyType: text(v, 'BodyClass'),
    raw: v,
  }
}

/** Строковое поле vPIC: пустая строка и "Not Applicable" значат «нет данных». */
function text(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' || /^not applicable$/i.test(trimmed) ? null : trimmed
}

/** vPIC пишет марки капсом ("TOYOTA") — в карточке приятнее "Toyota". */
function titleCase(value: string): string {
  return value.replace(
    /[A-ZА-ЯЁ]{2,}/g,
    (word) => word[0]! + word.slice(1).toLowerCase(),
  )
}

/** "2.50" → "2.5", "3.00" → "3". */
function trimZeros(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
}
