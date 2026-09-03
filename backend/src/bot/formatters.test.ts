import { describe, expect, test } from 'bun:test'
import type { Offer, TierPick } from '@web-app-demo/contracts'

import { formatVehicle, offersMessage } from './formatters'

const OFFER: Offer = {
  id: 'X-1',
  oemNumber: '1J0698151',
  brand: 'Bosch',
  articleNumber: '0986',
  name: 'Bosch 1J0698151',
  price: { amount: 250000, currency: 'RUB' },
  quality: 'PREMIUM',
  isOriginal: false,
  inStock: true,
  quantityAvailable: 3,
  deliveryDays: 1,
  supplierName: 'Демо-склад',
}

const PICKS: TierPick[] = [{ tier: 'BALANCED', offer: OFFER, reason: 'Оптимально' }]

describe('offersMessage — честность про источник цен', () => {
  test('на демо-поставщиках предупреждение стоит перед тирами', () => {
    const text = offersMessage('1J0698151', PICKS, [OFFER], { names: ['mock'], demo: true })
    const warningAt = text.indexOf('Демо-цены')
    const tierAt = text.indexOf('Оптимальный')
    expect(warningAt).toBeGreaterThan(-1)
    expect(warningAt).toBeLessThan(tierAt)
  })

  test('на боевых поставщиках предупреждения нет', () => {
    const text = offersMessage('1J0698151', PICKS, [OFFER], { names: ['abcp'], demo: false })
    expect(text).not.toContain('Демо-цены')
  })

  test('без сведений об источнике (старый вызов) сообщение как раньше', () => {
    const text = offersMessage('1J0698151', PICKS, [OFFER])
    expect(text).not.toContain('Демо-цены')
    expect(text).toContain('Всего предложений: 1')
  })
})

describe('formatVehicle — неизвестный год', () => {
  test('без года строка «Год» не печатается, с годом — печатается', () => {
    const base = {
      vin: 'WDD1770871V030773',
      make: 'Mercedes-Benz',
      model: 'A200',
      engine: '282914',
      bodyType: 'Hatchback',
    }
    expect(formatVehicle({ ...base, year: null })).not.toContain('Год:')
    expect(formatVehicle({ ...base, year: 2019 })).toContain('Год: 2019')
  })
})
