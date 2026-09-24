import type { CatalogTreeNode, Part, SchemeNode, Vehicle } from '@web-app-demo/contracts'

import type { CatalogProvider } from './providers'

/**
 * Композиция нескольких каталогов за одним поиском по VIN — ядро продукта:
 * единого «большого» каталога не существует, поэтому источники агрегируются
 * (напр. acat как широкий primary + PartsIndex под свежих китайцев).
 *
 * decodeVin идёт по источникам по порядку до первого, кто опознал VIN. Источник,
 * определивший авто, помечается в `vehicle.raw` — searchParts спрашивает его
 * ПЕРВЫМ (номера деталей каталог-специфичны, у «владельца» самая точная
 * применимость), а при пустом ответе добирает по остальным источникам —
 * адаптеры сами переопределяют чужое авто по VIN перед поиском.
 *
 * Семантика ошибок: «не найдено» у одного источника → пробуем следующий. Сбой
 * источника пробрасывается, только если НИ ОДИН источник так и не ответил —
 * тогда «не найдено» было бы выдумкой. Если же хоть один каталог живым вызовом
 * честно сказал «нет такой детали», это и есть ответ, а отказ соседа остаётся в
 * журнале.
 *
 * Различение появилось 22.09.2026, когда истёк тестовый аккаунт 17vin: он
 * отвечал «аккаунт просрочен» на каждый запрос, и любой промах parts-catalogs —
 * по любой машине, не только по той, что знает 17vin, — превращался у мастера в
 * ошибку 502 вместо «ничего не найдено» с кнопкой «Спросить эксперта». Один
 * просроченный ключ выносил поиск целиком. Прежнее правило («был сбой — значит
 * сбой») остаётся в силе там, где оно и писалось: когда источник один или упали
 * все, конец предоплаты под «ничего не найдено» по-прежнему не маскируется.
 */

/** Ключ в vehicle.raw с именем источника, определившего авто. */
export const CATALOG_SOURCE_KEY = '__catalogSource'

export type NamedCatalogProvider = {
  name: string
  provider: CatalogProvider
  /**
   * Источник специализируется на frame-номерах (JDM). Для идентификатора с
   * дефисом такие источники опрашиваются ПЕРВЫМИ — не жжём вызовы (и деньги)
   * широких каталогов, которые по frame заведомо ответят «не найдено».
   */
  framePriority?: boolean
  /**
   * Источник отдаёт схемы узлов (`Part.imageUrl`). Если деталь нашёл источник
   * без картинок, у такого источника добираются схемы по OEM-номеру —
   * см. `searchParts`.
   */
  providesImages?: boolean
  /**
   * Источник только расшифровывает VIN (декодер vPIC), деталей у него не
   * бывает. В поиск деталей не включается: его вечное «пусто» — не честное
   * «нет такой детали» и не должно маскировать сбой настоящих каталогов
   * (см. семантику ошибок выше).
   */
  decodeOnly?: boolean
}

/** Frame-номер кузова (SXA10-0012345) отличается от VIN наличием дефиса. */
function isFrame(id: string): boolean {
  return id.includes('-')
}

export class FallbackCatalogProvider implements CatalogProvider {
  private readonly providers: NamedCatalogProvider[]

  constructor(providers: NamedCatalogProvider[]) {
    if (providers.length === 0) {
      throw new Error('FallbackCatalogProvider требует хотя бы один источник')
    }
    this.providers = providers
  }

  async decodeVin(vin: string): Promise<Vehicle | null> {
    let firstError: unknown = null

    // Frame-номер → сначала JDM-источники, затем остальные (стабильный порядок).
    const ordered = isFrame(vin)
      ? [...this.providers].sort((a, b) => Number(b.framePriority ?? false) - Number(a.framePriority ?? false))
      : this.providers

    let answered = false
    for (const [index, { name, provider }] of ordered.entries()) {
      try {
        const vehicle = await provider.decodeVin(vin)
        answered = true
        // Источники до этого честно ответили «не найдено» — добираем у тех,
        // кого ещё не спрашивали.
        if (vehicle) return this.fillMissingFacts(tagSource(vehicle, name), vin, ordered.slice(index + 1))
      } catch (error) {
        // Источник упал — пробуем следующий, но запоминаем первый сбой.
        console.error(`[catalog:${name}] decodeVin упал, пробуем следующий источник`, error)
        firstError ??= error
      }
    }

    // Хоть один каталог живым вызовом сказал «такой машины нет» → это 404.
    if (answered || firstError === null) return null
    // Не ответил никто — не выдаём сбой upstream за «не найдено».
    throw firstError
  }

