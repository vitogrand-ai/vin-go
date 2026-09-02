import { describe, expect, test } from 'bun:test'
import type { Part, Vehicle } from '@web-app-demo/contracts'

import { MockPlateProvider, MockSupplierProvider } from './mock-providers'
import type { CatalogProvider } from './providers'
import { CatalogService } from './service'

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
    // падежными формами, либо сопоставлением по стемам, как в part-query-zh.ts.
    // Тест намеренно фиксирует текущее поведение, чтобы пробел был виден.
    const catalog = new CanonicalOnlyCatalog('шрус')
    const result = await serviceWith(catalog).searchParts(VEHICLE.vin, 'гранатку')

    expect(result.parts).toEqual([])
  })
})
