import { createHash } from 'node:crypto'

import type { DealerPrice, Part, Vehicle } from '@web-app-demo/contracts'

import { AppError } from '../http/errors'
import { asArray, int, isRecord, str } from './parse-utils'
import { englishPartTerms, translatePartQuery } from './part-terms'
import { requestProviderJson } from './provider-http'
import type { CatalogProvider, DealerPriceProvider } from './providers'

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
 *   • Схема узла приходит в ответе того же поиска: `illustration_img_address` —
 *     файл картинки на хосте из оп. 2004, `callout` — номер выноски на ней,
 *     `cata_code` — идентификатор узла. Отдельного запроса схема не стоит.
 *   • Весь узел по `cata_code` (оп. 5105): `GET /{epc}?action=part` — список
 *     деталей с выносками, адресом схемы и координатами выносок на картинке.
 *   • Коды конверта (оп. 2002): 1 — успех; 0 — нет данных; 1003 — бренд не
 *     поддержан (для нас — штатное «пусто»); 1001/1002/1004 — ошибки запроса и
 *     авторизации; 1005 — исчерпан баланс/срок; 1006/1007 — сбои. Всё, кроме
 *     1/0/1003, — отказ провайдера (502), включая 1005, чтобы конец предоплаты
 *     не маскировался под «ничего не найдено».
 */

/** Базовый URL API (из документации; API отдаётся по HTTP на порту 8080). */
export const VIN17_DEFAULT_BASE_URL = 'http://api.17vin.com:8080'

/** Хост картинок каталога — схем узлов и фотографий моделей (оп. 2004). */
export const VIN17_IMAGE_BASE_URL = 'http://resource.17vin.com/img'

/**
 * Потолок деталей в ответе поиска: нечёткий поиск 5107 на общих словах
 * возвращает тысячи записей — не тащим их все через контракт в UI.
 */
export const VIN17_MAX_PARTS = 100

/**
 * Сколько узлов выдачи догружать ради координат выносок. У живых выдач узлов
 * обычно два-четыре; потолок защищает от нечёткого поиска на общем слове.
 */
export const VIN17_MAX_HOTSPOT_NODES = 5

export type Vin17Config = {
  user: string
  password: string
  baseUrl?: string
  /** Инъекция fetch — для тестов; по умолчанию глобальный fetch. */
  fetchImpl?: typeof fetch
}

export class Vin17CatalogProvider implements CatalogProvider, DealerPriceProvider {
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
   * Поиск по названию детали (оп. 5107, нечёткое совпадение). Языком базы
   * каталог 17vin однороден не весь: китайские марки описаны китайским
   * EPC-языком, а импортные (jaguar, audi_vw и прочие) — английским, с
   * машинным китайским переводом рядом. Отсюда два прохода на русский запрос
   * (оба проверены живьём, 18.09.2026, Jaguar XF SAJAA04M6FPU46282):
   *   • китайский термин словаря — точное попадание там, где база китайская;
   *   • английский термин словаря — там, где база английская: `机油滤清器`
   *     на Jaguar даёт ноль (в каталоге деталь зовётся `Oil filter` с машинным
   *     `机油过滤器`), и так промахивались 36 терминов словаря из 68.
   *
   * Латинский запрос каталог не фильтрует вовсе: на любое слово он отдаёт весь
   * подходящий VIN список целиком (2272 записи на том же Jaguar — одинаково на
   * «oil filter» и на «zzzzqqq»). Поэтому английский проход — это выгрузка со
   * СВОИМ отбором по названию (`filterByTerms`), а потолок VIN17_MAX_PARTS
   * накладывается ПОСЛЕ отбора: до него нужная деталь стояла 2012-й и в сотню
   * не попадала.
   *
   * Китайский запрос уходит как есть (точная выдача). Русский без словаря не
   * отправляется вовсе — сырой русский возвращает весь каталог шумом.
   */
  async searchParts(vehicle: Vehicle, query: string): Promise<Part[]> {
    const q = query.trim()
    if (!q) return []

    if (/[а-яё]/i.test(q)) return this.searchRussian(vehicle, q)
    // Китайский — как есть; латиница — выгрузка всего каталога со своим отбором.
    const terms = /[一-鿿]/.test(q) ? null : [q]
    const epc = await this.resolveEpc(vehicle)
    if (!epc) return []
    return this.searchTerm(vehicle, epc, q, terms)
  }

