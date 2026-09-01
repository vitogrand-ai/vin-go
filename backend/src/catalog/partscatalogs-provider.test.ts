import { describe, expect, test } from 'bun:test'

import type { Vehicle } from '@web-app-demo/contracts'

import { AppError } from '../http/errors'
import { CATALOG_SOURCE_KEY } from './fallback-catalog'
import {
  PARTSCATALOGS_MAX_PARTS,
  PartsCatalogsCatalogProvider,
  collectParts,
  mapVehicle,
} from './partscatalogs-provider'

/** Стаб fetch: маршрутизирует по URL, запоминает вызовы (url + заголовки). */
function stubFetch(
  handler: (url: string) => Response,
  calls?: { url: string; headers: Record<string, string> }[],
): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    calls?.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> })
    return handler(String(input))
  }) as unknown as typeof fetch
}

function providerWith(
  handler: (url: string) => Response,
  calls?: { url: string; headers: Record<string, string> }[],
): PartsCatalogsCatalogProvider {
  return new PartsCatalogsCatalogProvider({
    apiKey: 'TEST-KEY',
    baseUrl: 'https://api.parts-catalogs.test/v1',
    fetchImpl: stubFetch(handler, calls),
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

const VIN = 'XW8AN2NE3JH035743'

/** Ответ /car/info в формате живого ответа API (сверен реальным вызовом, сент 2026). */
const CAR_INFO = [
  {
    title: 'Octavia',
    catalogId: 'skoda',
    brand: 'Skoda',
    modelId: 'c73916df9a88ab05c3e443deae2399b1',
    carId: 'b6f1737ecdb825af838af2c9aee89486',
    criteria: 'b4*XW8AN2NE3JH035743(2018!aebbed60',
    vin: VIN,
    frame: '',
    modelName: 'Octavia',
    description: '2018-2021. Название комплектации: OCT Octavia',
    optionCodes: [{ code: '0A2', description: 'Двери: 4-дверный' }],
    parameters: [
      { key: 'car_name', name: 'Название', value: 'Octavia', sortOrder: 100 },
      { key: 'year', name: 'Год', value: '2018', sortOrder: 100 },
      { key: 'spec_engine', name: 'Двигатель', value: 'CWVA', sortOrder: 100 },
      { key: 'transmission', name: 'Трансмиссия', value: 'PSU', sortOrder: 100 },
    ],
  },
]

/** Ответ groups-suggest из документации. */
const SUGGEST = [
  { sid: '87', name: 'Engine oil filter' },
  { sid: '433', name: 'Engine oil' },
]

/** Ответ schemas из документации. */
const SCHEMAS = {
  group: null,
  list: [
    {
      groupId: 'GROUP-OIL',
      img: '{IMG_URL}',
      name: 'Lubricat.syst.-oil filter, heat exchanger',
      description: null,
      partNames: [
        { id: '87', name: 'Engine oil filter' },
        { id: '399', name: 'Oil filter cap' },
      ],
    },
  ],
}

/** Ответ parts2 из документации + соседняя деталь узла с чужим nameId. */
const PARTS2 = {
  img: '//ru.img.parts-catalogs.com/bmw_2020_01/data/JPG/502704.png',
  imgDescription: null,
  brand: 'skoda',
  partGroups: [
    {
      number: null,
      positionNumber: null,
      name: null,
      description: '',
      parts: [
        {
          id: '11422469721',
          number: '11422469721',
          nameId: '87',
          name: 'Engine oil filter',
          notice: 'Oil filter',
          description: 'QTY: 1',
          positionNumber: '01',
          url: '',
        },
        {
          id: '17217533476',
          number: '17217533476',
          nameId: '1075',
          name: 'Heat exchanger',
          notice: '',
          description: '',
          positionNumber: '02',
          url: '',
        },
      ],
    },
  ],
  positions: [],
}

describe('PartsCatalogsCatalogProvider.decodeVin', () => {
  test('запрос /car/info с ключом и Accept-Language: ru → карточка авто с координатами в raw', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const provider = providerWith(() => json(CAR_INFO), calls)

    const vehicle = await provider.decodeVin(` ${VIN.toLowerCase()} `)

    expect(calls).toHaveLength(1)
    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/v1/car/info')
    expect(url.searchParams.get('q')).toBe(VIN) // нормализация: trim + верхний регистр
    expect(calls[0]!.headers['Authorization']).toBe('TEST-KEY')
    expect(calls[0]!.headers['Accept-Language']).toBe('ru')

    expect(vehicle).not.toBeNull()
    expect(vehicle!.make).toBe('Skoda')
    expect(vehicle!.model).toBe('Octavia')
    expect(vehicle!.year).toBe(2018) // из parameters key=year
    expect(vehicle!.engine).toBe('CWVA') // из parameters key=spec_engine
    expect(vehicle!.raw?.['catalogId']).toBe('skoda')
    expect(vehicle!.raw?.['carId']).toBe('b6f1737ecdb825af838af2c9aee89486')
    expect(vehicle!.raw?.['criteria']).toBe('b4*XW8AN2NE3JH035743(2018!aebbed60')
  })

  test('пустой массив (VIN не найден) → null, это не ошибка', async () => {
    const provider = providerWith(() => json([]))
    expect(await provider.decodeVin(VIN)).toBeNull()
  })

  test('HTTP 404 → null', async () => {
    const provider = providerWith(() => new Response('', { status: 404 }))
    expect(await provider.decodeVin(VIN)).toBeNull()
  })

  test('HTTP 403 с errorCode 1003 (IP не в allowlist) → AppError(502), а НЕ «не найдено»', async () => {
    // Живой формат ошибки: HTTP 403 + {"code":403,"errorCode":1003,"message":"IP … not allowed"}.
    const provider = providerWith(() =>
      json({ code: 403, errorCode: 1003, message: 'IP 1.2.3.4 not allowed' }, 403),
    )
    const error = await provider.decodeVin(VIN).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).status).toBe(502)
    expect((error as AppError).message).toContain('HTTP 403')
  })

  test('конверт {errorCode: 1004} при HTTP 200 (квота) → AppError(502) с кодом', async () => {
    const provider = providerWith(() => json({ code: 200, errorCode: 1004, message: 'QUOTA_DENY' }))
    const error = await provider.decodeVin(VIN).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).status).toBe(502)
    expect((error as AppError).message).toContain('1004')
  })

  test('сетевой сбой → AppError(502)', async () => {
    const provider = new PartsCatalogsCatalogProvider({
      apiKey: 'TEST-KEY',
      fetchImpl: (() => {
        throw new Error('ECONNRESET')
      }) as unknown as typeof fetch,
    })
    const error = await provider.decodeVin(VIN).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).status).toBe(502)
  })
})