  /**
   * Добор года (и заодно двигателя с кузовом) у оставшихся источников.
   *
   * Зачем: год есть не в каждом каталоге. Живой случай — европейский Mercedes:
   * в VIN год не закодирован вовсе, а parts-catalogs в /car/info по нему не
   * отдаёт ни параметра `year`, ни года в criteria/description. Мастеру же год
   * нужен, чтобы узнать машину, — и другой источник его знает (17vin: «…
   * Dynamic Type 2019»). Поэтому карточку без года достраиваем, а не показываем
   * как есть.
   *
   * Марка, модель и `raw` остаются от источника, опознавшего VIN: по его
   * координатам идёт поиск деталей. Чужой ответ трогает только пустые поля.
   *
   * Лишний вызов стоит денег (17vin — $0.15 за VIN), поэтому идём за добором
   * только при отсутствующем годе и только в источники, ещё не отвечавшие по
   * этому VIN. Результат кладётся в кэш VIN — платим раз на машину, а не раз
   * на запрос.
   */
  private async fillMissingFacts(
    vehicle: Vehicle,
    vin: string,
    rest: NamedCatalogProvider[],
  ): Promise<Vehicle> {
    if (vehicle.year) return vehicle

    for (const { name, provider } of rest) {
      let other: Vehicle | null
      try {
        other = await provider.decodeVin(vin)
      } catch (error) {
        // Добор — не основная расшифровка: сбой источника не ломает карточку.
        console.warn(`[catalog:${name}] добор года упал, карточка без года`, error)
        continue
      }
      if (!other?.year) continue
      return {
        ...vehicle,
        year: other.year,
        engine: vehicle.engine ?? other.engine,
        bodyType: vehicle.bodyType ?? other.bodyType,
      }
    }
    return vehicle
  }

  async searchParts(vehicle: Vehicle, query: string, original?: string): Promise<Part[]> {
    const source = readSource(vehicle)
    // Чистые декодеры деталей не ищут: даже если авто опознал vPIC (source =
    // 'vpic'), поиск идёт по настоящим каталогам — адаптеры сами
    // переопределяют чужое авто по VIN.
    const searchable = this.providers.filter((p) => !p.decodeOnly)
    const origin = source ? searchable.find((p) => p.name === source) : undefined

    // Каталог, определивший авто, спрашивается первым: номера деталей
    // каталог-специфичны, и у «владельца» самая точная применимость. Но если
    // он деталь не нашёл (живой случай: 17vin опознал Subaru, а колодок по
    // китайскому словарю не нашёл) — пробуем остальные источники: каждый
    // адаптер сам переопределяет чужое авто по VIN перед поиском.
    const ordered = origin
      ? [origin, ...searchable.filter((p) => p !== origin)]
      : searchable

    let firstError: unknown = null
    let answered = false
    const asked = new Set<NamedCatalogProvider>()
    for (const source of ordered) {
      asked.add(source)
      try {
        const parts = await source.provider.searchParts(vehicle, query, original)
        answered = true
        if (parts.length > 0) return this.attachImages(vehicle, query, parts, asked, original)
      } catch (error) {
        console.error(`[catalog:${source.name}] searchParts упал, пробуем следующий источник`, error)
        firstError ??= error
      }
    }

    // Не ответил никто — не выдаём сбой upstream за «не найдено».
    if (!answered && firstError !== null) throw firstError
    return []
  }

  /**
   * Весь узел по идентификатору схемы. Спрашиваем источник, который эту схему
   * и прислал (`Part.schemeId` каталог-специфичен, чужому он ничего не значит):
   * это тот же источник, что определил авто, либо единственный со схемами.
   */
  async schemeParts(vehicle: Vehicle, schemeId: string): Promise<Part[]> {
    const source = readSource(vehicle)
    const ordered = [
      ...this.providers.filter((p) => p.name === source),
      ...this.providers.filter((p) => p.name !== source && p.providesImages),
    ]
    for (const { name, provider } of ordered) {
      if (!provider.schemeParts) continue
      try {
        const parts = await provider.schemeParts(vehicle, schemeId)
        if (parts.length > 0) return parts
      } catch (error) {
        console.error(`[catalog:${name}] узел по схеме не открылся`, error)
      }
    }
    return []
  }