  /**
   * Русский запрос: словарь `part-terms` → китайский термин, затем английские.
   * Порядок не случаен: китайский проход точен и дёшев по объёму ответа, а
   * английский тянет весь каталог машины. Оба прохода бесплатны (5107 баланс
   * не трогает), поэтому промах первого ничего не стоит, кроме времени.
   */
  private async searchRussian(vehicle: Vehicle, q: string): Promise<Part[]> {
    const zh = translatePartQuery(q)
    const english = englishPartTerms(q)
    if (!zh && english.length === 0) {
      // Лог — сырьё для пополнения словаря по реальным запросам пилота.
      console.warn(`[17vin] нет перевода запроса, поиск пропущен: «${q}»`)
      return []
    }

    const epc = await this.resolveEpc(vehicle)
    if (!epc) return []

    if (zh) {
      const parts = await this.searchTerm(vehicle, epc, zh, null)
      if (parts.length > 0) return parts
    }

    // Термины перебираются по одному: на каталоге с английской базой первый же
    // вернёт всё (отбор идёт локально по ВСЕМ терминам), а если каталог всё же
    // фильтрует по слову — у каждого синонима свой шанс.
    for (const term of english) {
      const parts = await this.searchTerm(vehicle, epc, term, english)
      if (parts.length > 0) return parts
    }
    return []
  }

  /**
   * Один вызов 5107 с готовым термином. `terms` — английские подстроки для
   * локального отбора (null — каталог отфильтровал сам, отбор не нужен).
   */
  private async searchTerm(
    vehicle: Vehicle,
    epc: string,
    term: string,
    terms: string[] | null,
  ): Promise<Part[]> {
    const params = new URLSearchParams({
      action: 'search_epc_part_name',
      vin: vehicle.vin.trim().toUpperCase(),
      query_match_type: 'inexact',
      query_part_name: safeBase64(term),
      query_part_name_is_safebase64: '1',
    })
    const payload = await this.call(`/${encodeURIComponent(epc)}?${params.toString()}`)
    if (payload === null) return []

    // Потолок снимается только там, где дальше идёт отбор: иначе выгрузка всего
    // каталога обрезалась бы до первой сотни, в которой нужной детали нет.
    const found = mapParts(payload, { brand: vehicle.make, epc, limit: terms ? Infinity : undefined })
    const parts = terms ? filterByTerms(found, terms).slice(0, VIN17_MAX_PARTS) : found
    return this.withHotspots(vehicle, epc, parts)
  }

