import { describe, expect, test } from 'bun:test'

import { AppError } from '../http/errors'
import { EmexSupplierProvider, mapOffers } from './emex-provider'

function stubFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: unknown) => handler(String(input))) as unknown as typeof fetch
}

function providerWith(handler: (url: string) => Response): EmexSupplierProvider {
  return new EmexSupplierProvider({
    apiKey: 'demo-key',
    baseUrl: 'https://api.emex.test',
    fetchImpl: stubFetch(handler),
  })
}

const OEM = '1J0698151'

describe('EmexSupplierProvider.getOffers', () => {
  test('маппит предложения: цена в копейках, id с префиксом EMEX', async () => {
    const provider = providerWith(() =>
      new Response(
        JSON.stringify({
          offers: [
            { brand: 'Bosch', number: '0986494104', price: 3120.4, quantity: 3, deliveryDays: 1 },
          ],
        }),
        { status: 200 },
      ),
    )

    const offers = await provider.getOffers(OEM)
    expect(offers).toHaveLength(1)
    const offer = offers[0]!
    expect(offer.price.amount).toBe(312040)
    expect(offer.id.startsWith('EMEX-')).toBe(true)
    expect(offer.quality).toBe('PREMIUM') // Bosch — из справочника брендов
    expect(offer.inStock).toBe(true)
  })

  test('404 → пустой список (нет предложений — это не ошибка)', async () => {
    const provider = providerWith(() => new Response('', { status: 404 }))
    expect(await provider.getOffers(OEM)).toEqual([])
  })

  test('сетевой сбой → бросок AppError(502), а не пустой список', async () => {
    const provider = new EmexSupplierProvider({
      apiKey: 'demo-key',
      baseUrl: 'https://api.emex.test',
      fetchImpl: (() => {
        throw new Error('ECONNRESET')
      }) as unknown as typeof fetch,
    })
    const error = await provider.getOffers(OEM).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).status).toBe(502)
  })
})

describe('mapOffers (Emex)', () => {
  test('запись без цены отбрасывается', () => {
    const offers = mapOffers(OEM, [{ brand: 'A', number: 'X', price: 100 }, { brand: 'B' }])
    expect(offers).toHaveLength(1)
  })

  test('бренд автопроизводителя без флага → оригинал и класс OEM', () => {
    const offers = mapOffers(OEM, [{ brand: 'Volkswagen', number: OEM, price: 9000 }])
    expect(offers[0]!.isOriginal).toBe(true)
    expect(offers[0]!.quality).toBe('OEM')
  })
})
