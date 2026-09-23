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

  test('не ответил НИКТО → пробрасываем ошибку (не маскируем под 404)', async () => {
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
      {
        name: 'partsindex',
        provider: fakeProvider({
          decode: async () => {
            throw new Error('partsindex down')
          },
        }),
      },
    ])
    expect(fb.decodeVin('VIN1')).rejects.toBe(boom)
  })

  // Живой случай 22.09.2026: истёк тестовый аккаунт 17vin, и он отвечал отказом
  // на каждый запрос. Пока это считалось сбоем всей расшифровки, мастер получал
  // 502 там, где живой каталог честно сказал «такой машины у меня нет».
  test('один источник отказал, другой ответил «нет такой машины» → 404, а не 502', async () => {
    const fb = new FallbackCatalogProvider([
      { name: 'partscatalogs', provider: fakeProvider({ decode: async () => null }) },
      {
        name: 'vin17',
        provider: fakeProvider({
          decode: async () => {
            throw new Error('аккаунт просрочен')
          },
        }),
      },
    ])
    expect(await fb.decodeVin('SAJAA04M6FPU46282')).toBeNull()
  })
})

describe('FallbackCatalogProvider.decodeVin — добор года', () => {
  /** Живой случай: parts-catalogs опознал европейский Mercedes, но года у него нет. */
  const noYear: Vehicle = {
    vin: 'WDD1770871V030773',
    make: 'Mercedes',
    model: 'A-class',
    year: null,
    engine: null,
    bodyType: null,
    raw: { carId: 'car-1' },
  }

  test('год берётся у следующего источника, а марка, модель и raw остаются от владельца', async () => {
    const fb = new FallbackCatalogProvider([
      { name: 'partscatalogs', provider: fakeProvider({ decode: async () => ({ ...noYear }) }) },
      {
        name: 'vin17',
        provider: fakeProvider({
          decode: async () => ({
            ...noYear,
            make: 'Mercedes-Benz',
            model: 'A200',
            year: 2019,
            bodyType: 'Hatchback',
            raw: { epc: 'benz' },
          }),
        }),
      },
    ])

    const vehicle = await fb.decodeVin('WDD1770871V030773')
    expect(vehicle?.year).toBe(2019)
    expect(vehicle?.bodyType).toBe('Hatchback')
    // Поиск деталей идёт по координатам владельца — их добор не подменяет.
    expect(vehicle?.make).toBe('Mercedes')
    expect(vehicle?.model).toBe('A-class')
    expect(vehicle?.raw?.carId).toBe('car-1')
    expect(vehicle?.raw?.[CATALOG_SOURCE_KEY]).toBe('partscatalogs')
  })

  test('год у владельца есть → платный источник не дёргаем', async () => {
    let vin17Calls = 0
    const fb = new FallbackCatalogProvider([
      { name: 'partscatalogs', provider: fakeProvider({ decode: async () => ({ ...baseVehicle }) }) },
      {
        name: 'vin17',
        provider: fakeProvider({
          decode: async () => {
            vin17Calls += 1
            return { ...baseVehicle }
          },
        }),
      },
    ])

    expect((await fb.decodeVin('VIN1'))?.year).toBe(2024)
    expect(vin17Calls).toBe(0)
  })

  test('сбой добора не ломает карточку — отдаём её без года', async () => {
    const fb = new FallbackCatalogProvider([
      { name: 'partscatalogs', provider: fakeProvider({ decode: async () => ({ ...noYear }) }) },
      {
        name: 'vin17',
        provider: fakeProvider({
          decode: async () => {
            throw new Error('vin17 down')
          },
        }),
      },
    ])

    const vehicle = await fb.decodeVin('WDD1770871V030773')
    expect(vehicle?.year).toBeNull()
    expect(vehicle?.raw?.[CATALOG_SOURCE_KEY]).toBe('partscatalogs')
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

  test('не ответил НИКТО → пробрасываем ошибку (не маскируем под пусто)', async () => {
    const boom = new Error('vin17 down')
    const down = (message: string): CatalogProvider => ({
      async decodeVin() {
        return null
      },
      async searchParts(): Promise<Part[]> {
        throw message === 'vin17 down' ? boom : new Error(message)
      },
    })
    const fb = new FallbackCatalogProvider([
      { name: 'vin17', provider: down('vin17 down') },
      { name: 'acat', provider: down('acat down') },
    ])

    const vehicle: Vehicle = { ...baseVehicle, raw: { [CATALOG_SOURCE_KEY]: 'vin17' } }
    expect(fb.searchParts(vehicle, 'колодки')).rejects.toBe(boom)
  })

  // Истёкший ключ одного каталога не должен выносить поиск по всем машинам:
  // мастеру нужна кнопка «Спросить эксперта», а не 502 (живой случай 22.09.2026).
  test('один источник отказал, другой ответил пусто → пусто, а не 502', async () => {
    const fb = new FallbackCatalogProvider([
      { name: 'partscatalogs', provider: fakeProvider({ parts: [] }) },
      {
        name: 'vin17',
        provider: {
          async decodeVin() {
            return null
          },
          async searchParts(): Promise<Part[]> {
            throw new Error('аккаунт просрочен')
          },
        },
      },
    ])

    expect(await fb.searchParts(baseVehicle, 'колодки')).toEqual([])
  })
})

describe('FallbackCatalogProvider.searchParts: схемы узлов', () => {
  const vin17Parts: Part[] = [
    { oemNumber: '26296-AA060', name: 'колодки', category: '', brand: null },
    { oemNumber: '26296AA070', name: 'колодки (вариант)', category: '', brand: null },
    { oemNumber: 'X-NOMATCH', name: 'без пары', category: '', brand: null },
  ]
  const pcParts: Part[] = [
    { oemNumber: '26296AA060', name: 'PAD KIT', category: 'Тормоза', brand: null, imageUrl: 'https://img/1.png' },
    { oemNumber: '26296-AA070', name: 'PAD KIT', category: 'Тормоза', brand: null, imageUrl: 'https://img/2.png' },
  ]

  test('выдача без картинок → схемы добираются у источника-иллюстратора по OEM', async () => {
    const order: string[] = []
    const fb = new FallbackCatalogProvider([
      {
        name: 'partscatalogs',
        provider: fakeProvider({ parts: pcParts, onSearch: () => order.push('partscatalogs') }),
        providesImages: true,
      },
      {
        name: 'vin17',
        provider: fakeProvider({ parts: vin17Parts, onSearch: () => order.push('vin17') }),
      },
    ])

    const vehicle: Vehicle = { ...baseVehicle, raw: { [CATALOG_SOURCE_KEY]: 'vin17' } }
    const parts = await fb.searchParts(vehicle, 'колодки')

    expect(order).toEqual(['vin17', 'partscatalogs'])
    // Состав и порядок выдачи — от нашедшего источника; картинки — по номеру.
    expect(parts.map((p) => [p.oemNumber, p.name, p.imageUrl ?? null])).toEqual([
      ['26296-AA060', 'колодки', 'https://img/1.png'],
      ['26296AA070', 'колодки (вариант)', 'https://img/2.png'],
      ['X-NOMATCH', 'без пары', null],
    ])
  })

  test('иллюстратор уже отвечал «пусто» в этом поиске → второй раз не спрашиваем', async () => {
    const order: string[] = []
    const fb = new FallbackCatalogProvider([
      {
        name: 'partscatalogs',
        provider: fakeProvider({ parts: [], onSearch: () => order.push('partscatalogs') }),
        providesImages: true,
      },
      {
        name: 'vin17',
        provider: fakeProvider({ parts: vin17Parts, onSearch: () => order.push('vin17') }),
      },
    ])

    const vehicle: Vehicle = { ...baseVehicle, raw: { [CATALOG_SOURCE_KEY]: 'partscatalogs' } }
    const parts = await fb.searchParts(vehicle, 'колодки')

    expect(order).toEqual(['partscatalogs', 'vin17'])
    expect(parts).toEqual(vin17Parts)
  })

  test('у выдачи уже есть схема → иллюстратора не трогаем', async () => {
    let donorSearched = false
    const withImage: Part[] = [{ ...vin17Parts[0]!, imageUrl: 'https://img/own.png' }]
    const fb = new FallbackCatalogProvider([
      {
        name: 'partscatalogs',
        provider: fakeProvider({ parts: pcParts, onSearch: () => (donorSearched = true) }),
        providesImages: true,
      },
      { name: 'vin17', provider: fakeProvider({ parts: withImage }) },
    ])

    const vehicle: Vehicle = { ...baseVehicle, raw: { [CATALOG_SOURCE_KEY]: 'vin17' } }
    const parts = await fb.searchParts(vehicle, 'колодки')

    expect(parts).toEqual(withImage)
    expect(donorSearched).toBe(false)
  })

  test('сбой иллюстратора не ломает выдачу — детали уходят без схемы', async () => {
    const fb = new FallbackCatalogProvider([
      {
        name: 'partscatalogs',
        provider: {
          async decodeVin() {
            return null
          },
          async searchParts() {
            throw new Error('partscatalogs down')
          },
        },
        providesImages: true,
      },
      { name: 'vin17', provider: fakeProvider({ parts: vin17Parts }) },
    ])

    const vehicle: Vehicle = { ...baseVehicle, raw: { [CATALOG_SOURCE_KEY]: 'vin17' } }
    const parts = await fb.searchParts(vehicle, 'колодки')

    expect(parts).toEqual(vin17Parts)
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

describe('FallbackCatalogProvider: чистый декодер (decodeOnly, vPIC)', () => {
  test('участвует в расшифровке VIN, когда каталоги машину не знают', async () => {
    const fb = new FallbackCatalogProvider([
      { name: 'partscatalogs', provider: fakeProvider({ decode: async () => null }) },
      { name: 'vpic', provider: fakeProvider({ decode: async () => ({ ...baseVehicle }) }), decodeOnly: true },
    ])

    const vehicle = await fb.decodeVin('VIN1')
    expect(vehicle?.raw?.[CATALOG_SOURCE_KEY]).toBe('vpic')
  })

  test('в поиск деталей не включается — даже когда именно он опознал авто', async () => {
    let vpicAsked = false
    const fb = new FallbackCatalogProvider([
      { name: 'partscatalogs', provider: fakeProvider({ parts: [] }) },
      { name: 'vpic', provider: fakeProvider({ onSearch: () => (vpicAsked = true) }), decodeOnly: true },
    ])

    const vehicle: Vehicle = { ...baseVehicle, raw: { [CATALOG_SOURCE_KEY]: 'vpic' } }
    expect(await fb.searchParts(vehicle, 'колодки')).toEqual([])
    expect(vpicAsked).toBe(false)
  })

  test('его вечное «пусто» не маскирует сбой настоящих каталогов', async () => {
    const boom = new Error('каталог лежит')
    const fb = new FallbackCatalogProvider([
      {
        name: 'partscatalogs',
        provider: fakeProvider({
          onSearch: () => {
            throw boom
          },
        }),
      },
      { name: 'vpic', provider: fakeProvider({ parts: [] }), decodeOnly: true },
    ])

    await expect(fb.searchParts({ ...baseVehicle }, 'колодки')).rejects.toBe(boom)
  })
})
