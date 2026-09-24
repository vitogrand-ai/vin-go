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

describe('CatalogService.getOffers — цена оригинала у дилера', () => {
  const PRICE = { min: 43800, max: 48100, currency: 'CNY' as const, market: 'CN' as const, dealers: 3 }

  function serviceWith(dealerPrices?: { dealerPrice: (oem: string) => Promise<typeof PRICE | null> }) {
    return new CatalogService(
      new CanonicalOnlyCatalog('шрус'),
      new MockSupplierProvider(),
      new MockPlateProvider(),
      undefined,
      dealerPrices,
    )
  }

  test('цена дилера идёт рядом с предложениями поставщиков', async () => {
    const offers = await serviceWith({ dealerPrice: async () => PRICE }).getOffers('1J0698151')
    expect(offers.dealerPrice).toEqual(PRICE)
    expect(offers.offers.length).toBeGreaterThan(0)
  })

  test('источник цены упал — предложения поставщиков всё равно приходят', async () => {
    const offers = await serviceWith({
      dealerPrice: async () => {
        throw new Error('17vin 1005: баланс исчерпан')
      },
    }).getOffers('1J0698151')
    expect(offers.dealerPrice).toBeNull()
    expect(offers.offers.length).toBeGreaterThan(0)
  })

  test('источника цены нет (мок, без 17vin) — цены нет, а не выдуманная', async () => {
    const offers = await serviceWith().getOffers('1J0698151')
    expect(offers.dealerPrice).toBeNull()
  })
})

describe('CatalogService.schemeParts', () => {
  const node: Part[] = [
    { oemNumber: '566941015F', name: 'Фара головного света', category: 'Фары', brand: 'Skoda', imageUrl: null, position: '1', schemeId: 'G1' },
    { oemNumber: '565941813F', name: 'Жгут проводов освещения', category: 'Отдельные детали', brand: 'Skoda', imageUrl: null, position: '9', schemeId: 'G1' },
    { oemNumber: '565941813G', name: 'Жгут проводов освещения', category: 'Отдельные детали', brand: 'Skoda', imageUrl: null, position: '9', schemeId: 'G1' },
    // Та же деталь второй строкой применимости — в выдаче должна быть одна.
    { oemNumber: '565941813G', name: 'Жгут проводов освещения', category: 'Отдельные детали', brand: 'Skoda', imageUrl: null, position: '9', schemeId: 'G1' },
  ]

  function serviceWithNode(): CatalogService {
    return new CatalogService(
      {
        decodeVin: async () => VEHICLE,
        searchParts: async () => [],
        schemeParts: async () => node,
      },
      new MockSupplierProvider(),
      new MockPlateProvider(),
    )
  }

  test('номер позиции выбирает детали этой выноски, дубли применимости схлопываются', async () => {
    const found = await serviceWithNode().schemeParts(VEHICLE.vin, 'G1', '9')
    expect(found.parts.map((part) => part.oemNumber)).toEqual(['565941813F', '565941813G'])
  })

  test('без номера позиции отдаётся весь узел — по нему веб рисует кликабельные выноски', async () => {
    const found = await serviceWithNode().schemeParts(VEHICLE.vin, 'G1')
    expect(found.parts.map((part) => `${part.position}:${part.oemNumber}`)).toEqual([
      '1:566941015F',
      '9:565941813F',
      '9:565941813G',
    ])
  })

  test('номер с ведущим нулём (Citroen: «05») находится по присланному «5»', async () => {
    const citroen: Part[] = [
      { oemNumber: '1611860780', name: 'Натяжитель ремня приводного в сборе', category: 'Водяной насос', brand: 'Citroen', imageUrl: null, position: '05', schemeId: 'G2' },
      { oemNumber: '1611860781', name: 'Шкив помпы системы охлаждения', category: 'Водяной насос', brand: 'Citroen', imageUrl: null, position: '03', schemeId: 'G2' },
    ]
    const service = new CatalogService(
      { decodeVin: async () => VEHICLE, searchParts: async () => [], schemeParts: async () => citroen },
      new MockSupplierProvider(),
      new MockPlateProvider(),
    )
    const found = await service.schemeParts(VEHICLE.vin, 'G2', '5')
    expect(found.parts.map((part) => part.oemNumber)).toEqual(['1611860780'])
  })

  test('позиции нет на схеме → пустая выдача, а не чужая деталь', async () => {
    const found = await serviceWithNode().schemeParts(VEHICLE.vin, 'G1', '77')
    expect(found.parts).toEqual([])
  })

  test('каталог не умеет открывать узлы → пусто, без падения', async () => {
    const service = new CatalogService(
      { decodeVin: async () => VEHICLE, searchParts: async () => [] },
      new MockSupplierProvider(),
      new MockPlateProvider(),
    )
    expect((await service.schemeParts(VEHICLE.vin, 'G1', '9')).parts).toEqual([])
  })
})

describe('CatalogService — дубли применимости', () => {
  test('выноска и узел добираются из дубля, как и схема', async () => {
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
            position: '4',
            schemeId: 'G-BRAKE',
            schemeHotspot: { x: 0.2, y: 0.5 },
            quantity: 2,
            replacedBy: 'X1-NEW',
            note: 'GRJ150..TX',
            appliesPeriod: '05.2010 — 11.2013',
          },
        ]
      },
    }

    const result = await serviceWith(catalog).searchParts(VEHICLE.vin, 'колодки')
    expect(result.parts).toHaveLength(1)
    // Подробности каталога лежали у второй строки — после слияния не теряются.
    expect(result.parts[0]).toMatchObject({
      imageUrl: 'https://img.example.com/schema.png',
      position: '4',
      schemeId: 'G-BRAKE',
      schemeHotspot: { x: 0.2, y: 0.5 },
      quantity: 2,
      replacedBy: 'X1-NEW',
      note: 'GRJ150..TX',
      appliesPeriod: '05.2010 — 11.2013',
    })
  })
})

describe('CatalogService.maintenanceParts', () => {
  test('все пункты ТО ищутся, сбой одного не роняет остальные', async () => {
    const service = new CatalogService(
      {
        decodeVin: async () => VEHICLE,
        searchParts: async (_vehicle, query) => {
          if (query.includes('свеч')) throw new Error('каталог лежит')
          return query.includes('масл') ? [{ oemNumber: 'OF1', name: 'Фильтр масляный', category: 'ТО', brand: null }] : []
        },
      },
      new MockSupplierProvider(),
      new MockPlateProvider(),
    )
    const { items } = await service.maintenanceParts(VEHICLE.vin)
    expect(items.map((item) => item.label)).toEqual([
      'Масляный фильтр', 'Воздушный фильтр', 'Салонный фильтр', 'Топливный фильтр', 'Свечи зажигания',
    ])
    expect(items[0]?.parts[0]?.oemNumber).toBe('OF1')
    expect(items[4]).toMatchObject({ failed: true, parts: [] })
    expect(items[1]).toMatchObject({ failed: false, parts: [] })
  })
})
