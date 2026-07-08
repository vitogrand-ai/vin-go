import { describe, expect, test } from 'bun:test'

import { AbcpSupplierProvider, mapOffers } from './abcp-provider'
import { AppError } from '../http/errors'

/** Стаб fetch: отвечает заданной функцией, без реальной сети. */
function stubFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: unknown) => handler(String(input))) as unknown as typeof fetch
}

function providerWith(handler: (url: string) => Response): AbcpSupplierProvider {
  return new AbcpSupplierProvider({
    login: 'shop',
    password: 'secret',
    baseUrl: 'https://api.abcp.test',
    fetchImpl: stubFetch(handler),
  })
}

const OEM = '1J0698151'

describe('AbcpSupplierProvider.getOffers', () => {
  test('маппит предложения: цена в копейках, наличие из количества, срок в днях', async () => {
    const provider = providerWith(() =>
      new Response(
        JSON.stringify([
          {
            brand: 'TRW',
            number: 'GDB1330',
            description: 'Колодки тормозные',
            price: 2450.5,
            availability: 7,
            deliveryPeriod: 2,
          },
        ]),
        { status: 200 },
      ),
    )

    const offers = await provider.getOffers(OEM)
    expect(offers).toHaveLength(1)
    const offer = offers[0]!
    expect(offer.price.amount).toBe(245050) // 2450.5 ₽ → копейки
    expect(offer.price.currency).toBe('RUB')
    expect(offer.inStock).toBe(true)
    expect(offer.quantityAvailable).toBe(7)
    expect(offer.deliveryDays).toBe(2)
    expect(offer.brand).toBe('TRW')
    expect(offer.oemNumber).toBe(OEM)
  })

  test('пустой ответ → пустой список', async () => {
    const provider = providerWith(() => new Response('', { status: 200 }))
    expect(await provider.getOffers(OEM)).toEqual([])
  })

  test('404 → пустой список (нет предложений — это не ошибка)', async () => {
    const provider = providerWith(() => new Response('not found', { status: 404 }))
    expect(await provider.getOffers(OEM)).toEqual([])
  })

  test('сетевой сбой → бросок AppError(502), а НЕ пустой список', async () => {
    const provider = new AbcpSupplierProvider({
      login: 'shop',
      password: 'secret',
      baseUrl: 'https://api.abcp.test',
      fetchImpl: (() => {
        throw new Error('ECONNRESET')
      }) as unknown as typeof fetch,
    })
    const error = await provider.getOffers(OEM).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).status).toBe(502)
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

  test('читает вложенный articles и флаг is_original', () => {
    const offers = mapOffers(OEM, {
      articles: [{ brand: 'OEM', number: OEM, price: 5000, is_original: true }],
    })
    expect(offers).toHaveLength(1)
    expect(offers[0]!.isOriginal).toBe(true)
  })

  test('нулевое количество → не в наличии', () => {
    const offers = mapOffers(OEM, [{ brand: 'A', number: 'X', price: 100, availability: 0 }])
    expect(offers[0]!.inStock).toBe(false)
    expect(offers[0]!.quantityAvailable).toBe(0)
  })

  test('бренд автопроизводителя без флага → оригинал и класс OEM', () => {
    const offers = mapOffers(OEM, [{ brand: 'Toyota', number: OEM, price: 5000 }])
    expect(offers[0]!.isOriginal).toBe(true)
    expect(offers[0]!.quality).toBe('OEM')
  })

  test('явный флаг оригинала имеет приоритет над брендом', () => {
    const offers = mapOffers(OEM, [{ brand: 'Toyota', number: OEM, price: 5000, is_original: false }])
    expect(offers[0]!.isOriginal).toBe(false)
  })
})
