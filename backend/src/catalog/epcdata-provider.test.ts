import { describe, expect, test } from 'bun:test'

import { AppError } from '../http/errors'
import { EpcdataCatalogProvider, mapVehicle } from './epcdata-provider'

function stubFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: unknown) => handler(String(input))) as unknown as typeof fetch
}

function providerWith(handler: (url: string) => Response): EpcdataCatalogProvider {
  return new EpcdataCatalogProvider({
    apiKey: 'demo-key',
    baseUrl: 'https://api.epcdata.test',
    fetchImpl: stubFetch(handler),
  })
}

const FRAME = 'SXA10-0012345'
const VIN = 'JTDBR32E430123456'

describe('EpcdataCatalogProvider.decodeVin', () => {
  test('frame-номер уходит параметром frame, VIN — параметром vin', async () => {
    const urls: string[] = []
    const provider = providerWith((url) => {
      urls.push(url)
      return new Response(JSON.stringify({ make: 'Toyota', model: 'RAV4 (SXA10)' }), {
        status: 200,
      })
    })

    await provider.decodeVin(FRAME)
    await provider.decodeVin(VIN)

    expect(urls[0]).toContain(`frame=${encodeURIComponent(FRAME)}`)
    expect(urls[1]).toContain(`vin=${VIN}`)
  })

  test('идентификатором карточки остаётся исходный frame', async () => {
    const provider = providerWith(() =>
      new Response(JSON.stringify({ make: 'Toyota', model: 'RAV4', year: 1996 }), { status: 200 }),
    )
    const vehicle = await provider.decodeVin(FRAME)
    expect(vehicle?.vin).toBe(FRAME)
    expect(vehicle?.make).toBe('Toyota')
  })

  test('404 → null (не найдено — штатно, fallback пойдёт дальше)', async () => {
    const provider = providerWith(() => new Response('', { status: 404 }))
    expect(await provider.decodeVin(FRAME)).toBeNull()
  })

  test('сетевой сбой → бросок AppError(502), а не null', async () => {
    const provider = new EpcdataCatalogProvider({
      apiKey: 'demo-key',
      baseUrl: 'https://api.epcdata.test',
      fetchImpl: (() => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
    })
    const error = await provider.decodeVin(FRAME).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).status).toBe(502)
  })
})

describe('mapVehicle (epcdata)', () => {
  test('нет make и model → null', () => {
    expect(mapVehicle(FRAME, { foo: 'bar' })).toBeNull()
  })
})
