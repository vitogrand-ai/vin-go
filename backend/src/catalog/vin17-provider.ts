import { createHash } from 'node:crypto'

import type { Part, Vehicle } from '@web-app-demo/contracts'

import { AppError } from '../http/errors'
import { asArray, int, isRecord, str } from './parse-utils'
import { translatePartQuery } from './part-query-zh'
import { requestProviderJson } from './provider-http'
import type { CatalogProvider } from './providers'

/**
 * Адаптер каталога 17vin.com — китайский EPC: VIN → авто → оригинальные детали.
 * Сильная сторона — китайские авто и китайский авторынок (включая локализованные
 * иномарки: FAW-Toyota и т.п.); живой тест показал, что декодируются и
 * европейские VIN (epc `audi_vw`). Тариф: $0.15 за VIN, повторные запросы по
 * тому же VIN 3 месяца не тарифицируются. Подключается в
 * `createCatalogProviders` по `VIN17_USER`+`VIN17_PASSWORD`.
 *
 * Сверено с документацией (www.17vin.com/doc, авг 2026) И живыми вызовами:
 *   • Авторизация: в каждом запросе `user` + `token`, где
 *     token = MD5(MD5(user)+MD5(password)+«путь запроса с параметрами до user»).
 *     Алгоритм подтверждён байт-в-байт по примеру из документации.
 *   • Декодирование VIN (оп. 3001): `GET /?vin=…` → конверт {code, msg, data};
 *     data.epc — код бренда для последующих запросов деталей, data.model_list —
 *     карточки модели с английскими полями (Brand_en, Model_en, Engine_no_en…).
 *   • Поиск детали по названию (оп. 5107): `GET /{epc}?action=search_epc_part_name`
 *     с query_part_name в URL-safe base64. Названия в базе — китайские/английские,
 *     поэтому русский запрос напрямую даёт мало пользы: перевод запроса RU→ZH —
 *     отдельный слой (см. TODO в docstring searchParts).
 *   • Коды конверта (оп. 2002): 1 — успех; 0 — нет данных; 1003 — бренд не
 *     поддержан (для нас — штатное «пусто»); 1001/1002/1004 — ошибки запроса и
 *     авторизации; 1005 — исчерпан баланс/срок; 1006/1007 — сбои. Всё, кроме
 *     1/0/1003, — отказ провайдера (502), включая 1005, чтобы конец предоплаты
 *     не маскировался под «ничего не найдено».
 */

/** Базовый URL API (из документации; API отдаётся по HTTP на порту 8080). */
export const VIN17_DEFAULT_BASE_URL = 'http://api.17vin.com:8080'

/**
 * Потолок деталей в ответе поиска: нечёткий поиск 5107 на общих словах
 * возвращает тысячи записей — не тащим их все через контракт в UI.
 */
export const VIN17_MAX_PARTS = 100

export type Vin17Config = {
  user: string
  password: string
  baseUrl?: string
  /** Инъекция fetch — для тестов; по умолчанию глобальный fetch. */
  fetchImpl?: typeof fetch
}