  /**
   * Координаты выносок для выдачи поиска. Поиск (5107) их не отдаёт — только
   * запрос узла (5105), поэтому узлы выдачи догружаются отдельно, параллельно.
   *
   * Все узлы, а не один: выдача по «амортизатору» собирается из четырёх узлов
   * (передний, задний, рулевой демпфер, цепь ГРМ), а после ранжирования первой
   * становится деталь не из того узла, что был первым у каталога, — живьём на
   * проде 16.09.2026 обводка была только у трёх деталей из тринадцати. Потолок
   * VIN17_MAX_HOTSPOT_NODES — чтобы нечёткий поиск на общем слове не превращал
   * одну выдачу в десятки запросов.
   *
   * Денег это не стоит — узел бесплатен (сверено по балансу аккаунта). Сбой
   * узла выдачу не ломает: деталь просто останется без обводки, номер выноски
   * у неё есть и так.
   */
  private async withHotspots(vehicle: Vehicle, epc: string, parts: Part[]): Promise<Part[]> {
    const schemeIds = [
      ...new Set(parts.filter((part) => part.imageUrl).map((part) => part.schemeId)),
    ]
      .filter((id): id is string => Boolean(id))
      .slice(0, VIN17_MAX_HOTSPOT_NODES)
    if (schemeIds.length === 0) return parts

    const nodes = await Promise.all(
      schemeIds.map(async (schemeId) => {
        try {
          const node = await this.call(nodePath(epc, vehicle.vin, schemeId))
          return [schemeId, node ? parseHotspots(node) : new Map()] as const
        } catch (error) {
          console.warn(`[17vin] выноски узла ${schemeId} не догрузились, без обводки`, error)
          return [schemeId, new Map<string, SchemeHotspot>()] as const
        }
      }),
    )
    const bySchemeId = new Map<string, Map<string, SchemeHotspot>>(nodes)

    return parts.map((part) => {
      if (!part.schemeId || !part.position) return part
      const hotspot = bySchemeId.get(part.schemeId)?.get(part.position)
      return hotspot ? { ...part, schemeHotspot: hotspot } : part
    })
  }

  /**
   * Весь узел по его идентификатору (оп. 5105): мастер смотрит на схему и
   * называет номер выноски, а не название детали. Отбора по названию здесь нет —
   * на схеме масляного фильтра под номером 15692 стоит прокладка кронштейна,
   * которую словами никто бы не спросил.
   *
   * Документация предлагает для этого оп. 4005 (`action=illustration`), но она
   * на нашем аккаунте отвечает «配件查询参数错误» при любом наборе параметров
   * (проверено живьём, сент 2026). Оп. 5105 отдаёт ровно то же — список деталей
   * узла с выносками и адресом схемы, — поэтому идём через неё.
   *
   * `last_cata_code_level` каталог, вопреки документации, игнорирует: живьём
   * ответ одинаков для 1, 2, 3 и даже для отсутствующего параметра. Уровень
   * узла из `cata_code` не восстановить, поэтому шлём значение из примера
   * документации.
   */
  async schemeParts(vehicle: Vehicle, schemeId: string): Promise<Part[]> {
    const cataCode = schemeId.trim()
    if (!cataCode) return []
    const epc = await this.resolveEpc(vehicle)
    if (!epc) return []

    const payload = await this.call(nodePath(epc, vehicle.vin, cataCode))
    if (payload === null) return []
    const hotspots = parseHotspots(payload)
    return mapParts(payload, { brand: vehicle.make, epc, schemeId: cataCode }).map((part) => {
      const hotspot = part.position ? hotspots.get(part.position) : undefined
      return hotspot ? { ...part, schemeHotspot: hotspot } : part
    })
  }

  /**
   * Цена оригинала у официальных дилеров КНР (оп. 4006) — по номеру, без VIN.
   *
   * ПЛАТНАЯ за каждый вызов, в отличие от поиска и узла: живьём баланс
   * аккаунта уменьшился на 0,03 после вызова и ещё на 0,03 после повтора того
   * же номера (сент 2026). Поэтому снаружи адаптер оборачивается кэшем
   * (`CachingDealerPriceProvider`), а здесь вызов идёт как есть.
   */
  async dealerPrice(oemNumber: string): Promise<DealerPrice | null> {
    const number = oemNumber.replace(/[\s-]/g, '').toUpperCase()
    if (!number) return null
    const params = new URLSearchParams({ action: 'price', partnumber: number })
    const payload = await this.call(`/?${params.toString()}`)
    return payload ? mapDealerPrice(payload) : null
  }

