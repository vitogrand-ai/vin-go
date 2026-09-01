import type { Offer, Part, Vehicle } from '@web-app-demo/contracts'

import {
  CATALOG_PARTS,
  KNOWN_PLATES,
  KNOWN_VEHICLES,
  MOCK_BRANDS,
  ORIGINAL_BRAND,
  makeFromVin,
  yearFromVin,
} from './mock-data'
import type { CatalogProvider, PlateProvider, SupplierProvider } from './providers'

/** Детерминированный хеш строки (FNV-1a, 32 бита) — для стабильной генерации цен. */
function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Псевдослучайное число в [0, 1) из seed — для воспроизводимого разброса. */
function seededUnit(seed: number): number {
  const x = Math.sin(seed) * 10000
  return x - Math.floor(x)
}

/**
 * Совпадение слова запроса с токеном каталога: взаимное вхождение с ограничением
 * разницы длин. Допуск в 3 символа покрывает русские окончания («тормозные» ↔
 * «тормоз»), но не даёт «масло» ложно цепляться к «маслоотделитель».
 */
function wordMatches(word: string, token: string): boolean {
  if (Math.abs(word.length - token.length) > 3) return false
  return token.includes(word) || word.includes(token)
}

export class MockCatalogProvider implements CatalogProvider {
  async decodeVin(vin: string): Promise<Vehicle | null> {
    const known = KNOWN_VEHICLES[vin]
    if (known) {
      return { vin, ...known }
    }

    // Неизвестный VIN: карточка по коду WMI и модельному году из 10-го символа.
    return {
      vin,
      make: makeFromVin(vin),
      model: 'Модель не определена (демо)',
      year: yearFromVin(vin) ?? 2000 + (hashString(vin) % 24),
      engine: null,
      bodyType: null,
    }
  }

  async searchParts(_vehicle: Vehicle, query: string): Promise<Part[]> {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) return []

    return CATALOG_PARTS.filter((part) => {
      const tokens = [
        ...part.name.toLowerCase().split(/[\s(),]+/).filter(Boolean),
        part.category.toLowerCase(),
        ...part.keywords,
      ]
      return words.some((word) => tokens.some((token) => wordMatches(word, token)))
    }).map((part) => ({
      oemNumber: part.oemNumber,
      name: part.name,
      category: part.category,
      brand: null,
    }))
  }
}

export class MockPlateProvider implements PlateProvider {
  async resolvePlate(plate: string): Promise<string | null> {
    return KNOWN_PLATES[plate.trim().toUpperCase()] ?? null
  }
}

export class MockSupplierProvider implements SupplierProvider {
  async getOffers(oemNumber: string, _region?: string): Promise<Offer[]> {
    const normalized = oemNumber.trim().toUpperCase()
    if (!normalized) return []

    const seed = hashString(normalized)
    // Базовая стоимость детали в рублях: 700–4700 ₽, стабильна для номера.
    const baseRub = 700 + (seed % 4000)

    const offers: Offer[] = MOCK_BRANDS.map((brand, index) => {
      const jitter = 0.9 + seededUnit(seed + index) * 0.2 // ±10% разброс
      const priceRub = Math.round(baseRub * brand.priceFactor * jitter)
      const stockRoll = seededUnit(seed * 3 + index)
      const inStock = stockRoll > 0.25
      const deliveryDays = inStock ? Math.floor(seededUnit(seed + index * 7) * 3) : 3 + (index % 12)

      return {
        id: `${normalized}-${brand.brand}`,
        oemNumber: normalized,
        brand: brand.brand,
        articleNumber: `${brand.brand.replace(/\s+/g, '').slice(0, 4).toUpperCase()}${seed % 100000}`,
        name: `${brand.brand} ${normalized}`,
        price: { amount: priceRub * 100, currency: 'RUB' },
        quality: brand.quality,
        isOriginal: false,
        inStock,
        quantityAvailable: inStock ? 1 + Math.floor(seededUnit(seed + index) * 20) : 0,
        deliveryDays,
        supplierName: brand.supplierName,
      }
    })

    // Оригинал — дороже всех, всегда есть, но дольше едет.
    const originalRub = Math.round(baseRub * 2.4)
    offers.push({
      id: `${normalized}-ORIGINAL`,
      oemNumber: normalized,
      brand: ORIGINAL_BRAND.brand,
      articleNumber: normalized,
      name: `Оригинал ${normalized}`,
      price: { amount: originalRub * 100, currency: 'RUB' },
      quality: 'OEM',
      isOriginal: true,
      inStock: true,
      quantityAvailable: 5,
      deliveryDays: 5 + (seed % 7),
      supplierName: ORIGINAL_BRAND.supplierName,
    })

    return offers
  }
}
