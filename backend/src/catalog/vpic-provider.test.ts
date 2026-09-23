import { describe, expect, it } from 'bun:test'

import { AppError } from '../http/errors'
import { hasValidCheckDigit, mapVehicle, VpicCatalogProvider } from './vpic-provider'

/**
 * Живой пример американского VIN с верной контрольной цифрой (Honda Accord,
 * «3» на 9-й позиции — общеизвестный образец из документации NHTSA).
 */
const US_VIN = '1HGCM82633A004352'

/** Тот же номер с испорченной контрольной цифрой. */
const BROKEN_CHECK_VIN = '1HGCM82643A004352'

/** Плоский ответ vPIC DecodeVinValues: все значения — строки, пустое = "". */
function vpicResponse(overrides: Record<string, string> = {}): unknown {
  return {
    Count: 1,
    Results: [
      {
        Make: 'HONDA',
        Model: 'Accord',
        ModelYear: '2003',
        BodyClass: 'Sedan/Saloon',
        DisplacementL: '3.0',
        EngineModel: '',
        ErrorCode: '0',
        ...overrides,
      },
    ],
  }
}

function providerWith(response: unknown, status = 200): { provider: VpicCatalogProvider; calls: string[] } {
  const calls: string[] = []
  const fetchImpl = (async (url: RequestInfo | URL) => {
    calls.push(String(url))
    return new Response(JSON.stringify(response), { status })
  }) as typeof fetch
  return { provider: new VpicCatalogProvider({ baseUrl: 'https://vpic.test/api', fetchImpl }), calls }
}

describe('контрольная цифра VIN (правило рынка США)', () => {
  it('сходится у американского VIN', () => {
    expect(hasValidCheckDigit(US_VIN)).toBe(true)
  })

  it('не сходится при искажении номера', () => {
    expect(hasValidCheckDigit(BROKEN_CHECK_VIN)).toBe(false)
  })

  it('frame-номер и неполный номер — не VIN рынка США', () => {
    expect(hasValidCheckDigit('SXA10-0012345')).toBe(false)
    expect(hasValidCheckDigit('1HGCM826')).toBe(false)
  })
})

describe('VpicCatalogProvider.decodeVin', () => {
  it('расшифровывает американский VIN в карточку', async () => {
    const { provider, calls } = providerWith(vpicResponse())
    const vehicle = await provider.decodeVin(US_VIN)
    expect(vehicle).toMatchObject({
      vin: US_VIN,
      make: 'Honda',
      model: 'Accord',
      year: 2003,
      engine: '3 л',
      bodyType: 'Sedan/Saloon',
    })
    expect(calls[0]).toContain(US_VIN)
  })

  it('VIN с несошедшейся контрольной цифрой отсекает БЕЗ сетевого вызова', async () => {
    const { provider, calls } = providerWith(vpicResponse())
    expect(await provider.decodeVin(BROKEN_CHECK_VIN)).toBeNull()
    expect(calls).toEqual([])
  })

  it('frame-номер отсекает без сетевого вызова', async () => {
    const { provider, calls } = providerWith(vpicResponse())
    expect(await provider.decodeVin('SXA10-0012345')).toBeNull()
    expect(calls).toEqual([])
  })

  it('без марки или модели машина не опознана — null', async () => {
    const { provider } = providerWith(vpicResponse({ Make: '', Model: '' }))
    expect(await provider.decodeVin(US_VIN)).toBeNull()
  })

  it('нечисловой год не выдумывается', async () => {
    const { provider } = providerWith(vpicResponse({ ModelYear: '' }))
    const vehicle = await provider.decodeVin(US_VIN)
    expect(vehicle?.year).toBeNull()
  })

  it('сбой vPIC — это 502, а не «не найдено»', async () => {
    const { provider } = providerWith({}, 500)
    await expect(provider.decodeVin(US_VIN)).rejects.toBeInstanceOf(AppError)
  })
})

describe('vPIC — декодер, не каталог', () => {
  it('searchParts всегда пуст', async () => {
    const { provider } = providerWith(vpicResponse())
    expect(await provider.searchParts()).toEqual([])
  })
})

describe('mapVehicle', () => {
  it('"Not Applicable" считается отсутствующим значением', () => {
    const vehicle = mapVehicle(US_VIN, vpicResponse({ BodyClass: 'Not Applicable' }))
    expect(vehicle?.bodyType).toBeNull()
  })

  it('код модели двигателя предпочитается объёму', () => {
    const vehicle = mapVehicle(US_VIN, vpicResponse({ EngineModel: 'J30A4' }))
    expect(vehicle?.engine).toBe('J30A4')
  })

  it('битый ответ без Results — null', () => {
    expect(mapVehicle(US_VIN, { Message: 'oops' })).toBeNull()
  })
})
