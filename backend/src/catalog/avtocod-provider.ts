import { firstRecord, isRecord, str } from './parse-utils'
import { requestProviderJson } from './provider-http'
import type { PlateProvider } from './providers'

/**
 * Адаптер реестра госномер → VIN (Avtocod / avtocod.ru — платные отчёты по авто;
 * бесплатного официального API в РФ нет). Закрывает последний мок в цепочке:
 * поиск по госномеру в вебе/боте/мобильном. Подключается в
 * `createCatalogProviders` по env-ключу `AVTOCOD_API_KEY`.
 *
 * ⚠️ ВАЖНО — СКЕЛЕТ ПОД ДОСТУП. Путь эндпоинта (`AVTOCOD_ENDPOINTS`), схема
 * авторизации (заголовок в `request`) и имена полей ответа (`mapVin`) —
 * ПРЕДПОЛОЖЕНИЕ, сверить с документацией Avtocod при получении ключа (у них
 * API отчётов асинхронный: заказ отчёта → готовность; если так — здесь
 * добавится опрос готовности, место помечено). Если выберем другой сервис
 * (АвтоИстория и т.п.) — меняется только этот файл.
 *
 * На вход приходит госномер, уже нормализованный контрактом `plateSchema`
 * (латиница→кириллица, верхний регистр).
 */

/** Базовый URL API. ⚠️ Сверить хост/версию; переопределяется `AVTOCOD_BASE_URL`. */
export const AVTOCOD_DEFAULT_BASE_URL = 'https://api.avtocod.ru'

/** Пути эндпоинтов. ⚠️ ПРЕДПОЛОЖЕНИЕ — сверить с документацией Avtocod. */
export const AVTOCOD_ENDPOINTS = {
  resolvePlate: '/v1/vehicle/grz',
} as const

export type AvtocodConfig = {
  apiKey: string
  baseUrl: string
  /** Инъекция fetch — для тестов; по умолчанию глобальный fetch. */
  fetchImpl?: typeof fetch
}

export class AvtocodPlateProvider implements PlateProvider {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(config: AvtocodConfig) {
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  async resolvePlate(plate: string): Promise<string | null> {
    const normalized = plate.trim().toUpperCase()
    if (!normalized) return null

    const params = new URLSearchParams({ grz: normalized })
    // ⚠️ Если API Avtocod асинхронный (заказ отчёта → опрос готовности),
    // сюда добавится второй шаг. Сейчас — одиночный запрос.
    const data = await this.request(`${AVTOCOD_ENDPOINTS.resolvePlate}?${params.toString()}`)
    // request вернул null → реестр не знает такой госномер (404 / пустой ответ).
    if (data === null) return null
    return mapVin(data)
  }

  /** Один HTTP-вызов к Avtocod (см. requestProviderJson: 404/пусто→null, сбой→502). */
  private request(path: string): Promise<unknown | null> {
    return requestProviderJson({
      provider: 'Avtocod',
      url: `${this.baseUrl}${path}`,
      fetchImpl: this.fetchImpl,
      // ⚠️ Схема авторизации — ПРЕДПОЛОЖЕНИЕ. Сверить с доками Avtocod.
      headers: { Authorization: `Bearer ${this.apiKey}` },
    })
  }
}

/**
 * VIN нередко приходит как frame-номер (JDM, правый руль) — каталоги умеют
 * искать и по нему, поэтому длину не зажимаем до 17. Но совсем короткие
 * значения — мусор, не скармливаем их каталогу.
 */
const MIN_VIN_LENGTH = 5

/**
 * Ответ Avtocod → VIN. Возвращает null, если VIN в ответе нет или он мусорный
 * (трактуем как «госномер не найден»). ⚠️ Имена полей — предположение.
 */
export function mapVin(data: unknown): string | null {
  if (!isRecord(data)) return null
  // VIN может лежать в корне или во вложенной карточке авто.
  const v = firstRecord(data, ['vehicle', 'car', 'auto', 'data', 'result']) ?? data

  const vin = str(v, ['vin', 'vinCode', 'vin_code', 'VIN'])
  if (!vin) return null

  const normalized = vin.trim().toUpperCase()
  return normalized.length >= MIN_VIN_LENGTH ? normalized : null
}
