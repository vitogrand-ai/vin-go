import { describe, expect, test } from 'bun:test'

import type { DealerPrice } from '@web-app-demo/contracts'

import { CachingDealerPriceProvider } from './dealer-price-cache'

const PRICE: DealerPrice = { min: 43800, max: 48100, currency: 'CNY', market: 'CN', dealers: 3 }

/** Источник, который считает платные вызовы. */
function countingSource(answer: DealerPrice | null) {
  const calls: string[] = []
  return {
    calls,
    provider: {
      dealerPrice: async (oemNumber: string) => {
        calls.push(oemNumber)
        return answer
      },
    },
  }
}

describe('CachingDealerPriceProvider — платный вызов не повторяется', () => {
  test('повторное открытие той же детали не идёт в источник', async () => {
    const source = countingSource(PRICE)
    const cache = new CachingDealerPriceProvider(source.provider)

    expect(await cache.dealerPrice('1565038020')).toEqual(PRICE)
    expect(await cache.dealerPrice('1565038020')).toEqual(PRICE)
    expect(source.calls).toHaveLength(1)
  })

  test('тот же номер с пробелами и дефисами — тот же ключ', async () => {
    const source = countingSource(PRICE)
    const cache = new CachingDealerPriceProvider(source.provider)

    await cache.dealerPrice('000 098 713 A')
    await cache.dealerPrice('000-098-713a')
    expect(source.calls).toHaveLength(1)
  })

  test('«цены нет» тоже оплачено — не спрашиваем снова', async () => {
    const source = countingSource(null)
    const cache = new CachingDealerPriceProvider(source.provider)

    expect(await cache.dealerPrice('X1')).toBeNull()
    expect(await cache.dealerPrice('X1')).toBeNull()
    expect(source.calls).toHaveLength(1)
  })

  test('через сутки цена запрашивается заново', async () => {
    const source = countingSource(PRICE)
    let clock = 0
    const cache = new CachingDealerPriceProvider(source.provider, 1000, () => clock)

    await cache.dealerPrice('1565038020')
    clock = 1001
    await cache.dealerPrice('1565038020')
    expect(source.calls).toHaveLength(2)
  })

  test('сбой источника не кэшируется — следующий раз спросим снова', async () => {
    let fail = true
    const calls: string[] = []
    const cache = new CachingDealerPriceProvider({
      dealerPrice: async (oemNumber: string) => {
        calls.push(oemNumber)
        if (fail) throw new Error('ECONNRESET')
        return PRICE
      },
    })

    await expect(cache.dealerPrice('1565038020')).rejects.toThrow('ECONNRESET')
    fail = false
    expect(await cache.dealerPrice('1565038020')).toEqual(PRICE)
    expect(calls).toHaveLength(2)
  })
})
