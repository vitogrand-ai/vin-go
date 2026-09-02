import { describe, expect, test } from 'bun:test'

import type { Part, Vehicle } from '@web-app-demo/contracts'

import { CATALOG_SOURCE_KEY, FallbackCatalogProvider } from './fallback-catalog'
import type { CatalogProvider } from './providers'

const baseVehicle: Omit<Vehicle, 'raw'> = {
  vin: 'VIN1',
  make: 'Chery',
  model: 'Tiggo',
  year: 2024,
  engine: null,
  bodyType: null,
}

/** Мини-провайдер каталога для теста композиции. */
function fakeProvider(behavior: {
  decode?: () => Promise<Vehicle | null>
  parts?: Part[]
  onSearch?: () => void
}): CatalogProvider {
  return {
    async decodeVin() {
      return behavior.decode ? behavior.decode() : null
    },
    async searchParts() {
      behavior.onSearch?.()
      return behavior.parts ?? []
    },
  }
}

describe('FallbackCatalogProvider.decodeVin', () => {
  test('идёт к следующему источнику, когда первый не нашёл, и помечает источник', async () => {
    const fb = new FallbackCatalogProvider([
      { name: 'acat', provider: fakeProvider({ decode: async () => null }) },
      { name: 'partsindex', provider: fakeProvider({ decode: async () => ({ ...baseVehicle }) }) },
    ])

    const vehicle = await fb.decodeVin('VIN1')
    expect(vehicle?.make).toBe('Chery')
    expect(vehicle?.raw?.[CATALOG_SOURCE_KEY]).toBe('partsindex')
  })

  test('сбой первого источника не мешает второму ответить', async () => {
    const fb = new FallbackCatalogProvider([
      {
        name: 'acat',
        provider: fakeProvider({
          decode: async () => {
            throw new Error('acat down')
          },
        }),
      },
      { name: 'partsindex', provider: fakeProvider({ decode: async () => ({ ...baseVehicle }) }) },
    ])

    const vehicle = await fb.decodeVin('VIN1')
    expect(vehicle?.raw?.[CATALOG_SOURCE_KEY]).toBe('partsindex')
  })

  test('все источники ответили «не найдено» → null', async () => {
    const fb = new FallbackCatalogProvider([
      { name: 'acat', provider: fakeProvider({ decode: async () => null }) },
      { name: 'partsindex', provider: fakeProvider({ decode: async () => null }) },
    ])
    expect(await fb.decodeVin('VIN1')).toBeNull()
  })

  test('никто не нашёл, но был сбой → пробрасываем ошибку (не маскируем под 404)', async () => {
    const boom = new Error('acat down')
    const fb = new FallbackCatalogProvider([
      {
        name: 'acat',
        provider: fakeProvider({
          decode: async () => {
            throw boom
          },
        }),
      },
      { name: 'partsindex', provider: fakeProvider({ decode: async () => null }) },
    ])
    expect(fb.decodeVin('VIN1')).rejects.toBe(boom)
  })
})

describe('FallbackCatalogProvider.searchParts', () => {
  test('ищет деталь только в каталоге, который определил авто', async () => {
    let acatSearched = false
    let piSearched = false
    const acatPart: Part = { oemNumber: 'A1', name: 'из acat', category: '', brand: null }
    const piPart: Part = { oemNumber: 'P1', name: 'из partsindex', category: '', brand: null }

    const fb = new FallbackCatalogProvider([
      {
        name: 'acat',
        provider: fakeProvider({ parts: [acatPart], onSearch: () => (acatSearched = true) }),
      },
      {
        name: 'partsindex',
        provider: fakeProvider({ parts: [piPart], onSearch: () => (piSearched = true) }),
      },
    ])

    // Авто определил partsindex → ищем там; нашлось — остальных не трогаем.
    const vehicle: Vehicle = { ...baseVehicle, raw: { [CATALOG_SOURCE_KEY]: 'partsindex' } }
    const parts = await fb.searchParts(vehicle, 'фильтр')

    expect(parts).toEqual([piPart])
    expect(piSearched).toBe(true)
    expect(acatSearched).toBe(false)
  })

  test('каталог-«владелец» не нашёл деталь → добираем по остальным источникам', async () => {
    const order: string[] = []
    const acatPart: Part = { oemNumber: 'A1', name: 'из acat', category: '', brand: null }

    const fb = new FallbackCatalogProvider([
      {
        name: 'acat',
        provider: fakeProvider({ parts: [acatPart], onSearch: () => order.push('acat') }),
      },
      {
        name: 'vin17',
        provider: fakeProvider({ parts: [], onSearch: () => order.push('vin17') }),
      },
    ])

    // Авто определил vin17, но деталь он не нашёл — ответ приходит из acat.
    const vehicle: Vehicle = { ...baseVehicle, raw: { [CATALOG_SOURCE_KEY]: 'vin17' } }
    const parts = await fb.searchParts(vehicle, 'колодки')

    expect(order).toEqual(['vin17', 'acat']) // «владелец» всё равно первым
    expect(parts).toEqual([acatPart])
  })

  test('никто не нашёл, но был сбой → пробрасываем ошибку (не маскируем под пусто)', async () => {
    const boom = new Error('vin17 down')
    const fb = new FallbackCatalogProvider([
      {
        name: 'vin17',
        provider: {
          async decodeVin() {
            return null
          },
          async searchParts() {
            throw boom
          },
        },
      },
      { name: 'acat', provider: fakeProvider({ parts: [] }) },
    ])

    const vehicle: Vehicle = { ...baseVehicle, raw: { [CATALOG_SOURCE_KEY]: 'vin17' } }
    expect(fb.searchParts(vehicle, 'колодки')).rejects.toBe(boom)
  })
})

describe('FallbackCatalogProvider: маршрутизация по формату', () => {
  test('frame-номер идёт сначала в JDM-источник (framePriority)', async () => {
    const order: string[] = []
    const track = (name: string): CatalogProvider =>
      fakeProvider({
        decode: async () => {
          order.push(name)
          return name === 'epcdata' ? { ...baseVehicle, vin: 'SXA10-0012345' } : null
        },
      })

    const fb = new FallbackCatalogProvider([
      { name: 'acat', provider: track('acat') },
      { name: 'partsindex', provider: track('partsindex') },
      { name: 'epcdata', provider: track('epcdata'), framePriority: true },
    ])

    const vehicle = await fb.decodeVin('SXA10-0012345')
    // JDM первым — широкие каталоги даже не вызывались (нашлось сразу).
    expect(order).toEqual(['epcdata'])
    expect(vehicle?.raw?.[CATALOG_SOURCE_KEY]).toBe('epcdata')
  })

  test('обычный VIN сохраняет базовый порядок (широкие каталоги первыми)', async () => {
    const order: string[] = []
    const track = (name: string, found: boolean): CatalogProvider =>
      fakeProvider({
        decode: async () => {
          order.push(name)
          return found ? { ...baseVehicle } : null
        },
      })

    const fb = new FallbackCatalogProvider([
      { name: 'acat', provider: track('acat', true) },
      { name: 'epcdata', provider: track('epcdata', true), framePriority: true },
    ])

    await fb.decodeVin('WVWZZZ1JZ3W386752')
    expect(order).toEqual(['acat'])
  })
})

describe('FallbackCatalogProvider', () => {
  test('пустой список источников недопустим', () => {
    expect(() => new FallbackCatalogProvider([])).toThrow()
  })
})
