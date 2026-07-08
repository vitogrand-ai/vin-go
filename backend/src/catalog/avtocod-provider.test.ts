import { describe, expect, test } from 'bun:test'

import { AppError } from '../http/errors'
import { AvtocodPlateProvider, mapVin } from './avtocod-provider'

function stubFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: unknown) => handler(String(input))) as unknown as typeof fetch
}

function providerWith(handler: (url: string) => Response): AvtocodPlateProvider {
  return new AvtocodPlateProvider({
    apiKey: 'demo-key',
    baseUrl: 'https://api.avtocod.test',
    fetchImpl: stubFetch(handler),
  })
}

const PLATE = 'А123ВС777'
const VIN = 'WVWZZZ1JZ3W386752'

describe('AvtocodPlateProvider.resolvePlate', () => {
  test('маппит ответ реестра в VIN', async () => {
    const provider = providerWith(() =>
      new Response(JSON.stringify({ vehicle: { vin: VIN } }), { status: 200 }),
    )
    expect(await provider.resolvePlate(PLATE)).toBe(VIN)
  })

  test('404 → null (штатное «госномер не найден»)', async () => {
    const provider = providerWith(() => new Response('', { status: 404 }))
    expect(await provider.resolvePlate(PLATE)).toBeNull()
  })

  test('пустой госномер → null без запроса', async () => {
    let called = false
    const provider = providerWith(() => {
      called = true
      return new Response('{}', { status: 200 })
    })
    expect(await provider.resolvePlate('   ')).toBeNull()
    expect(called).toBe(false)
  })

  test('сетевой сбой → бросок AppError(502), а не null', async () => {
    const provider = new AvtocodPlateProvider({
      apiKey: 'demo-key',
      baseUrl: 'https://api.avtocod.test',
      fetchImpl: (() => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
    })
    const error = await provider.resolvePlate(PLATE).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).status).toBe(502)
  })
})

describe('mapVin', () => {
  test('берёт vin из корня и приводит к верхнему регистру', () => {
    expect(mapVin({ vin: 'wvwzzz1jz3w386752' })).toBe(VIN)
  })

  test('берёт vin_code из вложенного result', () => {
    expect(mapVin({ result: { vin_code: VIN } })).toBe(VIN)
  })

  test('нет VIN в ответе → null', () => {
    expect(mapVin({ vehicle: { make: 'Toyota' } })).toBeNull()
  })

  test('мусорно-короткое значение → null (не скармливаем каталогу)', () => {
    expect(mapVin({ vin: 'X1' })).toBeNull()
  })
})
