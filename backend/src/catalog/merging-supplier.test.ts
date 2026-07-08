import { describe, expect, test } from 'bun:test'

import type { Offer } from '@web-app-demo/contracts'

import { MergingSupplierProvider } from './merging-supplier'
import type { SupplierProvider } from './providers'

function offer(id: string, priceRub: number): Offer {
  return {
    id,
    oemNumber: '1J0698151',
    brand: 'TRW',
    articleNumber: 'GDB1330',
    name: `Предложение ${id}`,
    price: { amount: priceRub * 100, currency: 'RUB' },
    quality: 'AFTERMARKET',
    isOriginal: false,
    inStock: true,
    quantityAvailable: 1,
    deliveryDays: 1,
    supplierName: 'Тест',
  }
}

function fakeSupplier(behavior: () => Promise<Offer[]>): SupplierProvider {
  return { getOffers: behavior }
}

describe('MergingSupplierProvider', () => {
  test('сливает выдачи всех поставщиков в один список', async () => {
    const merged = new MergingSupplierProvider([
      { name: 'abcp', provider: fakeSupplier(async () => [offer('ABCP-1', 2000)]) },
      { name: 'emex', provider: fakeSupplier(async () => [offer('EMEX-1', 1800)]) },
    ])

    const offers = await merged.getOffers('1J0698151')
    expect(offers.map((o) => o.id).sort()).toEqual(['ABCP-1', 'EMEX-1'])
  })

  test('упавший поставщик не валит сравнение — возвращаем собранное', async () => {
    const merged = new MergingSupplierProvider([
      {
        name: 'abcp',
        provider: fakeSupplier(async () => {
          throw new Error('abcp down')
        }),
      },
      { name: 'emex', provider: fakeSupplier(async () => [offer('EMEX-1', 1800)]) },
    ])

    const offers = await merged.getOffers('1J0698151')
    expect(offers).toHaveLength(1)
    expect(offers[0]!.id).toBe('EMEX-1')
  })

  test('все упали → пробрасываем первый сбой (не маскируем под «нет предложений»)', async () => {
    const boom = new Error('abcp down')
    const merged = new MergingSupplierProvider([
      {
        name: 'abcp',
        provider: fakeSupplier(async () => {
          throw boom
        }),
      },
      {
        name: 'emex',
        provider: fakeSupplier(async () => {
          throw new Error('emex down')
        }),
      },
    ])

    expect(merged.getOffers('1J0698151')).rejects.toBe(boom)
  })

  test('все честно ответили пусто → пустой список без ошибки', async () => {
    const merged = new MergingSupplierProvider([
      { name: 'abcp', provider: fakeSupplier(async () => []) },
      { name: 'emex', provider: fakeSupplier(async () => []) },
    ])
    expect(await merged.getOffers('1J0698151')).toEqual([])
  })

  test('пустой список источников недопустим', () => {
    expect(() => new MergingSupplierProvider([])).toThrow()
  })
})
