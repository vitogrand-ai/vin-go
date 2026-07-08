import { describe, expect, test } from 'bun:test'

import { AppError } from '../http/errors'
import { PartsIndexCatalogProvider, mapParts, mapVehicle } from './partsindex-provider'

function stubFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: unknown) => handler(String(input))) as unknown as typeof fetch
}

function providerWith(handler: (url: string) => Response): PartsIndexCatalogProvider {
  return new PartsIndexCatalogProvider({
    apiKey: 'demo-key',
    baseUrl: 'https://api.partsindex.test',
    fetchImpl: stubFetch(handler),
  })
}

const CHERY_VIN = 'LVVDB11B7MD012345'

describe('PartsIndexCatalogProvider.decodeVin', () => {
  test('маппит ответ в карточку авто (свежий китаец)', async () => {
    const provider = providerWith(() =>
      new Response(JSON.stringify({ make: 'Chery', model: 'Tiggo 8 Pro Max', year: 2024 }), {
        status: 200,
      }),
    )
    const vehicle = await provider.decodeVin(CHERY_VIN)
    expect(vehicle?.make).toBe('Chery')
    expect(vehicle?.model).toBe('Tiggo 8 Pro Max')
    expect(vehicle?.year).toBe(2024)
  })

  test('404 → null (штатное «VIN не найден»)', async () => {
    const provider = providerWith(() => new Response('', { status: 404 }))
    expect(await provider.decodeVin(CHERY_VIN)).toBeNull()
  })

  test('сетевой сбой → бросок AppError(502), а не null', async () => {
    const provider = new PartsIndexCatalogProvider({
      apiKey: 'demo-key',
      baseUrl: 'https://api.partsindex.test',
      fetchImpl: (() => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
    })
    const error = await provider.decodeVin(CHERY_VIN).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).status).toBe(502)
  })
})

describe('mapVehicle / mapParts', () => {
  test('нет make и model → null', () => {
    expect(mapVehicle('X', { foo: 'bar' })).toBeNull()
  })

  test('маппит список деталей из results', () => {
    const parts = mapParts({ results: [{ number: 'J4210300', name: 'Фильтр масляный' }] })
    expect(parts).toHaveLength(1)
    expect(parts[0]!.oemNumber).toBe('J4210300')
  })
})
