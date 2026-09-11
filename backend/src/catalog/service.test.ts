import { describe, expect, test } from 'bun:test'
import type { Part, Vehicle } from '@web-app-demo/contracts'

import { MockPlateProvider, MockSupplierProvider } from './mock-providers'
import type { CatalogProvider } from './providers'
import { CatalogService, SEARCH_MISS_TAG, createMockCatalogService } from './service'

const VEHICLE: Vehicle = {
  vin: 'WVWZZZ1JZ3W386752',
  make: 'Volkswagen',
  model: 'Golf',
  year: 2003,
  engine: '1.6 MPI',
  bodyType: 'Хэтчбек',
}

const SHRUS: Part = {
  oemNumber: '1K0407271AA',
  name: 'ШРУС наружный',
  category: 'Трансмиссия',
  brand: null,
}

/**
 * Каталог, который знает ТОЛЬКО канонические термины — как настоящий: на
 * «гранатку» он честно отвечает пустотой. Запоминает, что у него спрашивали.
 */
class CanonicalOnlyCatalog implements CatalogProvider {
  readonly asked: string[] = []

  constructor(private readonly knows: string) {}

  async decodeVin(): Promise<Vehicle> {
    return VEHICLE
  }

  async searchParts(_vehicle: Vehicle, query: string): Promise<Part[]> {
    this.asked.push(query)
    return query.toLowerCase().includes(this.knows.toLowerCase()) ? [SHRUS] : []
  }
}

function serviceWith(catalog: CatalogProvider): CatalogService {
  return new CatalogService(catalog, new MockSupplierProvider(), new MockPlateProvider())
}

