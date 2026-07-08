import { describe, expect, test } from 'bun:test'

import type { Vehicle } from '@web-app-demo/contracts'

import { AppError } from '../http/errors'
import { AcatCatalogProvider, mapParts, mapVehicle } from './acat-provider'

/** Стаб fetch: отвечает заданной функцией, без реальной сети. */
function stubFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: unknown) => handler(String(input))) as unknown as typeof fetch
}

function providerWith(handler: (url: string) => Response): AcatCatalogProvider {
  return new AcatCatalogProvider({
    apiKey: 'demo-key',
    baseUrl: 'https://api.acat.test',
    fetchImpl: stubFetch(handler),
  })
}

const CHERY_VIN = 'LVVDB11B7MD012345'
const dummyVehicle: Vehicle = {
  vin: CHERY_VIN,
  make: 'Chery',
  model: 'Tiggo 7 Pro',
  year: 2023,
  engine: null,
  bodyType: null,
}

describe('AcatCatalogProvider.decodeVin', () => {
  test('маппит ответ каталога в карточку авто', async () => {
    const provider = providerWith(() =>
      new Response(
        JSON.stringify({ make: 'Chery', model: 'Tiggo 7 Pro', year: 2023, engine: '1.5 TCI' }),
        { status: 200 },
      ),
    )

    const vehicle = await provider.decodeVin(CHERY_VIN)
    expect(vehicle?.vin).toBe(CHERY_VIN)
    expect(vehicle?.make).toBe('Chery')
    expect(vehicle?.model).toBe('Tiggo 7 Pro')
    expect(vehicle?.year).toBe(2023)
    expect(vehicle?.engine).toBe('1.5 TCI')
  })

  test('404 от каталога → null (штатное «VIN не найден», а не ошибка)', async () => {
    const provider = providerWith(() => new Response('', { status: 404 }))
    expect(await provider.decodeVin(CHERY_VIN)).toBeNull()
  })

  test('сетевой сбой → бросок, а НЕ null (не маскируем под «не найдено»)', async () => {
    const provider = new AcatCatalogProvider({
      apiKey: 'demo-key',
      baseUrl: 'https://api.acat.test',
      fetchImpl: (() => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
    })
    await expect(provider.decodeVin(CHERY_VIN)).rejects.toBeInstanceOf(AppError)
  })

  test('5xx от каталога → AppError со статусом 502', async () => {
    const provider = providerWith(() => new Response('boom', { status: 500 }))
    const error = await provider.decodeVin(CHERY_VIN).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).status).toBe(502)
  })
})

describe('AcatCatalogProvider.searchParts', () => {
  test('маппит список деталей из поля parts', async () => {
    const provider = providerWith(() =>
      new Response(
        JSON.stringify({
          parts: [{ oemNumber: '323105ABA', name: 'Колодки тормозные', category: 'Тормоза' }],
        }),
        { status: 200 },
      ),
    )

    const parts = await provider.searchParts(dummyVehicle, 'колодки')
    expect(parts).toHaveLength(1)
    expect(parts[0]!.oemNumber).toBe('323105ABA')
    expect(parts[0]!.name).toBe('Колодки тормозные')
  })

  test('404 → пустой список, а не ошибка', async () => {
    const provider = providerWith(() => new Response('', { status: 404 }))
    expect(await provider.searchParts(dummyVehicle, 'колодки')).toEqual([])
  })
})

describe('mapVehicle (гибкий разбор формата)', () => {
  test('нет ни make, ни model → null', () => {
    expect(mapVehicle('X', { foo: 'bar' })).toBeNull()
  })

  test('берёт brand/modelName и вложенный vehicle, парсит год из строки', () => {
    const vehicle = mapVehicle('X', {
      vehicle: { brand: 'Haval', modelName: 'Jolion', modelYear: '2024' },
    })
    expect(vehicle?.make).toBe('Haval')
    expect(vehicle?.model).toBe('Jolion')
    expect(vehicle?.year).toBe(2024)
  })
})

describe('mapParts', () => {
  test('пропускает записи без OEM-номера или названия', () => {
    const parts = mapParts({
      items: [
        { oem: 'A1', title: 'Фильтр' },
        { title: 'Без номера' },
        { oem: 'B2' },
      ],
    })
    expect(parts).toHaveLength(1)
    expect(parts[0]!.oemNumber).toBe('A1')
  })
})
