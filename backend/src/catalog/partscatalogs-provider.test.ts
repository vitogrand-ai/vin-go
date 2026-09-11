import { describe, expect, test } from 'bun:test'

import type { Part, Vehicle } from '@web-app-demo/contracts'

import { AppError } from '../http/errors'
import { queryNames } from './part-match'
import { CATALOG_SOURCE_KEY } from './fallback-catalog'
import {
  PARTSCATALOGS_MAX_PARTS,
  PartsCatalogsCatalogProvider,
  collectParts,
  mapVehicle,
  normalizeImageUrl,
  rankByPosition,
  rankSuggestions,
  shortenQuery,
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
    // Картинка схемы: в списке схем плейсхолдер «{IMG_URL}» (отбрасывается),
    // поэтому взята копия из parts2 с добавленным протоколом.
    expect(parts).toEqual([
      {
        oemNumber: '11422469721',
        name: 'Engine oil filter',
        category: 'Lubricat.syst.-oil filter, heat exchanger',
        brand: 'Skoda',
        imageUrl: 'https://ru.img.parts-catalogs.com/bmw_2020_01/data/JPG/502704.png',
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

  test('уточнённая фраза не найдена → названия добираются укороченным запросом', async () => {
    // Живой случай: «Колодки тормозные передние» подсказка не знает — деталь
    // называется «Колодки тормозные»; уточнение позиции отрезается с конца.
    const suggestQueries: string[] = []
    const provider = providerWith((url) => {
      if (url.includes('/groups-suggest')) {
        const q = new URL(url).searchParams.get('q') ?? ''
        suggestQueries.push(q)
        return q === 'Колодки тормозные' ? json(SUGGEST) : json([])
      }
      if (url.includes('/schemas')) return json(SCHEMAS)
      if (url.includes('/parts2')) return json(PARTS2)
      return new Response('', { status: 404 })
    })

    const parts = await provider.searchParts(vehicle, 'Колодки тормозные передние')

    expect(suggestQueries).toEqual(['Колодки тормозные передние', 'Колодки тормозные'])
    expect(parts).toHaveLength(1)
  })

  test('подсказка знает фразу, но деталей у машины нет → повторный проход короче', async () => {
    // Живой случай: подсказка ищет по всему справочнику названий, не по машине,
    // и на «амортизатор передний» отвечает «Амортизатор передний пневматической
    // подвески» — у машины такого узла нет. Без второго прохода поиск пустой.
    const suggestQueries: string[] = []
    const provider = providerWith((url) => {
      if (url.includes('/groups-suggest')) {
        const q = new URL(url).searchParams.get('q') ?? ''
        suggestQueries.push(q)
        return json([{ sid: q === 'амортизатор' ? '87' : '7870', name: q }])
      }
      if (url.includes('/schemas')) {
        // Схема есть только у названия из второго прохода (sid 87).
        return json(new URL(url).searchParams.get('partNameIds') === '87' ? SCHEMAS : { list: [] })
      }
      if (url.includes('/parts2')) return json(PARTS2)
      return new Response('', { status: 404 })
    })

    const parts = await provider.searchParts(vehicle, 'амортизатор передний')

    expect(suggestQueries).toEqual(['амортизатор передний', 'амортизатор'])
    expect(parts).toHaveLength(1)
  })

  test('проходов не больше двух: третий укороченный запрос уже не делается', async () => {
    const suggestQueries: string[] = []
    const provider = providerWith((url) => {
      if (url.includes('/groups-suggest')) {
        suggestQueries.push(new URL(url).searchParams.get('q') ?? '')
        return json([{ sid: '999', name: 'Никогда не находится' }])
      }
      if (url.includes('/schemas')) return json({ list: [] })
      return new Response('', { status: 404 })
    })

    expect(await provider.searchParts(vehicle, 'фильтр масляный двигателя')).toEqual([])
    expect(suggestQueries).toEqual(['фильтр масляный двигателя', 'фильтр масляный'])
  })

  test('нелокализованный узел: колодки находятся по английскому названию', async () => {
    // Живой Subaru (сент 2026): «Колодки тормозные дисковые» из универсального
    // дерева ведут только на ЗАДНИЙ тормоз, а передние колодки лежат в схеме
    // переднего тормоза без nameId и с английским названием. Фильтр только по
    // nameId отдавал задние — и «колодки передние» превращались в «не найдено».
    const provider = providerWith((url) => {
      if (url.includes('/groups-suggest')) return json([{ sid: '289', name: 'Колодки тормозные дисковые' }])
      if (url.includes('/schemas')) {
        return json({
          list: [
            { groupId: 'REAR', name: 'Задний тормоз', img: '//img.test/rear.png' },
            { groupId: 'FRONT', name: 'Передний тормоз', img: '//img.test/front.png' },
          ],
        })
      }
      if (url.includes('/parts2')) {
        const groupId = new URL(url).searchParams.get('groupId')
        return json({
          partGroups: [
            {
              parts:
                groupId === 'REAR'
                  ? [{ number: '26696AL020', nameId: '289', name: 'Колодки тормозные дисковые' }]
                  : [
                      { number: '26296FL030', nameId: null, name: 'PAD KIT-FRONT DISK BRAKE' },
                      { number: '26231FE011', nameId: null, name: 'BOLT-DISK BRAKE' },
                    ],
            },
          ],
        })
      }
      return new Response('', { status: 404 })
    })

    const parts = await provider.searchParts(vehicle, 'колодки тормозные')

    // Крепёж узла («BOLT-DISK BRAKE») не прошёл: термина запроса в нём нет.
    expect(parts.map((part) => part.oemNumber)).toEqual(['26696AL020', '26296FL030'])
    expect(parts.map((part) => part.category)).toEqual(['Задний тормоз', 'Передний тормоз'])
  })

  test('нечёткая подсказка: схема берётся у названия, похожего на запрос', async () => {
    // Живой баг (Citroen C4, сент 2026): на «Крышка ГБЦ» справочник отдаёт
    // первой «Крышку расширительного бачка» — общего слова «крышка» ему
    // достаточно. Раньше побеждала первая подсказка, и мастер получал схему
    // бачка вместо клапанной крышки.
    const schemaCalls: string[] = []
    const provider = providerWith((url) => {
      if (url.includes('/groups-suggest')) {
        return json([
          { sid: '407', name: 'Крышка расширительного бачка системы охлаждения' },
          { sid: '1167', name: 'Крышка маслозаливной горловины' },
          { sid: '323', name: 'Крышка ГБЦ' },
        ])
      }
      if (url.includes('/schemas')) {
        schemaCalls.push(new URL(url).searchParams.get('partNameIds') ?? '')
        return json(SCHEMAS)
      }
      if (url.includes('/parts2')) {
        return json({
          partGroups: [{ parts: [{ number: '0248.L6', nameId: '323', name: 'Крышка ГБЦ' }] }],
        })
      }
      return new Response('', { status: 404 })
    })

    const parts = await provider.searchParts(vehicle, 'Крышка ГБЦ')

    // Схема спрашивается сразу у нужного названия — до бачка очередь не доходит.
    expect(schemaCalls[0]).toBe('323')
    expect(parts.map((part) => part.name)).toEqual(['Крышка ГБЦ'])
  })

  test('уточнение позиции выбирает узел: передний тормоз обходит лимит схем', async () => {
    // Живой Subaru: у «Колодки тормозные дисковые» схем больше, чем провайдер
    // раскрывает, и передний тормоз стоял в каталоге четвёртым — лимит резал
    // его, фильтр позиции вырезал остальное, мастер видел «не найдено».
    const opened: string[] = []
    const provider = providerWith((url) => {
      if (url.includes('/groups-suggest')) return json([{ sid: '289', name: 'Колодки тормозные дисковые' }])
      if (url.includes('/schemas')) {
        return json({
          list: [
            { groupId: 'REAR-1', name: 'Задний тормоз' },
            { groupId: 'REAR-2', name: 'Тормоз задний дисковый' },
            { groupId: 'HAND', name: 'Тормоз стояночный' },
            { groupId: 'FRONT', name: 'Передний тормоз', img: '//img.test/front.png' },
          ],
        })
      }
      if (url.includes('/parts2')) {
        const groupId = new URL(url).searchParams.get('groupId') ?? ''
        opened.push(groupId)
        return json({
          partGroups: [{ parts: [{ number: `OEM-${groupId}`, nameId: '289', name: 'Колодки тормозные дисковые' }] }],
        })
      }
      return new Response('', { status: 404 })
    })

    const parts = await provider.searchParts(vehicle, 'колодки тормозные передние')

    expect(opened[0]).toBe('FRONT')
    expect(parts.map((part) => part.category)).toContain('Передний тормоз')
  })

  test('название с узлом чужой стороны не останавливает перебор', async () => {
    // Живой Subaru: передние колодки лежат под «Колодки тормозные
    // (ремкомплект)», а подсказка первым отдаёт «...дисковые» с одним лишь
    // задним узлом. Раньше поиск залипал на нём и отвечал «не найдено».
    const opened: string[] = []
    const provider = providerWith((url) => {
      if (url.includes('/groups-suggest')) {
        return json([
          { sid: '289', name: 'Колодки тормозные дисковые' },
          { sid: '1109', name: 'Колодки тормозные (ремкомплект)' },
        ])
      }
      if (url.includes('/schemas')) {
        const sid = new URL(url).searchParams.get('partNameIds')
        return json({
          list:
            sid === '289'
              ? [{ groupId: 'REAR', name: 'Задний тормоз' }]
              : [
                  { groupId: 'REAR', name: 'Задний тормоз' },
                  { groupId: 'FRONT', name: 'Передний тормоз', img: '//img.test/front.png' },
                ],
        })
      }
      if (url.includes('/parts2')) {
        const groupId = new URL(url).searchParams.get('groupId') ?? ''
        opened.push(groupId)
        return json({
          partGroups: [{ parts: [{ number: `OEM-${groupId}`, nameId: '1109', name: 'Колодки тормозные' }] }],
        })
      }
      return new Response('', { status: 404 })
    })

    const parts = await provider.searchParts(vehicle, 'колодки тормозные передние')

    // Задний узел не открывался вовсе — ни у одного из названий.
    expect(opened).toEqual(['FRONT'])
    expect(parts.map((part) => part.category)).toEqual(['Передний тормоз'])
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
  const ctx = (englishTerms: string[] = ['oil filter'], query = 'масляный фильтр') => ({
    category: 'Узел',
    imageUrl: null as string | null,
    brand: 'Skoda',
    sidSet: new Set(['87']),
    englishTerms,
    names: queryNames(query),
    seen: new Set<string>(),
    out: [] as Part[],
  })

  test('деталь без nameId находится по русскому названию из словаря', () => {
    // Живой Citroen: сама клапанная крышка лежит без nameId и с оригинальным
    // РУССКИМ названием, а nameId есть у её прокладки. Раньше проходила только
    // прокладка — мастер получал не ту деталь.
    const c = ctx([], 'крышка гбц')
    collectParts(
      {
        partGroups: [
          {
            parts: [
              { number: '0249 E6', nameId: '697', name: 'Прокладка крышки ГБЦ' },
              { number: 'V7598862 80', nameId: null, name: 'КРЫШКА ГОЛОВКИ ЦИЛИНДРОВ' },
              { number: '16087379 80', nameId: null, name: 'ШАЙБА БОЛТА ГОЛОВКИ ЦИЛИНДРОВ' },
              { number: 'V7572848 80', nameId: null, name: 'ПРОБКА ЗАЛИВА МАСЛА В ДВИГАТ.' },
            ],
          },
        ],
      },
      { ...c, sidSet: new Set(['697']) },
    )

    // Крышка — первой: её спрашивали. Шайба и пробка — соседи по узлу, мимо.
    expect(c.out.map((part) => part.oemNumber)).toEqual(['V7598862 80', '0249 E6'])
  })

  test('', () => {
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
      {
        oemNumber: '04E115561H',
        name: 'Фильтр масляный двигателя',
        category: 'Узел',
        brand: 'Skoda',
        imageUrl: null,
      },
    ])
  })

  test('деталь без nameId проходит по английскому названию (нелокализованная ветка)', () => {
    // Живой Subaru: у передних колодок nameId нет и название осталось английским —
    // без этой ветки поиск «колодки передние» отвечал «ничего не найдено».
    const c = ctx(['pad', 'brake shoe'])
    collectParts(
      {
        partGroups: [
          {
            parts: [
              { number: '26296FL030', nameId: null, name: 'PAD KIT-FRONT DISK BRAKE' },
              { number: '26231FE011', nameId: null, name: 'BOLT-DISK BRAKE' },
            ],
          },
        ],
      },
      c,
    )
    expect(c.out.map((part) => part.oemNumber)).toEqual(['26296FL030'])
  })

  test('порядок слов в названии EPC не мешает отбору', () => {
    // Живые названия Hyundai: «COIL ASSY-IGNITION», «JOINT ASSY-UNIVERSAL». Подстрочное
    // сравнение их не ловило — слова идут в другом порядке и через дефис.
    const c = ctx(['ignition coil'])
    collectParts(
      {
        partGroups: [
          {
            parts: [
              { number: '27301-2B010', nameId: null, name: 'COIL ASSY-IGNITION' },
              { number: '27350-2B000', nameId: null, name: 'BRACKET-COIL' },
            ],
          },
        ],
      },
      c,
    )
    expect(c.out.map((part) => part.oemNumber)).toEqual(['27301-2B010'])
  })

  test('частичное слово не считается совпадением', () => {
    // «pad» не должен ловить «PADDING»: иначе в выдачу попадают соседи по узлу.
    const c = ctx(['pad'])
    collectParts(
      { partGroups: [{ parts: [{ number: 'X1', nameId: null, name: 'PADDING-DOOR TRIM' }] }] },
      c,
    )
    expect(c.out).toEqual([])
  })

  test('точные попадания по nameId идут перед совпадениями по названию', () => {
    const c = ctx(['pad'])
    collectParts(
      {
        partGroups: [
          {
            parts: [
              { number: 'N1', nameId: null, name: 'PAD CLIP-FRONT BRAKE' },
              { number: 'N2', nameId: '87', name: 'Колодки тормозные дисковые' },
            ],
          },
        ],
      },
      c,
    )
    expect(c.out.map((part) => part.oemNumber)).toEqual(['N2', 'N1'])
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

describe('shortenQuery / normalizeImageUrl', () => {
  test('варианты запроса: исходный, затем без последних слов', () => {
    expect(shortenQuery('колодки тормозные передние')).toEqual([
      'колодки тормозные передние',
      'колодки тормозные',
      'колодки',
    ])
    expect(shortenQuery('фильтр')).toEqual(['фильтр'])
  })

  test('протокол-относительный URL картинки получает https, мусор отбрасывается', () => {
    expect(normalizeImageUrl('//ru.img.parts-catalogs.com/x.png')).toBe(
      'https://ru.img.parts-catalogs.com/x.png',
    )
    expect(normalizeImageUrl('https://img.example.com/x.png')).toBe('https://img.example.com/x.png')
    expect(normalizeImageUrl('{IMG_URL}')).toBeNull()
    expect(normalizeImageUrl('')).toBeNull()
    expect(normalizeImageUrl(null)).toBeNull()
  })

  test('превью схемы заменяется оригиналом: номера позиций должны читаться', () => {
    // Живой ответ /schemas: превью 300×410, оригинал по тому же пути — 787×1076.
    expect(normalizeImageUrl('//ru.img.parts-catalogs.com/r/300x430/hyundai_2021_09/61292.png')).toBe(
      'https://ru.img.parts-catalogs.com/hyundai_2021_09/61292.png',
    )
    // Вложенный путь каталога (Subaru отдаёт ещё и подпапку руля) не теряется.
    expect(
      normalizeImageUrl('https://ru.img.parts-catalogs.com/r/300x430/subaru_2021_09/lhd/S14-263-01.png'),
    ).toBe('https://ru.img.parts-catalogs.com/subaru_2021_09/lhd/S14-263-01.png')
    // Адрес уже без сегмента размера (так отдаёт parts2) остаётся нетронутым.
    expect(normalizeImageUrl('//ru.img.parts-catalogs.com/subaru_2021_09/lhd/S14-263-01.png')).toBe(
      'https://ru.img.parts-catalogs.com/subaru_2021_09/lhd/S14-263-01.png',
    )
    // Сегмент размера режется только в начале пути — папка «r» внутри адреса цела.
    expect(normalizeImageUrl('https://img.example.com/catalog/r/300x430/x.png')).toBe(
      'https://img.example.com/catalog/r/300x430/x.png',
    )
  })

  test('без параметра year, criteria и description год = null, а не 0', () => {
    const vehicle = mapVehicle('WDD1770871V030773', [
      { brand: 'Mercedes-Benz', title: 'A200', catalogId: 'mercedes', carId: 'c1' },
    ])
    expect(vehicle?.year).toBeNull()
  })

  test('модель берётся из modelName, код модификации уходит в raw (живой Mercedes с прода)', () => {
    const vehicle = mapVehicle('WDD1770871V030773', [
      {
        brand: 'Mercedes',
        title: '177.087     (A 200)',
        modelName: 'A-class',
        catalogId: 'mercedes',
        carId: 'car-1',
        criteria: '36*WDD1770871V030773!c16f6b53',
        parameters: [{ key: 'body', name: 'Тип кузова', value: 'A 200' }],
      },
    ])
    expect(vehicle?.model).toBe('A-class')
    expect(vehicle?.raw?.modification).toBe('177.087     (A 200)')
    // Координаты каталога на месте — по ним идёт поиск деталей.
    expect(vehicle?.raw?.carId).toBe('car-1')
  })

  test('когда modelName совпадает с title, модификация в raw не дублируется', () => {
    const vehicle = mapVehicle('X', [
      { brand: 'Citroen', title: 'C4', modelName: 'C4', catalogId: 'citroen', carId: 'c2' },
    ])
    expect(vehicle?.model).toBe('C4')
    expect(vehicle?.raw?.modification).toBeUndefined()
  })
})

describe('rankSuggestions', () => {
  const suggestions = [
    { sid: '407', name: 'Крышка расширительного бачка системы охлаждения' },
    { sid: '323', name: 'Крышка ГБЦ' },
    { sid: '1167', name: 'Крышка маслозаливной горловины' },
  ]

  test('вперёд идёт название, ближайшее к детали из запроса', () => {
    expect(rankSuggestions(suggestions, 'Крышка ГБЦ')[0]).toBe('323')
  })

  test('каталог зовёт деталь другим именем — выручает синонимический ряд', () => {
    // Ключевой случай: слова «клапанная» нет НИ В ОДНОМ названии справочника,
    // сравнивать с самим запросом бесполезно. Но словарь знает, что это та же
    // деталь, что и «крышка гбц», — по ряду она и находится.
    expect(rankSuggestions(suggestions, 'клапанная крышка')[0]).toBe('323')
    expect(rankSuggestions(suggestions, 'крышка клапанов')[0]).toBe('323')
  })

  test('главное слово названия решает: сосед по узлу не обходит саму деталь', () => {
    // Справочник пишет деталь первым словом: «Подшипник генератора» — это
    // подшипник. Раньше он выигрывал у самого генератора, потому что был короче.
    const generator = [
      { sid: '1', name: 'Подшипник генератора' },
      { sid: '2', name: 'Шкив генератора' },
      { sid: '3', name: 'Генератор переменного тока' },
    ]
    expect(rankSuggestions(generator, 'генератор')[0]).toBe('3')
  })

  test('общее слово не перевешивает: у длинного чужого названия схожесть ниже', () => {
    // «Крышка расширительного бачка» содержит «крышку» ровно так же, как
    // «Крышка ГБЦ», и раньше выигрывала просто потому, что стояла первой.
    expect(rankSuggestions(suggestions, 'крышка гбц')[0]).not.toBe('407')
  })

  test('морфология не мешает: «головки» и «головка» — одно слово', () => {
    const byMorphology = [
      { sid: '1', name: 'Прокладка поддона картера' },
      { sid: '171', name: 'Головка блока цилиндров' },
    ]
    expect(rankSuggestions(byMorphology, 'головки блока цилиндров')[0]).toBe('171')
  })

  test('ни одного общего слова → порядок каталога сохраняется', () => {
    // Справочник без русского дерева: обнулять такую выдачу нельзя.
    const english = [
      { sid: '87', name: 'Engine oil filter' },
      { sid: '433', name: 'Engine oil' },
    ]
    expect(rankSuggestions(english, 'фильтр масляный')).toEqual(['87', '433'])
  })

  test('длинная выдача режется до пяти УЖЕ после сортировки', () => {
    const many = Array.from({ length: 8 }, (_, index) => ({ sid: String(index), name: 'Крышка чужая' }))
    const ranked = rankSuggestions([...many, { sid: 'target', name: 'Крышка ГБЦ' }], 'Крышка ГБЦ')
    expect(ranked).toHaveLength(5)
    expect(ranked[0]).toBe('target')
  })
})

describe('rankByPosition', () => {
  const schemas = [
    { groupId: 'R', name: 'Задний тормоз' },
    { groupId: 'F', name: 'Передний тормоз' },
    { groupId: 'X', name: 'Тормоз стояночный' },
  ]

  test('узел нужной стороны вперёд, противоположной — назад', () => {
    expect(rankByPosition(schemas, 'колодки передние').map((s) => s['groupId'])).toEqual(['F', 'X', 'R'])
  })

  test('запрос без позиции порядок каталога не меняет', () => {
    expect(rankByPosition(schemas, 'колодки тормозные').map((s) => s['groupId'])).toEqual(['R', 'F', 'X'])
  })
})
