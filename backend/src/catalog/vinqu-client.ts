import { AppError } from '../http/errors'
import { asArray, bool, int, isRecord, str } from './parse-utils'
import { requestProviderJson } from './provider-http'

/**
 * Клиент биржи подбора VINqu (vinqu.com, сервис платформы ABCP) — живые
 * эксперты подбирают OEM-номера деталей по VIN/frame. Это та же механика
 * «гибрид ИИ+люди», которой пользуется Ta-Dam: когда каталог не дал ответа,
 * запрос уходит эксперту, ответ — список номеров (бренд+номер), которые дальше
 * прогоняются через обычную проценку поставщиков (SupplierProvider.getOffers).
 *
 * Сверено с документацией (www.abcp.ru/wiki/API.VINQU, авг 2026):
 *   • Хост: publicapi.vinqu.com; авторизация — siteHash + accessHash из
 *     настроек интеграции учётной записи VINqu (в каждом запросе).
 *   • POST `vinquery/add` (form-data: carInfo[…], parts[], guestInfo[…],
 *     clientComment) → `{QueryId}`; ошибка приходит как `{Error: "…"}`.
 *   • GET `vinquery/info/:id` → карточка запроса: status/state, parts[] с
 *     offers[] от экспертов ({brand, number, descr, quantity}), чат.
 *   • Тарифы (авг 2026): 51 ₽ первая позиция, 34 ₽ последующие по тому же VIN,
 *     первый месяц — бесплатный тест.
 *
 * ⚠️ СКЕЛЕТ ПОД ДОСТУП — БЕЗ ПРОДУКТОВОЙ ОБВЯЗКИ. Подбор асинхронный (эксперт
 * отвечает минуты–часы), поэтому в синхронный поиск каталога клиент не встроен.
 * Продуктовый флоу отдельной волной: сохранение QueryId у запроса пользователя,
 * опрос/уведомление о готовности, показ номеров от эксперта. Значения
 * status/state в документации не расшифрованы — сверить на живом аккаунте.
 */

export const VINQU_DEFAULT_BASE_URL = 'https://publicapi.vinqu.com'

export type VinquConfig = {
  /** siteHash из настроек интеграции учётной записи VINqu. */
  siteHash: string
  /** accessHash из настроек интеграции учётной записи VINqu. */
  accessHash: string
  baseUrl?: string
  /** Инъекция fetch — для тестов; по умолчанию глобальный fetch. */
  fetchImpl?: typeof fetch
}

export type VinquCreateQueryInput = {
  car: {
    vin?: string
    /** Frame-номер для JDM-праворулек — VINqu принимает его наравне с VIN. */
    frame?: string
    brand?: string
    model?: string
    year?: string
  }
  /** Список искомых деталей в свободной форме («колодки передние», …). */
  parts: string[]
  clientComment?: string
  /** Контакты клиента — эксперт может уточнять детали через чат. */
  guest?: { name?: string; phone?: string; email?: string }
}

/** Предложение эксперта: конкретный номер детали (цены нет — её даёт проценка). */
export type VinquExpertOffer = {
  brand: string
  number: string
  description: string | null
  quantity: number
}

export type VinquQueryPart = {
  /** Исходный запрос пользователя, как он ушёл эксперту. */
  query: string
  offers: VinquExpertOffer[]
}

export type VinquQueryInfo = {
  id: string
  /** Коды статуса биржи как есть. ⚠️ Значения сверить на живом аккаунте. */
  status: number | null
  state: number | null
  parts: VinquQueryPart[]
}

export class VinquExpertClient {
  private readonly siteHash: string
  private readonly accessHash: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(config: VinquConfig) {
    this.siteHash = config.siteHash
    this.accessHash = config.accessHash
    this.baseUrl = (config.baseUrl ?? VINQU_DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  /** Отправляет запрос на биржу подбора. Возвращает QueryId для опроса результата. */
  async createQuery(input: VinquCreateQueryInput): Promise<string> {
    const form = new FormData()
    form.set('siteHash', this.siteHash)
    form.set('accessHash', this.accessHash)
    for (const [key, value] of Object.entries(input.car)) {
      if (value?.trim()) form.set(`carInfo[${key}]`, value.trim())
    }
    for (const part of input.parts) {
      if (part.trim()) form.append('parts[]', part.trim())
    }
    if (input.clientComment?.trim()) form.set('clientComment', input.clientComment.trim())
    for (const [key, value] of Object.entries(input.guest ?? {})) {
      if (value?.trim()) form.set(`guestInfo[${key}]`, value.trim())
    }

    const data = await requestProviderJson({
      provider: 'VINqu',
      url: `${this.baseUrl}/vinquery/add`,
      method: 'POST',
      body: form,
      fetchImpl: this.fetchImpl,
    })

    const queryId = isRecord(data) ? str(data, ['QueryId', 'queryId']) : null
    if (queryId) return queryId

    // Бизнес-ошибки VINqu приходят HTTP 200 с {Error: "…"} — не глотаем их.
    const reason = isRecord(data) ? (str(data, ['Error', 'error']) ?? 'ответ без QueryId') : 'пустой ответ'
    throw new AppError(502, 'INTERNAL_ERROR', `VINqu отклонил запрос подбора (${reason})`)
  }

  /** Текущее состояние запроса с ответами экспертов. null — запрос не найден. */
  async getQuery(queryId: string): Promise<VinquQueryInfo | null> {
    const params = new URLSearchParams({ siteHash: this.siteHash, accessHash: this.accessHash })
    const data = await requestProviderJson({
      provider: 'VINqu',
      url: `${this.baseUrl}/vinquery/info/${encodeURIComponent(queryId)}?${params.toString()}`,
      fetchImpl: this.fetchImpl,
    })
    if (data === null || !isRecord(data)) return null
    return mapQueryInfo(queryId, data)
  }
}

/** Карточка запроса VINqu → типизированный результат. Удалённые офферы отбрасываются. */
export function mapQueryInfo(queryId: string, data: Record<string, unknown>): VinquQueryInfo {
  const parts: VinquQueryPart[] = (asArray(data['parts']) ?? []).map((part) => ({
    query: str(part, ['query']) ?? '',
    offers: (asArray(part['offers']) ?? [])
      .filter((offer) => bool(offer, ['deleted']) !== true)
      .flatMap((offer) => {
        const brand = str(offer, ['brand'])
        const number = str(offer, ['number'])
        // Без бренда или номера предложение эксперта нельзя отдать в проценку.
        if (!brand || !number) return []
        return [
          {
            brand,
            number,
            description: str(offer, ['descr', 'description']),
            quantity: int(offer, ['quantity']) ?? 0,
          },
        ]
      }),
  }))

  return {
    id: str(data, ['_id', 'id']) ?? queryId,
    status: int(data, ['status']),
    state: int(data, ['state']),
    parts,
  }
}
