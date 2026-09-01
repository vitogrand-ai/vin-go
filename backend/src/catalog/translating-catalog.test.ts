import type { Part, Vehicle } from '@web-app-demo/contracts'
import { describe, expect, test } from 'bun:test'

import type { CatalogTranslator } from './catalog-translator'
import type { CatalogProvider } from './providers'
import { TranslatingCatalogProvider } from './translating-catalog'

const vehicle: Vehicle = {
  vin: 'JTEBU5JR9K5123456',
  make: 'Toyota',
  model: 'Land Cruiser Prado',
  year: 2019,
  engine: null,
  bodyType: null,
}

function catalogWith(parts: Part[]): CatalogProvider {
  return {
    decodeVin: async () => vehicle,
    searchParts: async () => parts,
  }
}

function translatorWith(map: Record<string, string>): CatalogTranslator {
  return {
    translate: async () => new Map(Object.entries(map)),
  } as unknown as CatalogTranslator
}

const part: Part = {
  oemNumber: '15620-31060',
  name: 'CAP ASSY, OIL FILTER W/ELEMEMT',
  category: 'ENGINE OIL PUMP & OIL FILTER',
  brand: 'Toyota',
}

describe('TranslatingCatalogProvider.searchParts', () => {
  test('подменяет название и категорию переводом', async () => {
    const provider = new TranslatingCatalogProvider(
      catalogWith([part]),
      translatorWith({
        'CAP ASSY, OIL FILTER W/ELEMEMT': 'Крышка масляного фильтра в сборе',
        'ENGINE OIL PUMP & OIL FILTER': 'Масляный насос и масляный фильтр',
      }),
    )

    const [translated] = await provider.searchParts(vehicle, 'масляный фильтр')

    expect(translated?.name).toBe('Крышка масляного фильтра в сборе')
    expect(translated?.category).toBe('Масляный насос и масляный фильтр')
    expect(translated?.oemNumber).toBe('15620-31060')
  })

  test('непереведённое остаётся как есть', async () => {
    const provider = new TranslatingCatalogProvider(
      catalogWith([part]),
      translatorWith({ 'CAP ASSY, OIL FILTER W/ELEMEMT': 'Крышка масляного фильтра в сборе' }),
    )

    const [translated] = await provider.searchParts(vehicle, 'масляный фильтр')

    expect(translated?.name).toBe('Крышка масляного фильтра в сборе')
    expect(translated?.category).toBe('ENGINE OIL PUMP & OIL FILTER')
  })

  test('пустая выдача не дёргает перевод', async () => {
    let called = false
    const translator = {
      translate: async () => {
        called = true
        return new Map<string, string>()
      },
    } as unknown as CatalogTranslator
    const provider = new TranslatingCatalogProvider(catalogWith([]), translator)

    expect(await provider.searchParts(vehicle, 'масляный фильтр')).toEqual([])
    expect(called).toBe(false)
  })

  test('расшифровка VIN проходит насквозь', async () => {
    const provider = new TranslatingCatalogProvider(catalogWith([part]), translatorWith({}))

    expect(await provider.decodeVin(vehicle.vin)).toEqual(vehicle)
  })
})