export class Vin17CatalogProvider implements CatalogProvider {
  private readonly user: string
  private readonly password: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(config: Vin17Config) {
    this.user = config.user
    this.password = config.password
    this.baseUrl = (config.baseUrl ?? VIN17_DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  async decodeVin(vin: string): Promise<Vehicle | null> {
    const normalized = vin.trim().toUpperCase()
    if (!normalized) return null
    const payload = await this.call(decodePath(normalized))
    if (payload === null) return null
    return mapVehicle(normalized, payload)
  }

  /**
   * Поиск по названию детали (оп. 5107, нечёткое совпадение). Названия в базе
   * 17vin — формальный китайский EPC-язык и частично английский, поэтому язык
   * запроса решает всё (проверено живьём):
   *   • русский → переводится словарём part-query-zh в EPC-термин; без перевода
   *     запрос НЕ отправляется — сырой русский возвращает весь каталог (4470
   *     записей шума), честное «пусто» лучше;
   *   • китайский → как есть (точная выдача);
   *   • латиница → как есть, но с дофильтрацией по названию: нечёткий поиск
   *     17vin на английском тоже разливается в шум.
   */
  async searchParts(vehicle: Vehicle, query: string): Promise<Part[]> {
    const q = query.trim()
    if (!q) return []

    let effectiveQuery = q
    let latinPostFilter = false
    if (/[а-яё]/i.test(q)) {
      const zh = translatePartQuery(q)
      if (!zh) {
        // Лог — сырьё для пополнения словаря по реальным запросам пилота.
        console.warn(`[17vin] нет перевода RU→ZH, поиск пропущен: «${q}»`)
        return []
      }
      effectiveQuery = zh
    } else if (!/[一-鿿]/.test(q)) {
      latinPostFilter = true
    }

    // Код бренда (epc) кладётся в raw при decodeVin. Если авто определял другой
    // каталог (best-effort ветка FallbackCatalogProvider) — восстанавливаем epc
    // повторным декодом: по тому же VIN 17vin повтор не тарифицирует.
    let epc = typeof vehicle.raw?.['epc'] === 'string' ? (vehicle.raw['epc'] as string) : null
    if (!epc) {
      const decoded = await this.call(decodePath(vehicle.vin.trim().toUpperCase()))
      epc = decoded ? str(decoded, ['epc']) : null
      if (!epc) return []
    }

    const params = new URLSearchParams({
      action: 'search_epc_part_name',
      vin: vehicle.vin.trim().toUpperCase(),
      query_match_type: 'inexact',
      query_part_name: safeBase64(effectiveQuery),
      query_part_name_is_safebase64: '1',
    })
    const payload = await this.call(`/${encodeURIComponent(epc)}?${params.toString()}`)
    if (payload === null) return []
    const parts = mapParts(payload, vehicle.make)
    return latinPostFilter ? filterByQueryTokens(parts, q) : parts
  }

  /**
   * Один вызов API: подпись токеном, разбор конверта {code, msg, data}.
   * null — штатное «нет данных» (code 0, «бренд не поддержан» 1003, HTTP 404);
   * остальные не-1 коды — отказ провайдера (502), включая 1005 «баланс исчерпан».
   */
  private async call(path: string): Promise<Record<string, unknown> | null> {
    const token = buildVin17Token(this.user, this.password, path)
    const url = `${this.baseUrl}${path}&user=${encodeURIComponent(this.user)}&token=${token}`
    const envelope = await requestProviderJson({
      provider: '17vin',
      url,
      fetchImpl: this.fetchImpl,
    })
    if (envelope === null) return null
    if (!isRecord(envelope)) {
      throw new AppError(502, 'INTERNAL_ERROR', 'Провайдер 17vin недоступен (некорректный конверт ответа)')
    }

    const code = int(envelope, ['code']) ?? 0
    if (code === 1) {
      const payload = envelope['data']
      return isRecord(payload) ? payload : null
    }
    if (code === 0 || code === 1003) return null // нет данных / бренд вне каталога

    const msg = str(envelope, ['msg']) ?? 'без описания'
    throw new AppError(502, 'INTERNAL_ERROR', `Провайдер 17vin отказал (code ${code}: ${msg})`)
  }
}

/**
 * Дофильтрация латинской выдачи: нечёткий поиск 17vin по английскому термину
 * разливается на весь каталог, поэтому оставляем только детали, в названии или
 * категории которых встречается каждое слово запроса.
 */
export function filterByQueryTokens(parts: Part[], query: string): Part[] {
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2)
  if (tokens.length === 0) return parts
  return parts.filter((part) => {
    const haystack = `${part.name} ${part.category}`.toLowerCase()
    return tokens.every((token) => haystack.includes(token))
  })
}

/** Путь запроса декодирования — единый для decodeVin и восстановления epc. */
function decodePath(vin: string): string {
  return `/?vin=${encodeURIComponent(vin)}`
}

/**
 * Подпись запроса 17vin: MD5(MD5(user)+MD5(password)+путь_с_параметрами).
 * «Путь» — строка запроса ДО добавления &user=&token= (проверено по примеру
 * из документации). Токен зависит от точной строки, поэтому путь собирается
 * один раз и используется и для подписи, и для запроса.
 */
export function buildVin17Token(user: string, password: string, path: string): string {
  const md5 = (s: string) => createHash('md5').update(s).digest('hex')
  return md5(md5(user) + md5(password) + path)
}

/** URL-safe base64 без паддинга — формат query_part_name у 17vin (сверен с доками). */
export function safeBase64(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

/**
 * Payload декодирования → карточка авто. Английские поля предпочитаются
 * китайским. null — если марку/модель определить не удалось. Код бренда `epc`
 * сохраняется в raw — он нужен searchParts (и деталям бренда в целом).
 */
export function mapVehicle(vin: string, payload: Record<string, unknown>): Vehicle | null {
  const model = (asArray(payload['model_list']) ?? [])[0] ?? null

  const make = (model && str(model, ['Brand_en'])) ?? str(payload, ['brand'])
  const modelName = model ? str(model, ['Model_en', 'Series_en', 'Model_detail_en']) : null
  if (!make && !modelName) return null

  const epc = str(payload, ['epc'])
  return {
    vin,
    make: make ?? 'Не определено',
    model: modelName ?? 'Не определено',
    // Год из самого VIN точнее года поколения модели (Model_year).
    year: int(payload, ['model_year_from_vin']) ?? (model ? (int(model, ['Model_year']) ?? 0) : 0),
    engine: model ? str(model, ['Engine_no_en', 'Engine_no']) : null,
    bodyType: model ? str(model, ['Body_type_en', 'Body_type', 'Chassis_code']) : null,
    // Только нужное: полный ответ 17vin с регуляторными списками слишком жирный.
    raw: {
      ...(epc ? { epc } : {}),
      ...(model && str(model, ['Model_detail_en'])
        ? { modelDetail: str(model, ['Model_detail_en']) }
        : {}),
    },
  }
}

/**
 * Payload поиска 5107 (или списка 5105) → детали контракта. Детали, явно
 * помеченные неприменимыми к этому VIN, и записи без номера/названия
 * отбрасываются; выдача ограничена VIN17_MAX_PARTS.
 */
export function mapParts(payload: Record<string, unknown>, brand: string | null): Part[] {
  const list = asArray(payload['searchlist']) ?? asArray(payload['partlist'])
  if (!list) return []

  const parts: Part[] = []
  for (const item of list) {
    if (parts.length >= VIN17_MAX_PARTS) break
    if (int(item, ['is_fit_for_this_vin']) === 0) continue // явно не подходит к VIN

    const oemNumber = str(item, ['partnumber_original', 'partnumber'])
    const name = str(item, ['name_en', 'std_name_en', 'name_zh', 'std_name_zh'])
    if (!oemNumber || !name) continue

    // cata_name_en — путь категорий через «>», берём последний осмысленный узел.
    const cataPath = str(item, ['cata_name_en', 'cata_name_zh']) ?? ''
    const category = cataPath.split('>').map((s) => s.trim()).filter(Boolean).pop() ?? ''

    parts.push({ oemNumber, name, category, brand })
  }
  return parts
}