describe('PartsCatalogsCatalogProvider.searchParts', () => {
  /** Роутер стаба: полная цепочка suggest → schemas → parts2 на данных из доков. */
  function chainHandler(url: string): Response {
    if (url.includes('/car/info')) return json(CAR_INFO)
    if (url.includes('/groups-suggest')) return json(SUGGEST)
    if (url.includes('/schemas')) return json(SCHEMAS)
    if (url.includes('/parts2')) return json(PARTS2)
    return new Response('', { status: 404 })
  }

  const vehicle: Vehicle = {
    vin: VIN,
    make: 'Skoda',
    model: 'Octavia',
    year: 2018,
    engine: '1.4 TSI',
    bodyType: null,
    raw: {
      catalogId: 'skoda',
      carId: 'b6f1737ecdb825af838af2c9aee89486',
      criteria: 'b4*XW8AN2NE3JH035743(2018!aebbed60',
      [CATALOG_SOURCE_KEY]: 'partscatalogs',
    },
  }

  test('цепочка suggest → schemas → parts2; выдача отфильтрована по nameId', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const provider = providerWith(chainHandler, calls)

    const parts = await provider.searchParts(vehicle, 'масляный фильтр')

    // Деталь с nameId 87 (искомый sid) прошла, «Heat exchanger» (1075) — нет.
    expect(parts).toEqual([
      {
        oemNumber: '11422469721',
        name: 'Engine oil filter',
        category: 'Lubricat.syst.-oil filter, heat exchanger',
        brand: 'Skoda',
      },
    ])

    // Координаты авто взяты из raw — повторного /car/info не было.
    expect(calls.some((c) => c.url.includes('/car/info'))).toBe(false)

    const suggest = calls.find((c) => c.url.includes('/groups-suggest'))
    expect(suggest).toBeDefined()
    const suggestUrl = new URL(suggest!.url)
    expect(suggestUrl.pathname).toBe('/v1/catalogs/skoda/groups-suggest')
    expect(suggestUrl.searchParams.get('q')).toBe('масляный фильтр')

    const schemas = calls.find((c) => c.url.includes('/schemas'))
    const schemasUrl = new URL(schemas!.url)
    expect(schemasUrl.searchParams.get('carId')).toBe('b6f1737ecdb825af838af2c9aee89486')
    expect(schemasUrl.searchParams.get('partNameIds')).toBe('87')
    expect(schemasUrl.searchParams.get('criteria')).toBe('b4*XW8AN2NE3JH035743(2018!aebbed60')

    const parts2 = calls.find((c) => c.url.includes('/parts2'))
    const parts2Url = new URL(parts2!.url)
    expect(parts2Url.pathname).toBe('/v1/catalogs/skoda/parts2')
    expect(parts2Url.searchParams.get('groupId')).toBe('GROUP-OIL')
  })

  test('авто определял другой каталог → raw не доверяем, декодируем VIN заново', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const provider = providerWith(chainHandler, calls)
    const foreign: Vehicle = {
      ...vehicle,
      // Чужой raw: catalogId/carId с чужой семантикой + чужая метка источника.
      raw: { catalogId: 'чужое', carId: 'чужое', [CATALOG_SOURCE_KEY]: 'acat' },
    }

    const parts = await provider.searchParts(foreign, 'масляный фильтр')

    expect(calls[0]!.url).toContain('/car/info')
    expect(parts).toHaveLength(1)
    // После повторного декода поиск идёт по СВОИМ координатам из /car/info.
    expect(calls.find((c) => c.url.includes('/groups-suggest'))!.url).toContain('/catalogs/skoda/')
  })

  test('groups-suggest пуст (напр. каталог без поиска) → [], без лишних вызовов', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const provider = providerWith((url) => {
      if (url.includes('/groups-suggest')) return json([])
      return new Response('', { status: 404 })
    }, calls)

    expect(await provider.searchParts(vehicle, 'фильтр')).toEqual([])
    expect(calls.every((c) => c.url.includes('/groups-suggest'))).toBe(true)
  })

  test('пустой запрос → [] без обращений к API', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const provider = providerWith(() => json([]), calls)
    expect(await provider.searchParts(vehicle, '   ')).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe('mapVehicle', () => {
  test('без параметра year год берётся из description', () => {
    const vehicle = mapVehicle(VIN, [
      { ...CAR_INFO[0], parameters: [], criteria: 'без года', description: '2019-2022. OCT' },
    ])
    expect(vehicle!.year).toBe(2019)
  })

  test('цифры VIN внутри criteria за год не принимаются', () => {
    // «2020» есть в самом номере, но год открывается только скобкой.
    const vehicle = mapVehicle('X2020NE3JH0357431', [
      { ...CAR_INFO[0], parameters: [], criteria: 'b4*X2020NE3JH0357431(2018!x', description: '' },
    ])
    expect(vehicle!.year).toBe(2018)
  })

  test('нет ни марки, ни модели → null', () => {
    expect(mapVehicle(VIN, [{ carId: 'x', catalogId: 'y' }])).toBeNull()
  })
})

describe('collectParts', () => {
  const ctx = () => ({
    category: 'Узел',
    brand: 'Skoda',
    sidSet: new Set(['87']),
    seen: new Set<string>(),
    out: [] as { oemNumber: string; name: string; category: string; brand: string | null }[],
  })

  test('деталь без nameId отбрасывается (живьём это крепёж/мелочь узла)', () => {
    const c = ctx()
    collectParts(
      {
        partGroups: [
          {
            parts: [
              { number: 'N  91108701', name: 'Винт с 6-гр.головкой' }, // nameId: null живьём
              { number: '04E115561H', nameId: '87', name: 'Фильтр масляный двигателя' },
            ],
          },
        ],
      },
      c,
    )
    expect(c.out).toEqual([
      { oemNumber: '04E115561H', name: 'Фильтр масляный двигателя', category: 'Узел', brand: 'Skoda' },
    ])
  })

  test('дубли (номер+название) и записи без номера/названия пропускаются', () => {
    const c = ctx()
    collectParts(
      {
        partGroups: [
          {
            parts: [
              { number: 'N1', nameId: '87', name: 'Фильтр' },
              { number: 'N1', nameId: '87', name: 'Фильтр' }, // дубль
              { number: '', nameId: '87', name: 'Без номера' },
              { number: 'N2', nameId: '87', name: '' },
            ],
          },
        ],
      },
      c,
    )
    expect(c.out).toHaveLength(1)
  })

  test('потолок PARTSCATALOGS_MAX_PARTS соблюдается', () => {
    const c = ctx()
    const parts = Array.from({ length: PARTSCATALOGS_MAX_PARTS + 20 }, (_, i) => ({
      number: `N${i}`,
      nameId: '87',
      name: `Деталь ${i}`,
    }))
    collectParts({ partGroups: [{ parts }] }, c)
    expect(c.out).toHaveLength(PARTSCATALOGS_MAX_PARTS)
  })
})
