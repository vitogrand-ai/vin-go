import type { Part, Vehicle } from '@web-app-demo/contracts'

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
 * Семантика ошибок сохраняется: «не найдено» у одного источника → пробуем
 * следующий; если ни один не нашёл, но были сбои (AppError) — пробрасываем сбой,
 * чтобы отказ upstream не замаскировался под «VIN не найден».
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

    for (const { name, provider } of ordered) {
      try {
        const vehicle = await provider.decodeVin(vin)
        if (vehicle) return tagSource(vehicle, name)
      } catch (error) {
        // Источник упал — пробуем следующий, но запоминаем первый сбой.
        console.error(`[catalog:${name}] decodeVin упал, пробуем следующий источник`, error)
        firstError ??= error
      }
    }

    // Все источники честно ответили «не найдено» → это чистый 404.
    if (firstError === null) return null
    // Никто не нашёл, но были отказы — не выдаём сбой upstream за «не найдено».
    throw firstError
  }

  async searchParts(vehicle: Vehicle, query: string): Promise<Part[]> {
    const source = readSource(vehicle)
    const origin = source ? this.providers.find((p) => p.name === source) : undefined

    // Каталог, определивший авто, спрашивается первым: номера деталей
    // каталог-специфичны, и у «владельца» самая точная применимость. Но если
    // он деталь не нашёл (живой случай: 17vin опознал Subaru, а колодок по
    // китайскому словарю не нашёл) — пробуем остальные источники: каждый
    // адаптер сам переопределяет чужое авто по VIN перед поиском.
    const ordered = origin
      ? [origin, ...this.providers.filter((p) => p !== origin)]
      : this.providers

    let firstError: unknown = null
    const asked = new Set<NamedCatalogProvider>()
    for (const source of ordered) {
      asked.add(source)
      try {
        const parts = await source.provider.searchParts(vehicle, query)
        if (parts.length > 0) return this.attachImages(vehicle, query, parts, asked)
      } catch (error) {
        console.error(`[catalog:${source.name}] searchParts упал, пробуем следующий источник`, error)
        firstError ??= error
      }
    }

    // Никто не нашёл, но были отказы — не выдаём сбой upstream за «не найдено».
    if (firstError !== null) throw firstError
    return []
  }

  /**
   * Добор схем узлов. Схему отдаёт не каждый каталог (17vin — никогда), а
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
  ): Promise<Part[]> {
    if (parts.some((part) => part.imageUrl)) return parts

    for (const source of this.providers) {
      if (!source.providesImages || asked.has(source)) continue
      asked.add(source)
      let donors: Part[]
      try {
        donors = await source.provider.searchParts(vehicle, query)
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
