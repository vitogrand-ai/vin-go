import { createHash } from 'node:crypto'

import { describe, expect, test } from 'bun:test'

import { AbcpSupplierProvider, extractBrands, mapOffers } from './abcp-provider'
import { AppError } from '../http/errors'

/** Стаб fetch: отвечает заданной функцией, без реальной сети. */
function stubFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: unknown) => handler(String(input))) as unknown as typeof fetch
}

function providerWith(handler: (url: string) => Response): AbcpSupplierProvider {
  return new AbcpSupplierProvider({
    login: 'shop',
    password: 'secret',
    baseUrl: 'https://id123.public.api.abcp.test',
    fetchImpl: stubFetch(handler),
  })
}

const OEM = '1J0698151'

/** Роутер стаба под двухшаговый поиск ABCP: brands → articles?brand=… */
function twoStepFetch(brands: unknown, articlesByBrand: Record<string, unknown>) {
  const calls: string[] = []
  const handler = (url: string): Response => {
    calls.push(url)
    if (url.includes('/search/brands')) return json(brands)
    const brand = new URL(url).searchParams.get('brand') ?? ''
    return json(articlesByBrand[brand] ?? [])
  }
  return { calls, handler }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe('AbcpSupplierProvider.getOffers', () => {
  test('двухшаговый поиск: brands → articles, авторизация в query, срок из часов в дни', async () => {
    const { calls, handler } = twoStepFetch(
      [{ brand: 'TRW', number: OEM, numberFix: OEM }],
      {
        TRW: [
          {
            brand: 'TRW',
            number: 'GDB1330',
            numberFix: 'GDB1330',
            description: 'Колодки тормозные',
            price: 2450.5,
            availability: 7,
            deliveryPeriod: 48, // часы по документации ABCP
            supplierDescription: 'Склад Москва',
          },
        ],
      },
    )

    const offers = await providerWith(handler).getOffers(OEM)

    expect(calls).toHaveLength(2)
    const brandsUrl = new URL(calls[0]!)
    expect(brandsUrl.pathname).toBe('/search/brands')
    expect(brandsUrl.searchParams.get('userlogin')).toBe('shop')
    expect(brandsUrl.searchParams.get('userpsw')).toBe(
      createHash('md5').update('secret').digest('hex'),
    )
    expect(brandsUrl.searchParams.get('number')).toBe(OEM)
    const articlesUrl = new URL(calls[1]!)
    expect(articlesUrl.pathname).toBe('/search/articles')
    expect(articlesUrl.searchParams.get('brand')).toBe('TRW')

    expect(offers).toHaveLength(1)
    const offer = offers[0]!
    expect(offer.price.amount).toBe(245050) // 2450.5 ₽ → копейки
    expect(offer.price.currency).toBe('RUB')
    expect(offer.inStock).toBe(true)
    expect(offer.quantityAvailable).toBe(7)
    expect(offer.deliveryDays).toBe(2) // 48 часов → 2 дня
    expect(offer.brand).toBe('TRW')
    expect(offer.supplierName).toBe('Склад Москва')
    expect(offer.oemNumber).toBe(OEM)
  })

  test('дубли аналогов из выдач разных брендов схлопываются по контентному id', async () => {
    const sharedAnalog = { brand: 'TRW', number: 'GDB1330', price: 2450, availability: 3 }
    const { handler } = twoStepFetch([{ brand: 'VAG' }, { brand: 'TRW' }], {
      VAG: [{ brand: 'VAG', number: OEM, price: 9800, availability: 1 }, sharedAnalog],
      TRW: [sharedAnalog],
    })

    const offers = await providerWith(handler).getOffers(OEM)
    expect(offers).toHaveLength(2)
    expect(new Set(offers.map((o) => o.id)).size).toBe(2)
  })

  test('brands пуст → пустой список без вызова articles', async () => {
    const { calls, handler } = twoStepFetch([], {})
    expect(await providerWith(handler).getOffers(OEM)).toEqual([])
    expect(calls).toHaveLength(1)
  })

  test('404 → пустой список (нет предложений — это не ошибка)', async () => {
    const provider = providerWith(() => new Response('not found', { status: 404 }))
    expect(await provider.getOffers(OEM)).toEqual([])
  })

  test('сетевой сбой → бросок AppError(502), а НЕ пустой список', async () => {
    const provider = new AbcpSupplierProvider({
      login: 'shop',
      password: 'secret',
      baseUrl: 'https://id123.public.api.abcp.test',
      fetchImpl: (() => {
        throw new Error('ECONNRESET')
      }) as unknown as typeof fetch,
    })
    const error = await provider.getOffers(OEM).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).status).toBe(502)
  })
})

describe('extractBrands', () => {
  test('массив структур → бренды без дублей (регистронезависимо)', () => {
    expect(
      extractBrands([{ brand: 'TRW' }, { brand: 'trw' }, { brand: 'Febi' }, { number: 'X' }]),
    ).toEqual(['TRW', 'Febi'])
  })

  test('объект-карта {"0": {…}} тоже разбирается', () => {
    expect(extractBrands({ 0: { brand: 'VAG' }, 1: { brand: 'Febi' } })).toEqual(['VAG', 'Febi'])
  })

  test('не-структуры → пусто', () => {
    expect(extractBrands('oops')).toEqual([])
    expect(extractBrands(null)).toEqual([])
  })
})

describe('mapOffers', () => {
  test('запись без цены отбрасывается', () => {
    const offers = mapOffers(OEM, [
      { brand: 'A', number: 'X', price: 100 },
      { brand: 'B', number: 'Y' }, // нет цены → пропуск
    ])
    expect(offers).toHaveLength(1)
    expect(offers[0]!.brand).toBe('A')
  })

  test('читает вложенный articles', () => {
    const offers = mapOffers(OEM, {
      articles: [{ brand: 'Febi', number: OEM, price: 5000 }],
    })
    expect(offers).toHaveLength(1)
  })

  test('availability: 0 → нет в наличии', () => {
    const offers = mapOffers(OEM, [{ brand: 'A', number: 'X', price: 100, availability: 0 }])
    expect(offers[0]!.inStock).toBe(false)
    expect(offers[0]!.quantityAvailable).toBe(0)
  })

  test('availability -2 («есть, количество скрыто») → в наличии, количество 0', () => {
    const offers = mapOffers(OEM, [{ brand: 'A', number: 'X', price: 100, availability: -2 }])
    expect(offers[0]!.inStock).toBe(true)
    expect(offers[0]!.quantityAvailable).toBe(0)
  })

  test('availability -10 («под заказ») → не в наличии', () => {
    const offers = mapOffers(OEM, [{ brand: 'A', number: 'X', price: 100, availability: -10 }])
    expect(offers[0]!.inStock).toBe(false)
  })

  test('срок в часах округляется в дни вверх: 30 часов → 2 дня', () => {
    const offers = mapOffers(OEM, [
      { brand: 'A', number: 'X', price: 100, deliveryPeriod: 30 },
    ])
    expect(offers[0]!.deliveryDays).toBe(2)
  })

  test('бренд автопроизводителя → оригинал и класс OEM (флага в API ABCP нет)', () => {
    const offers = mapOffers(OEM, [{ brand: 'Toyota', number: OEM, price: 5000 }])
    expect(offers[0]!.isOriginal).toBe(true)
    expect(offers[0]!.quality).toBe('OEM')
  })
})