describe('CatalogService.searchParts — понимание жаргона', () => {
  test('находит по жаргонному запросу, которого каталог не знает', async () => {
    const catalog = new CanonicalOnlyCatalog('шрус')
    const result = await serviceWith(catalog).searchParts(VEHICLE.vin, 'гранатка')

    expect(result.parts).toEqual([SHRUS])
    expect(catalog.asked[0]).toBe('шрус')
  })

  test('сообщает, по какому запросу нашлось, если он отличается от введённого', async () => {
    const catalog = new CanonicalOnlyCatalog('щётка')
    const result = await serviceWith(catalog).searchParts(
      VEHICLE.vin,
      'предложи аналоги дворники',
    )

    expect(result.parts).toHaveLength(1)
    expect(result.resolvedQuery?.toLowerCase()).toContain('щётка стеклоочистителя')
  })

  test('не подсказывает ничего, когда искали ровно как ввели', async () => {
    const catalog = new CanonicalOnlyCatalog('шрус')
    const result = await serviceWith(catalog).searchParts(VEHICLE.vin, 'шрус')

    expect(result.parts).toHaveLength(1)
    expect(result.resolvedQuery).toBeUndefined()
  })

  test('перебор останавливается на первом успешном варианте', async () => {
    const catalog = new CanonicalOnlyCatalog('шрус')
    await serviceWith(catalog).searchParts(VEHICLE.vin, 'гранатка')

    // Лишние варианты — лишние платные вызовы провайдера.
    expect(catalog.asked).toHaveLength(1)
  })

  test('пустая выдача остаётся пустой, все варианты испробованы', async () => {
    const catalog = new CanonicalOnlyCatalog('такого-термина-нет')
    const result = await serviceWith(catalog).searchParts(VEHICLE.vin, 'предложи гранатку')

    expect(result.parts).toEqual([])
    expect(result.vehicle).toEqual(VEHICLE)
    expect(catalog.asked.length).toBeGreaterThan(1)
  })

  test('спрошенная деталь идёт первой, соседи по узлу — следом', async () => {
    // Живой Lexus (17vin): на «крышка гбц» узел приходит в своём порядке —
    // сперва два болта крышки, сама крышка третьей. Мастер жал первую кнопку
    // и получал болт.
    const node = [
      { oemNumber: '9010506359', name: 'BOLT(FOR CYLINDER HEAD COVER)', category: 'ГБЦ', brand: null },
      { oemNumber: '9010906384', name: 'BOLT(FOR CYLINDER HEAD COVER)', category: 'ГБЦ', brand: null },
      { oemNumber: '1120125032', name: 'COVER SUB-ASSY, CYLINDER HEAD', category: 'ГБЦ', brand: null },
      { oemNumber: '1121325020', name: 'GASKET, CYLINDER HEAD COVER', category: 'ГБЦ', brand: null },
    ]
    const catalog: CatalogProvider = {
      async decodeVin() {
        return VEHICLE
      },
      async searchParts() {
        return node
      },
    }

    const result = await serviceWith(catalog).searchParts(VEHICLE.vin, 'крышка гбц')

    expect(result.parts[0]!.oemNumber).toBe('1120125032')
    // Болты не выкинуты — они из того же узла и мастеру могут понадобиться.
    expect(result.parts).toHaveLength(4)
  })

  test('промах уходит в журнал: по нему пополняется словарь', async () => {
    const warnings: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '))
    try {
      await serviceWith(new CanonicalOnlyCatalog('такого-термина-нет')).searchParts(
        VEHICLE.vin,
        'жужжалка',
      )
    } finally {
      console.warn = warn
    }

    const miss = warnings.find((line) => line.includes(SEARCH_MISS_TAG))
    expect(miss).toBeDefined()
    // В строке должно быть всё, чем потом чинят словарь: машина, что спросили
    // и что реально ушло в каталог.
    expect(miss).toContain(VEHICLE.vin)
    expect(miss).toContain('жужжалка')
    expect(miss).toContain('Volkswagen Golf')
  })

  test('находка в журнал промахов не попадает', async () => {
    const warnings: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '))
    try {
      await serviceWith(new CanonicalOnlyCatalog('шрус')).searchParts(VEHICLE.vin, 'гранатка')
    } finally {
      console.warn = warn
    }

    expect(warnings.some((line) => line.includes(SEARCH_MISS_TAG))).toBe(false)
  })

  test('дубли по OEM-номеру схлопываются, картинка добирается из дубля', async () => {
    const catalog: CatalogProvider = {
      async decodeVin() {
        return VEHICLE
      },
      async searchParts() {
        return [
          { oemNumber: 'X1', name: 'Колодки тормозные', category: 'Тормоза', brand: null },
          {
            oemNumber: 'X1',
            name: 'Колодки тормозные',
            category: 'Тормоза',
            brand: null,
            imageUrl: 'https://img.example.com/schema.png',
          },
          { oemNumber: 'X2', name: 'Датчик износа', category: 'Тормоза', brand: null },
        ]
      },
    }

    const result = await serviceWith(catalog).searchParts(VEHICLE.vin, 'колодки')
    expect(result.parts).toHaveLength(2)
    expect(result.parts[0]?.oemNumber).toBe('X1')
    expect(result.parts[0]?.imageUrl).toBe('https://img.example.com/schema.png')
  })

  test('уточнение позиции в запросе отрезает детали противоположной стороны', async () => {
    const catalog: CatalogProvider = {
      async decodeVin() {
        return VEHICLE
      },
      async searchParts() {
        return [
          { oemNumber: 'F1', name: 'Brake pad set, front', category: '', brand: null },
          { oemNumber: 'R1', name: 'Brake-pad sensor, rear', category: '', brand: null },
        ]
      },
    }

    const result = await serviceWith(catalog).searchParts(VEHICLE.vin, 'колодки передние')
    expect(result.parts.map((p) => p.oemNumber)).toEqual(['F1'])
  })

  test('ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ: склонение жаргонизма не распознаётся', async () => {
    // Словарь сопоставляет формы дословно: «гранатка» знает, «гранатку» — нет.
    // Так работал и прототип на пилоте. Лечится либо пополнением словаря
    // падежными формами, либо сопоставлением по стемам, как в part-terms.ts.
    // Тест намеренно фиксирует текущее поведение, чтобы пробел был виден.
    const catalog = new CanonicalOnlyCatalog('шрус')
    const result = await serviceWith(catalog).searchParts(VEHICLE.vin, 'гранатку')

    expect(result.parts).toEqual([])
  })
})

describe('CatalogService — источник данных в ответах', () => {
  test('мок-сервис честно помечает каталог и поставщиков как демо', async () => {
    const service = createMockCatalogService()
    const status = service.status()
    expect(status.catalog.demo).toBe(true)
    expect(status.suppliers.demo).toBe(true)

    const offers = await service.getOffers('1J0698151')
    expect(offers.source).toEqual({ names: ['mock'], demo: true })

    const search = await service.searchParts(VEHICLE.vin, 'колодки')
    expect(search.source?.demo).toBe(true)
  })

  test('с боевыми метаданными ответы несут имена источников', async () => {
    const service = new CatalogService(
      new CanonicalOnlyCatalog('шрус'),
      new MockSupplierProvider(),
      new MockPlateProvider(),
      {
        catalog: { names: ['acat', 'vin17'], demo: false },
        suppliers: { names: ['abcp'], demo: false },
        plates: { names: [], demo: true },
      },
    )
    const offers = await service.getOffers('1J0698151')
    expect(offers.source).toEqual({ names: ['abcp'], demo: false })
    const search = await service.searchParts(VEHICLE.vin, 'шрус')
    expect(search.source?.names).toEqual(['acat', 'vin17'])
  })
})
