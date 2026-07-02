import { describe, expect, test } from 'bun:test'

import { MockSupplierProvider } from './mock-providers'
import { CachingSupplierProvider } from './offer-cache'

describe('CachingSupplierProvider', () => {
  test('getOffers делегирует внутреннему провайдеру и наполняет снимок', async () => {
    let now = 1000
    const cache = new CachingSupplierProvider(new MockSupplierProvider(), 60_000, () => now)

    const offers = await cache.getOffers('1J0698151')
    expect(offers.length).toBeGreaterThan(0)

    const first = offers[0]!
    // Снимок отдаёт ровно то предложение по его id.
    expect(cache.findOffer(first.id)).toEqual(first)
  })

  test('findOffer возвращает undefined для неизвестного id', async () => {
    const cache = new CachingSupplierProvider(new MockSupplierProvider())
    await cache.getOffers('1J0698151')
    expect(cache.findOffer('не-существует')).toBeUndefined()
  })

  test('снимок протухает по TTL', async () => {
    let now = 0
    const cache = new CachingSupplierProvider(new MockSupplierProvider(), 1000, () => now)
    const [first] = await cache.getOffers('1J0698151')
    expect(cache.findOffer(first!.id)).toBeDefined()

    now = 1001
    expect(cache.findOffer(first!.id)).toBeUndefined()
  })
})
