import { describe, expect, test } from 'bun:test'
import type { Offer, PartQuality } from '@web-app-demo/contracts'

import { selectTiers } from './tiering'

let counter = 0
function offer(overrides: Partial<Offer> & { priceRub: number; quality: PartQuality }): Offer {
  counter += 1
  const { priceRub, ...rest } = overrides
  const base: Offer = {
    id: `offer-${counter}`,
    oemNumber: 'OEM1',
    brand: 'Brand',
    articleNumber: 'ART1',
    name: 'Деталь',
    price: { amount: priceRub * 100, currency: 'RUB' },
    quality: overrides.quality,
    isOriginal: false,
    inStock: true,
    quantityAvailable: 5,
    deliveryDays: 1,
    supplierName: 'Поставщик',
  }
  return { ...base, ...rest }
}

describe('selectTiers', () => {
  test('возвращает три тира в порядке ECONOMY, BALANCED, ORIGINAL', () => {
    const offers: Offer[] = [
      offer({ id: 'budget', priceRub: 500, quality: 'BUDGET' }),
      offer({ id: 'mid', priceRub: 900, quality: 'AFTERMARKET' }),
      offer({ id: 'premium', priceRub: 1500, quality: 'PREMIUM' }),
      offer({ id: 'orig', priceRub: 3000, quality: 'OEM', isOriginal: true }),
    ]

    const picks = selectTiers(offers)
    expect(picks.map((p) => p.tier)).toEqual(['ECONOMY', 'BALANCED', 'ORIGINAL'])
  })

  test('эконом выбирает самый дешёвый неоригинал', () => {
    const offers: Offer[] = [
      offer({ id: 'budget', priceRub: 500, quality: 'BUDGET' }),
      offer({ id: 'mid', priceRub: 900, quality: 'AFTERMARKET' }),
      offer({ id: 'orig', priceRub: 3000, quality: 'OEM', isOriginal: true }),
    ]

    const economy = selectTiers(offers).find((p) => p.tier === 'ECONOMY')
    expect(economy?.offer.id).toBe('budget')
  })

  test('оригинал не попадает в эконом или оптимальный тир', () => {
    const offers: Offer[] = [
      offer({ id: 'budget', priceRub: 500, quality: 'BUDGET' }),
      offer({ id: 'mid', priceRub: 900, quality: 'AFTERMARKET' }),
      offer({ id: 'orig', priceRub: 3000, quality: 'OEM', isOriginal: true }),
    ]

    const picks = selectTiers(offers)
    const economy = picks.find((p) => p.tier === 'ECONOMY')
    const balanced = picks.find((p) => p.tier === 'BALANCED')
    expect(economy?.offer.isOriginal).toBe(false)
    expect(balanced?.offer.isOriginal).toBe(false)
  })

  test('оптимальный отличается от эконома, когда есть выбор', () => {
    const offers: Offer[] = [
      offer({ id: 'budget', priceRub: 500, quality: 'BUDGET' }),
      offer({ id: 'mid', priceRub: 900, quality: 'AFTERMARKET' }),
      offer({ id: 'premium', priceRub: 1500, quality: 'PREMIUM' }),
      offer({ id: 'orig', priceRub: 3000, quality: 'OEM', isOriginal: true }),
    ]

    const picks = selectTiers(offers)
    const economy = picks.find((p) => p.tier === 'ECONOMY')
    const balanced = picks.find((p) => p.tier === 'BALANCED')
    expect(balanced?.offer.id).not.toBe(economy?.offer.id)
  })

  test('предпочитает товары в наличии для эконома', () => {
    const offers: Offer[] = [
      offer({ id: 'cheap-oos', priceRub: 400, quality: 'BUDGET', inStock: false }),
      offer({ id: 'instock', priceRub: 600, quality: 'BUDGET', inStock: true }),
    ]

    const economy = selectTiers(offers).find((p) => p.tier === 'ECONOMY')
    expect(economy?.offer.id).toBe('instock')
  })

  test('пропускает тиры без кандидатов', () => {
    const offers: Offer[] = [offer({ id: 'budget', priceRub: 500, quality: 'BUDGET' })]
    const picks = selectTiers(offers)
    expect(picks.some((p) => p.tier === 'ORIGINAL')).toBe(false)
  })

  test('пустой вход даёт пустой результат', () => {
    expect(selectTiers([])).toEqual([])
  })
})