  /**
   * Код бренда (epc) кладётся в raw при decodeVin. Если авто определял другой
   * каталог (best-effort ветка FallbackCatalogProvider) — восстанавливаем epc
   * повторным декодом: по тому же VIN 17vin повтор не тарифицирует.
   */
  private async resolveEpc(vehicle: Vehicle): Promise<string | null> {
    const fromRaw = vehicle.raw?.['epc']
    if (typeof fromRaw === 'string' && fromRaw) return fromRaw

    const decoded = await this.call(decodePath(vehicle.vin.trim().toUpperCase()))
    return decoded ? str(decoded, ['epc']) : null
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
      // Хост в Китае + объёмные ответы декодирования: стандартных 5 секунд
      // не хватает (живой замер) — даём больше, пользовательский запрос всё
      // равно ограничен этим потолком.
      timeoutMs: 15_000,
    })
    if (envelope === null) return null
    if (!isRecord(envelope)) {
      throw new AppError(502, 'INTERNAL_ERROR', 'Провайдер 17vin недоступен (некорректный конверт ответа)')
    }

    const code = int(envelope, ['code']) ?? 0
    if (code === 1) {
      const payload = envelope['data']
      // Оп. 4006 отдаёт в data массив дилеров, остальные — объект.
      if (Array.isArray(payload)) return { list: payload }
      return isRecord(payload) ? payload : null
    }
    if (code === 0 || code === 1003) return null // нет данных / бренд вне каталога

    const msg = str(envelope, ['msg']) ?? 'без описания'
    throw new AppError(502, 'INTERNAL_ERROR', `Провайдер 17vin отказал (code ${code}: ${msg})`)
  }
}

/**
 * Отбор выгрузки каталога по английским терминам запроса: на латиницу 17vin
 * отдаёт весь список деталей машины, отбор — наша работа.
 *
 * Термин ищется ЦЕЛОЙ ФРАЗОЙ и термины перебираются в порядке словаря — от
 * самого узкого к родовому, — а выдачу даёт ПЕРВЫЙ, который вообще попал.
 * Обе тонкости проверены живьём (18.09.2026) и обе нужны: по отдельным словам
 * «pad kit» ловил `PAD-BRAKE PEDAL`, а родовое «pad» на Jaguar приносило 38
 * накладок бампера и подушек сидений вместо колодок. С порядком и фразой
 * каждая из трёх машин отвечает своей записью: Subaru — `PAD KIT-FRONT DISK
 * BRAKE`, Toyota — `PAD KIT, DISC BRAKE, FRONT`, Jaguar — `Brake pad tool`
 * (машинный перевод названия узла у этого каталога такой).
 *
 * Название детали важнее узла: оно и отвечает на «что это за деталь». Но если
 * по названию не попал ни один термин, пробуем узел — у части каталогов деталь
 * названа родовым словом, а уточнение стоит в узле (у Jaguar фильтр воздуха
 * назван просто `Filter` в узле «Air Filter — 2.0 Liter Gasoline»).
 */
export function filterByTerms(parts: Part[], terms: string[]): Part[] {
  const needles = terms.map((term) => term.toLowerCase().trim()).filter(Boolean)

  for (const field of [namePartOf, nameAndNodeOf]) {
    for (const needle of needles) {
      const hit = parts.filter((part) => field(part).includes(needle))
      if (hit.length > 0) return hoistExactNames(hit, needle)
    }
  }
  return []
}

const namePartOf = (part: Part): string => part.name.toLowerCase()
const nameAndNodeOf = (part: Part): string => `${part.name} ${part.category}`.toLowerCase()

/**
 * Сама деталь — первой строкой, её окружение — ниже: мастер жмёт первую кнопку.
 *
 * Порядок: название равно термину; название им ЗАКАНЧИВАЕТСЯ; всё остальное.
 * Второе правило — про английскую грамматику: главное слово стоит в конце, и
 * «Lead-acid battery» — это аккумулятор, а «Ion battery charger» — зарядное
 * устройство (живьём на Jaguar XF оно и стояло первым). Внутри группы порядок
 * каталога сохраняется — он осмысленный, позиции узла идут подряд.
 */