  /**
   * Дерево узлов машины — у каталога, опознавшего авто, если он дерево умеет,
   * иначе у первого, кто умеет. Дерево не склеивается из нескольких
   * источников: идентификаторы узлов каталог-специфичны, и схемы листа
   * (`branchSchemes`) спрашиваются у того же каталога тем же выбором.
   */
  async catalogTree(vehicle: Vehicle): Promise<CatalogTreeNode[]> {
    const source = this.treeSource(vehicle)
    return source?.provider.catalogTree ? source.provider.catalogTree(vehicle) : []
  }

  async branchSchemes(vehicle: Vehicle, branchId: string): Promise<SchemeNode[]> {
    const source = this.treeSource(vehicle)
    return source?.provider.branchSchemes ? source.provider.branchSchemes(vehicle, branchId) : []
  }

  private treeSource(vehicle: Vehicle): NamedCatalogProvider | undefined {
    const withTree = this.providers.filter((p) => !p.decodeOnly && p.provider.catalogTree)
    return withTree.find((p) => p.name === readSource(vehicle)) ?? withTree[0]
  }

  /**
   * Добор схем узлов. Схему отдаёт не каждый каталог, а
   * мастеру она нужна, чтобы увидеть, ту ли деталь он выбирает. Если в выдаче
   * нет ни одной картинки, спрашиваем тот же запрос у источников с
   * `providesImages` (кроме уже опрошенных — они на этот запрос ответили
   * пусто) и переносим картинки на детали с тем же OEM-номером. Состав и
   * порядок выдачи не меняются: номера каталог-специфичны, чужие детали
   * подмешивать нельзя. Сбой иллюстратора выдачу не ломает — уходит без схемы.
   */
  private async attachImages(
    vehicle: Vehicle,
    query: string,
    parts: Part[],
    asked: Set<NamedCatalogProvider>,
    original?: string,
  ): Promise<Part[]> {
    if (parts.some((part) => part.imageUrl)) return parts

    for (const source of this.providers) {
      if (!source.providesImages || asked.has(source)) continue
      asked.add(source)
      let donors: Part[]
      try {
        donors = await source.provider.searchParts(vehicle, query, original)
      } catch (error) {
        console.warn(`[catalog:${source.name}] добор схем упал, выдача без картинок`, error)
        continue
      }
      const enriched = mergeImagesByOem(parts, donors)
      if (enriched.some((part) => part.imageUrl)) return enriched
    }
    return parts
  }
}

/** Переносит `imageUrl` доноров на детали с тем же OEM-номером. */
function mergeImagesByOem(parts: Part[], donors: Part[]): Part[] {
  const images = new Map<string, string>()
  for (const donor of donors) {
    if (donor.imageUrl && !images.has(oemKey(donor.oemNumber))) {
      images.set(oemKey(donor.oemNumber), donor.imageUrl)
    }
  }
  if (images.size === 0) return parts
  return parts.map((part) => {
    const imageUrl = images.get(oemKey(part.oemNumber))
    return imageUrl ? { ...part, imageUrl } : part
  })
}

/**
 * OEM-номер как ключ сопоставления между каталогами: один и тот же номер
 * приходит «26296-AA060» из одного источника и «26296AA060» из другого.
 */
function oemKey(oemNumber: string): string {
  return oemNumber.replace(/[^0-9a-z]/gi, '').toUpperCase()
}

/** Помечает источник в raw, не теряя остальные поля. */
function tagSource(vehicle: Vehicle, name: string): Vehicle {
  return { ...vehicle, raw: { ...(vehicle.raw ?? {}), [CATALOG_SOURCE_KEY]: name } }
}

function readSource(vehicle: Vehicle): string | null {
  const value = vehicle.raw?.[CATALOG_SOURCE_KEY]
  return typeof value === 'string' ? value : null
}
