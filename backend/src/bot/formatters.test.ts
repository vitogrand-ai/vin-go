import { describe, expect, test } from 'bun:test'
import type { Offer, OrderDto, Part, TierPick } from '@web-app-demo/contracts'

import { formatVehicle, offersMessage, partsMessage } from './formatters'

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

describe('offersMessage — карточка детали над ценами', () => {
  test('замена номера, количество, примечание и период попадают в сообщение', () => {
    const text = offersMessage('8415252100', PICKS, [OFFER], undefined, {
      name: 'Прокладка крышки маслофильтра',
      quantity: 2,
      replacedBy: '8415252101',
      note: 'GRJ150..TX',
      appliesPeriod: '05.2010 — 11.2013',
    })
    expect(text).toContain('Прокладка крышки маслофильтра')
    expect(text).toContain('8415252101')
    expect(text).toContain('2 шт')
    expect(text).toContain('GRJ150..TX')
    expect(text).toContain('05.2010 — 11.2013')
    // Замена — раньше цен: заказ по старому номеру не найдётся.
    expect(text.indexOf('8415252101')).toBeLessThan(text.indexOf('Оптимальный'))
  })

  test('одна штука на машину — строка про количество не печатается', () => {
    const text = offersMessage('1J0698151', PICKS, [OFFER], undefined, {
      name: 'Колодки',
      quantity: 1,
    })
    expect(text).toContain('Колодки')
    expect(text).not.toContain('шт')
  })

  test('цена у дилера — ориентир с рынком и валютой, не цена покупки', () => {
    const price = { min: 43800, max: 48100, currency: 'CNY' as const, market: 'CN' as const, dealers: 3 }
    const text = offersMessage('1565038020', PICKS, [OFFER], undefined, undefined, price)
    expect(text).toContain('438–481 ¥')
    expect(text).toContain('в Китае')
    expect(text).toContain('ориентир')
  })

  test('поставщики молчат — цена дилера всё равно видна', () => {
    const price = { min: 34582, max: 34582, currency: 'CNY' as const, market: 'CN' as const, dealers: 1 }
    const text = offersMessage('000098713A', [], [], undefined, undefined, price)
    expect(text).toContain('Предложений не найдено')
    expect(text).toContain('345,82 ¥')
  })

  test('каталог ничего не рассказал — сообщение как раньше', () => {
    const text = offersMessage('1J0698151', PICKS, [OFFER])
    expect(text).toContain('Всего предложений: 1')
    expect(text).not.toContain('🔁')
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

describe('ordersMessage — номер заказа', () => {
  test('показывает сквозной номер, тот же, что в кабинете и смете', async () => {
    const { ordersMessage } = await import('./formatters')
    const order = {
      id: '0192abcd-0000-7000-8000-000000000000',
      number: 17,
      status: 'PLACED',
      paymentStatus: 'NONE',
      vehicleVin: null,
      vehicle: null,
      customer: null,
      notes: null,
      reception: { dueAt: null, complaint: null, conditionNotes: null, plate: null, mileageKm: null },
      acceptedBy: null,
      items: [],
      itemCount: 0,
      works: [],
      total: { amount: 123400, currency: 'RUB' },
      saleTotal: { amount: 0, currency: 'RUB' },
      worksTotal: { amount: 0, currency: 'RUB' },
      grandTotal: { amount: 0, currency: 'RUB' },
      marginTotal: { amount: 0, currency: 'RUB' },
      createdAt: '2026-09-16T00:00:00.000Z',
      placedAt: null,
    } satisfies OrderDto
    const text = ordersMessage([order])
    expect(text).toContain('№ 17')
    expect(text).not.toContain('0192ABCD')
  })
})

describe('partsMessage — исполнения одной позиции', () => {
  const battery = (oemNumber: string, note: string | null, appliesPeriod: string | null = null): Part => ({
    oemNumber,
    name: 'Батарея аккумуляторная',
    category: 'АКБ',
    brand: 'Ford',
    schemeId: 'FORD-10655',
    position: '10655',
    note,
    appliesPeriod,
  })

  test('одинаковые названия различаются примечанием прямо в выдаче и есть подсказка, с чем сверять', () => {
    // Живой Ford Mondeo: пять кнопок «Батарея аккумуляторная» без ёмкости —
    // мастер уходил снимать шильдик и искать номер в чужом каталоге.
    const { text } = partsMessage([
      battery('1935737', 'АккумулЯтор; 390 Amp; 43 AH', 'с 29.09.2014'),
      battery('1917577', 'АккумулЯтор; 75AH; 700A', '29.09.2014 — 05.10.2018'),
      battery('1712276', null),
    ])
    expect(text).toContain('1935737')
    expect(text).toContain('43 AH')
    expect(text).toContain('75AH; 700A')
    expect(text).toContain('29.09.2014 — 05.10.2018')
    expect(text).toMatch(/сверьте/i)
    // Каталог про исполнение ничего не сказал — это говорится прямо.
    expect(text).toMatch(/1712276[^\n]*не указал/)
  })

  test('разные детали без исполнений — выдача без лишнего блока', () => {
    const { text } = partsMessage([
      { ...battery('1917577', 'АккумулЯтор; 75AH'), position: '10655' },
      { ...battery('5245802', 'Полка АккумулЯтора'), name: 'Поддон аккумуляторной батареи', position: '10732' },
    ])
    expect(text).not.toMatch(/сверьте/i)
    expect(text).not.toContain('75AH')
  })
})