function hoistExactNames(parts: Part[], needle: string): Part[] {
  const rank = (name: string): number => {
    const lowered = name.toLowerCase().trim()
    if (lowered === needle) return 0
    return lowered.endsWith(needle) ? 1 : 2
  }
  return parts
    .map((part, order) => ({ part, order, rank: rank(part.name) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((ranked) => ranked.part)
}

/** Путь запроса декодирования — единый для decodeVin и восстановления epc. */
function decodePath(vin: string): string {
  return `/?vin=${encodeURIComponent(vin)}`
}

/**
 * Путь запроса узла (оп. 5105) — один для `schemeParts` и догрузки выносок.
 * `last_cata_code_level` каталог игнорирует (см. `schemeParts`), шлём значение
 * из примера документации.
 */
function nodePath(epc: string, vin: string, cataCode: string): string {
  const params = new URLSearchParams({
    action: 'part',
    vin: vin.trim().toUpperCase(),
    last_cata_code: cataCode,
    last_cata_code_level: '2',
  })
  return `/${encodeURIComponent(epc)}?${params.toString()}`
}

export type SchemeHotspot = { x: number; y: number }

/**
 * Выноски схемы из ответа узла → «номер выноски → доли ширины и высоты».
 *
 * Каталог отдаёт левый верхний угол подписи в пикселях и размер картинки:
 * `all_img_hotspots[].img_hotspots = {img_width, img_height, hotspots:
 * [{callout, topleft_x, topleft_y}]}`. Доли вместо пикселей — чтобы клиенту
 * не нужно было знать, в каком размере картинка реально пришла. Координата
 * вне картинки или картинка без размеров — выноска пропускается.
 */
export function parseHotspots(payload: Record<string, unknown>): Map<string, SchemeHotspot> {
  const result = new Map<string, SchemeHotspot>()
  for (const block of asArray(payload['all_img_hotspots']) ?? []) {
    const image = block['img_hotspots']
    if (!isRecord(image)) continue
    const width = int(image, ['img_width'])
    const height = int(image, ['img_height'])
    if (!width || !height) continue

    for (const spot of asArray(image['hotspots']) ?? []) {
      const callout = str(spot, ['callout'])
      const x = int(spot, ['topleft_x'])
      const y = int(spot, ['topleft_y'])
      if (!callout || x === null || y === null) continue
      if (x < 0 || y < 0 || x > width || y > height) continue
      // Одна выноска может стоять на схеме дважды — берём первую.
      if (!result.has(callout)) result.set(callout, { x: x / width, y: y / height })
    }
  }
  return result
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
 *
 * Два источника в порядке приоритета:
 *   1) model_list — китайская модельная база (заполнен для машин рынка КНР);
 *   2) model_original_epc_list[].CarAttributes — атрибуты оригинального EPC.
 *      Для импортных/неоднозначных VIN (напр. европейский BMW, у которого
 *      шасси имеет несколько заводских конфигураций) model_list ПУСТ, но EPC
 *      отдаёт Brand/Model/Year/Engine — без этого фолбэка такие VIN ошибочно
 *      считались «не найденными» (живой случай: WBA… → BMW 520dX Touring).
 */
export function mapVehicle(vin: string, payload: Record<string, unknown>): Vehicle | null {
  const model = (asArray(payload['model_list']) ?? [])[0] ?? null
  const attrs = model ? null : extractEpcAttributes(payload)

  const rawModelName = model
    ? str(model, ['Model_en', 'Series_en', 'Model_detail_en'])
    : (attrs?.get('model') ?? attrs?.get('model name') ?? attrs?.get('series') ?? null)

  const epc = str(payload, ['epc'])
  // У части импортных VIN (живьём: корейцы Hyundai/Kia) отдельного поля марки
  // нет вовсе — `brand` пустой, а название модели идёт вместе с маркой:
  // «HYUNDAI REURPH517 ACCENT/SOLARIS 17». Марку в таком случае даёт код
  // каталога `epc`, а из модели её дублирующий префикс убираем.
  const make =
    (model && str(model, ['Brand_en'])) ??
    attrs?.get('brand') ??
    str(payload, ['brand']) ??
    brandFromEpc(epc, rawModelName)
  const modelName = stripBrandPrefix(rawModelName, make)
  if (!make && !modelName) return null

  const modelDetail =
    (model && str(model, ['Model_detail_en'])) ??
    attrs?.get('series and chassis no') ??
    null
  return {
    vin,
    make: make ? normalizeBrand(make) : 'Не определено',
    model: modelName ?? 'Не определено',
    // Год из самого VIN точнее года поколения модели (Model_year). Но «нет
    // данных» 17vin отдаёт НУЛЁМ, а не пустым полем: у европейских VIN год в
    // самом номере не закодирован (живой случай: Mercedes W177 —
    // model_year_from_vin = "0" при Model_year = "2019"). Ноль — не год, иначе
    // он бы победил настоящий год модели. Поэтому каждый источник проверяем на
    // правдоподобие, а когда не осталось ни одного, год берём из конца описания
    // модели («… Dynamic Type 2019»). Ничего не нашли — честный null, а не 0.
    year:
      plausibleYear(int(payload, ['model_year_from_vin'])) ??
      plausibleYear(model ? int(model, ['Model_year']) : parseIntOrNull(attrs?.get('year'))) ??
      yearFromModelDetail(modelDetail),
    engine: model
      ? str(model, ['Engine_no_en', 'Engine_no'])
      : (attrs?.get('engine') ?? attrs?.get('engine code') ?? null),
    bodyType: model
      ? str(model, ['Body_type_en', 'Body_type', 'Chassis_code'])
      : (attrs?.get('body') ?? null),
    // Только нужное: полный ответ 17vin с регуляторными списками слишком жирный.
    raw: {
      ...(epc ? { epc } : {}),
      ...(modelDetail ? { modelDetail } : {}),
    },
  }
}

/**
 * CarAttributes оригинального EPC → карта «имя атрибута (в нижнем регистре) →
 * значение». Английские значения приоритетнее китайских.
 */
function extractEpcAttributes(payload: Record<string, unknown>): Map<string, string> | null {
  const entry = (asArray(payload['model_original_epc_list']) ?? [])[0]
  if (!entry) return null

  const attrs = new Map<string, string>()
  for (const attr of asArray(entry['CarAttributes']) ?? []) {
    const name = str(attr, ['Col_name'])
    const value = str(attr, ['Col_value'])
    if (!name || !value) continue
    const key = name.toLowerCase()
    if (str(attr, ['Language']) === 'en' || !attrs.has(key)) attrs.set(key, value)
  }
  return attrs.size > 0 ? attrs : null
}

/** EPC отдаёт бренды в нижнем регистре ('bmw') — приводим к читаемому виду. */
/**
 * Марка из кода каталога `epc`, когда отдельного поля марки в ответе нет.
 * Мультибрендовые коды («audi_vw») маркой не считаем — по ним нельзя сказать,
 * что именно за машина; в таком случае марку берём из первого слова модели,
 * если оно похоже на название марки, а не на код каталога.
 */
export function brandFromEpc(epc: string | null, modelName: string | null): string | null {
  if (epc && !epc.includes('_')) return normalizeBrand(epc)

  const firstWord = modelName?.trim().split(/\s+/)[0] ?? ''
  // Код каталога («REURPH517») от названия марки отличают цифры внутри.
  if (/^[A-Za-z-]{2,}$/.test(firstWord)) return normalizeBrand(firstWord.toLowerCase())
  return null
}

/**
 * Убирает из названия модели дублирующий префикс марки: 17vin отдаёт
 * «HYUNDAI REURPH517 ACCENT/SOLARIS 17», а показывать нужно модель без марки —
 * марка выводится отдельным полем.
 */
export function stripBrandPrefix(modelName: string | null, make: string | null): string | null {
  if (!modelName || !make) return modelName

  const trimmed = modelName.trim()
  if (!trimmed.toLowerCase().startsWith(make.toLowerCase())) return trimmed

  const rest = trimmed.slice(make.length).trim()
  return rest.length > 0 ? rest : trimmed
}

/**
 * Читаемый вид марки: EPC отдаёт бренды в нижнем регистре («bmw»), а составные
 * — с заглавной только у первого слова («Mercedes-benz», «Alfa romeo»).
 */
export function normalizeBrand(value: string): string {
  const trimmed = value.trim()
  if (/^[a-z]+$/.test(trimmed)) {
    return trimmed.length <= 3 ? trimmed.toUpperCase() : capitalize(trimmed)
  }
  // Составная марка: каждая часть после дефиса/пробела с заглавной.
  if (/^[A-Za-z]+([- ][A-Za-z]+)+$/.test(trimmed)) {
    return trimmed.replace(/[A-Za-z]+/g, (word) => capitalize(word.toLowerCase()))
  }
  return trimmed
}

function capitalize(word: string): string {
  return word[0]!.toUpperCase() + word.slice(1)
}

function parseIntOrNull(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : null
}

/** Похоже это на год выпуска? Ноль и мусор из ответа каталога — это «не знаю». */
function plausibleYear(year: number | null): number | null {
  if (year === null) return null
  return year >= 1900 && year <= new Date().getFullYear() + 2 ? year : null
}

/** Год в конце описания модели («… Dynamic Type 2019»); только правдоподобный. */
export function yearFromModelDetail(modelDetail: string | null): number | null {
  const match = modelDetail?.match(/\b((?:19|20)\d{2})\b\s*$/)
  return match ? Number.parseInt(match[1]!, 10) : null
}

export type Vin17PartsContext = {
  brand: string | null
  /** Код каталога бренда — сегмент адреса схемы узла. */
  epc: string | null
  /** Узел, который запрашивали (оп. 5105): в его ответе `cata_code` нет. */
  schemeId?: string
  /**
   * Потолок деталей; по умолчанию VIN17_MAX_PARTS. Снимается там, где выдача
   * дальше отбирается локально (см. `searchTerm`): обрезать выгрузку всего
   * каталога ДО отбора значит потерять искомую деталь.
   */
  limit?: number
}

/**
 * Payload поиска 5107 (или списка 5105) → детали контракта. Детали, явно
 * помеченные неприменимыми к этому VIN, записи без номера/названия и дубли
 * (номер+название: одна деталь приходит несколькими строками применимости)
 * отбрасываются; выдача ограничена `ctx.limit` (по умолчанию VIN17_MAX_PARTS).
 *
 * Схема узла приходит в том же ответе, отдельного запроса не требует:
 * `illustration_img_address` — файл картинки, `callout` — номер выноски на ней,
 * `cata_code` — сам узел (по нему открывается `schemeParts`).
 */
export function mapParts(payload: Record<string, unknown>, ctx: Vin17PartsContext): Part[] {
  const list = asArray(payload['searchlist']) ?? asArray(payload['partlist'])
  if (!list) return []

  const limit = ctx.limit ?? VIN17_MAX_PARTS
  const parts: Part[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (parts.length >= limit) break
    if (int(item, ['is_fit_for_this_vin']) === 0) continue // явно не подходит к VIN

    const oemNumber = str(item, ['partnumber_original', 'partnumber'])
    const name = str(item, ['name_en', 'std_name_en', 'name_zh', 'std_name_zh'])
    if (!oemNumber || !name) continue

    const key = `${oemNumber}|${name}`
    if (seen.has(key)) continue
    seen.add(key)

    // cata_name_en — путь категорий через «>», берём последний осмысленный узел.
    // В ответе узла (5105) его нет вовсе: категория там — сам запрошенный узел.
    const cataPath = str(item, ['cata_name_en', 'cata_name_zh']) ?? ''
    const category = cataPath.split('>').map((s) => s.trim()).filter(Boolean).pop() ?? ''

    parts.push({
      oemNumber,
      name,
      category,
      brand: ctx.brand,
      imageUrl: schemeImageUrl(ctx.epc, str(item, ['illustration_img_address'])),
      position: str(item, ['callout']),
      schemeId: str(item, ['cata_code']) ?? ctx.schemeId ?? null,
      // Количество каталог пишет с ведущим нулём («01», «04»).
      quantity: parsePositiveInt(str(item, ['qty'])),
      replacedBy: str(item, ['replacement', 'old_replacement']),
      // remark_en у Toyota пуст всегда, содержимое лежит в remark_zh и почти
      // целиком латинское: коды мотора и шасси, маркировка, мощность лампы.
      note: str(item, ['remark_en', 'remark_zh']),
      appliesPeriod: formatPeriod(str(item, ['begin_date']), str(item, ['end_date'])),
    })
  }
  return parts
}

/**
 * Ответ оп. 4006 → цена оригинала у дилеров: минимум и максимум по всем, кто
 * назвал цену. Живой ответ — строка на каждого дилера бренда («丰田» — импорт,
 * «四川一汽丰田» — FAW-Toyota), `Price` строкой («438», «345.82»).
 *
 * Валюту документация не указывает. Это цены китайских дилерских центров, а
 * баланс того же аккаунта каталог пишет в 元 — поэтому CNY. Суммы — в фэнях,
 * как рубли в контракте хранятся в копейках.
 */
export function mapDealerPrice(payload: Record<string, unknown>): DealerPrice | null {
  const prices: number[] = []
  for (const dealer of asArray(payload['list']) ?? []) {
    const price = Number.parseFloat(str(dealer, ['Price', 'price']) ?? '')
    if (Number.isFinite(price) && price > 0) prices.push(Math.round(price * 100))
  }
  if (prices.length === 0) return null
  return {
    min: Math.min(...prices),
    max: Math.max(...prices),
    currency: 'CNY',
    market: 'CN',
    dealers: prices.length,
  }
}

/** «01» → 1; мусор и ноль — «не знаю». */
function parsePositiveInt(value: string | null): number | null {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * Период применимости из дат каталога (`YYYYMM`) в читаемый вид:
 * «05.2010 — 11.2013», «с 05.2010» (конец `999999` — деталь ставится до сих
 * пор), «до 11.2013». Обе даты пусты или неразборчивы — период не показываем.
 */
export function formatPeriod(begin: string | null, end: string | null): string | null {
  const from = formatYearMonth(begin)
  const to = formatYearMonth(end)
  if (from && to) return `${from} — ${to}`
  if (from) return `с ${from}`
  if (to) return `до ${to}`
  return null
}

/** `201005` → `05.2010`. `999999` («по настоящее время») и мусор → null. */
function formatYearMonth(value: string | null): string | null {
  const match = value?.match(/^((?:19|20)\d{2})(0[1-9]|1[0-2])$/)
  return match ? `${match[2]}.${match[1]}` : null
}

/**
 * Адрес схемы узла: `{хост}/img/{epc}/{файл}` (оп. 2004).
 *
 * Хост — HTTP: HTTPS-зеркало `images.17vin.com` из документации лежит целиком
 * (503 на любом пути, включая корень; проверено сент 2026), а у
 * `resource.17vin.com` TLS не поднят вовсе. Телеграм скачивает картинку сам, и
 * протокол ему безразличен; в вебе на HTTPS-странице такую схему заблокирует
 * браузер — это чинится проксированием на нашей стороне, а не здесь.
 */
export function schemeImageUrl(epc: string | null, imgAddress: string | null): string | null {
  if (!epc || !imgAddress) return null
  return `${VIN17_IMAGE_BASE_URL}/${encodeURIComponent(epc)}/${encodeURIComponent(imgAddress)}`
}
