import { describe, expect, test } from 'bun:test'

import type { Part, Vehicle } from '@web-app-demo/contracts'

import { AppError } from '../http/errors'
import { queryNames } from './part-match'
import { englishPartTerms } from './part-terms'
import { CATALOG_SOURCE_KEY } from './fallback-catalog'
import {
  PARTSCATALOGS_MAX_PARTS,
  PartsCatalogsCatalogProvider,
  collectParts,
  mapVehicle,
  normalizeImageUrl,
  partDetails,
  pickCar,
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

    // Запрос вне таблицы «деталь → узел» (part-nodes): здесь проверяется путь по словам.
    const parts = await provider.searchParts(vehicle, 'oil filter')

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
        position: '01',
        schemeId: 'GROUP-OIL',
        note: 'Oil filter',
        appliesPeriod: null,
        quantity: 1,
      },
    ])

    // Координаты авто взяты из raw — повторного /car/info не было.
    expect(calls.some((c) => c.url.includes('/car/info'))).toBe(false)

    const suggest = calls.find((c) => c.url.includes('/groups-suggest'))
    expect(suggest).toBeDefined()
    const suggestUrl = new URL(suggest!.url)
    expect(suggestUrl.pathname).toBe('/v1/catalogs/skoda/groups-suggest')
    expect(suggestUrl.searchParams.get('q')).toBe('oil filter')

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

    const parts = await provider.searchParts(foreign, 'oil filter')

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
    // Схем и деталей по названию не просим; одно обращение за деревом машины —
    // запасной путь (см. «запасной путь через дерево узлов»), и оно кэшируется.
    expect(calls.every((c) => c.url.includes('/groups-suggest') || c.url.includes('/groups-tree'))).toBe(true)
    expect(calls.filter((c) => c.url.includes('/groups-tree'))).toHaveLength(1)
  })

  test('уточнённая фраза не найдена → названия добираются укороченным запросом', async () => {
    // Живой случай: «Колодки тормозные передние» подсказка не знает — деталь
    // называется «Колодки тормозные»; уточнение позиции отрезается с конца.
    // Колодки теперь ищет таблица part-nodes, поэтому механику пути по словам
    // проверяем на детали вне таблицы.
    const suggestQueries: string[] = []
    const provider = providerWith((url) => {
      if (url.includes('/groups-suggest')) {
        const q = new URL(url).searchParams.get('q') ?? ''
        suggestQueries.push(q)
        return q === 'Накладка тормозная' ? json(SUGGEST) : json([])
      }
      if (url.includes('/schemas')) return json(SCHEMAS)
      if (url.includes('/parts2')) return json(PARTS2)
      return new Response('', { status: 404 })
    })

    const parts = await provider.searchParts(vehicle, 'Накладка тормозная передняя')

    expect(suggestQueries).toEqual(['Накладка тормозная передняя', 'Накладка тормозная'])
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
        return json([{ sid: q === 'пневмобаллон' ? '87' : '7870', name: q }])
      }
      if (url.includes('/schemas')) {
        // Схема есть только у названия из второго прохода (sid 87).
        return json(new URL(url).searchParams.get('partNameIds') === '87' ? SCHEMAS : { list: [] })
      }
      if (url.includes('/parts2')) return json(PARTS2)
      return new Response('', { status: 404 })
    })

    // Амортизатор теперь ищет таблица part-nodes; механику проверяем на детали вне таблицы.
    const parts = await provider.searchParts(vehicle, 'пневмобаллон передний')

    expect(suggestQueries).toEqual(['пневмобаллон передний', 'пневмобаллон'])
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

    // Три варианта («… передний левый» → «… передний» → «амортизатор»), проходов два.
    expect(await provider.searchParts(vehicle, 'амортизатор передний левый')).toEqual([])
    expect(suggestQueries).toEqual(['амортизатор передний левый', 'амортизатор передний'])
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

  test('объём двигателя в описании за год не принимается', () => {
    // Живьём 22.09.2026: Subaru Forester 2021 года карточка показывала «Год:
    // 2000» — из описания «Двигатель: 2000CC DOHC NA». Неверный год хуже
    // пустого: по нему мастер сверяет машину.
    const vehicle = mapVehicle('JF1SK7LL5MG129305', [
      {
        ...CAR_INFO[0],
        parameters: [],
        criteria: '4f*JF1SK7LL5MG129305{"ftr1":"W"}4^M4Y<J20>20210209?C',
        description: 'Трансмиссия: CONTINUOUS VARIABLE GEAR; Двигатель: 2000CC DOHC NA',
      },
    ])
    expect(vehicle!.year).not.toBe(2000)
  })

  test('нет ни марки, ни модели → null', () => {
    expect(mapVehicle(VIN, [{ carId: 'x', catalogId: 'y' }])).toBeNull()
  })
})

describe('PartsCatalogsCatalogProvider.schemeParts', () => {
  const vehicle: Vehicle = {
    vin: VIN,
    make: 'Skoda',
    model: 'Octavia',
    year: 2018,
    engine: null,
    bodyType: null,
    raw: {
      catalogId: 'skoda',
      carId: 'b6f1737ecdb825af838af2c9aee89486',
      criteria: 'b4*XW8AN2NE3JH035743(2018!aebbed60',
      [CATALOG_SOURCE_KEY]: 'partscatalogs',
    },
  }

  test('узел отдаётся целиком, с номерами позиций и без отбора по запросу', async () => {
    // Ключевое отличие от поиска: «Heat exchanger» к «масляному фильтру»
    // отношения не имеет, но на схеме он стоит под номером — значит нужен.
    const calls: { url: string; headers: Record<string, string> }[] = []
    const provider = providerWith(() => json(PARTS2), calls)

    const parts = await provider.schemeParts(vehicle, 'GROUP-OIL')

    expect(parts.map((part) => [part.position, part.oemNumber])).toEqual([
      ['01', '11422469721'],
      ['02', '17217533476'],
    ])
    expect(parts[0]?.schemeId).toBe('GROUP-OIL')
    expect(parts[0]?.imageUrl).toBe(
      'https://ru.img.parts-catalogs.com/bmw_2020_01/data/JPG/502704.png',
    )

    // Координаты машины взяты из raw — лишнего /car/info (и квоты VIN) нет.
    expect(calls).toHaveLength(1)
    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/v1/catalogs/skoda/parts2')
    expect(url.searchParams.get('groupId')).toBe('GROUP-OIL')
    expect(url.searchParams.get('criteria')).toBe('b4*XW8AN2NE3JH035743(2018!aebbed60')
  })

  test('каталог не знает такого узла → пусто, а не падение', async () => {
    const provider = providerWith(() => new Response('', { status: 404 }))
    expect(await provider.schemeParts(vehicle, 'GROUP-MISSING')).toEqual([])
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

  test('«ремень ГРМ» не пропускает всё подряд со словом TIMING', () => {
    // Живьём 22.09.2026, Toyota Prado (мотор 1GR, у него цепь): по голому
    // «timing» из узла прошли шпонка шестерни и уплотнительное кольцо клапана
    // фаз — мастер получал их первой строкой. Ремень и цепь — только фразой.
    const c = ctx(englishPartTerms('ремень грм'), 'ремень грм')
    collectParts(
      {
        partGroups: [
          {
            parts: [
              { number: '95161-30516', name: 'KEY(FOR CRANKSHAFT TIMING GEAR)' },
              { number: '90099-14137', name: 'RING, O(FOR CAM TIMING OIL CONTROL VALVE)' },
              { number: '13568-09130', name: 'BELT, TIMING' },
            ],
          },
        ],
      },
      c,
    )
    expect(c.out.map((part) => part.oemNumber)).toEqual(['13568-09130'])
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
        position: null,
        schemeId: null,
        note: null,
        appliesPeriod: null,
        quantity: null,
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

  test('термин в скобках — применимость, а не сама деталь', () => {
    // Живьём 23.09.2026, Toyota LC: на «шаровая» первой шла «NUT, CASTLE (FOR FRONT
    // LOWER BALL JOINT RH)» — гайка ДЛЯ шаровой, а не опора.
    const c = ctx(['ball joint'])
    collectParts(
      {
        partGroups: [
          {
            parts: [
              { number: '90171-C0005', nameId: null, name: 'NUT, CASTLE (FOR FRONT LOWER BALL JOINT RH)' },
              { number: '43330-69135', nameId: null, name: 'JOINT ASSY, LOWER BALL, FRONT' },
            ],
          },
        ],
      },
      c,
    )
    expect(c.out.map((part) => part.oemNumber)).toEqual(['43330-69135'])
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
  test('варианты запроса: исходный, затем без уточнений позиции в конце', () => {
    expect(shortenQuery('колодки тормозные передние')).toEqual([
      'колодки тормозные передние',
      'колодки тормозные',
    ])
    expect(shortenQuery('амортизатор передний левый')).toEqual([
      'амортизатор передний левый',
      'амортизатор передний',
      'амортизатор',
    ])
    expect(shortenQuery('фильтр')).toEqual(['фильтр'])
  })

  test('суть запроса не отрезается: «ремень грм» не становится любым ремнём', () => {
    // Живьём 22.09.2026: Mercedes на «ремень грм» получал ремень безопасности.
    expect(shortenQuery('ремень грм')).toEqual(['ремень грм'])
    expect(shortenQuery('стойка стабилизатора')).toEqual(['стойка стабилизатора'])
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

  test('несколько модификаций по одному VIN → выбирается по модельному году VIN', () => {
    // Живой ответ прода по VW LFV3B2FY2N3102396 (три модификации, поля срезаны
    // до значимых). Первой каталог отдаёт машину 1992 года — до этой правки
    // мастер получал её год и её детали (carId у модификаций разный).
    const jetta = [
      {
        brand: 'Volkswagen',
        modelName: 'Jetta',
        title: 'Jetta',
        catalogId: 'vw',
        carId: 'jetta-1992',
        criteria: '3d*LFV3B2FY2N3102396(1992!31a3cee7',
        description: '1991-2012',
        parameters: [{ key: 'year', name: 'Год', value: '1992' }],
      },
      {
        brand: 'Volkswagen',
        modelName: 'Jetta',
        title: 'Jetta',
        catalogId: 'vw',
        carId: 'jetta-2022-limousine',
        criteria: '37*LFV3B2FY2N3102396(2022!31a3cee7',
        description: '2020-2027 Limousine',
        parameters: [{ key: 'year', name: 'Год', value: '2022' }],
      },
      {
        brand: 'Volkswagen',
        modelName: 'Jetta',
        title: 'Jetta',
        catalogId: 'vw',
        carId: 'jetta-2022-suv',
        criteria: '37*LFV3B2FY2N3102396(2022!31a3cee7',
        description: '2020-2027 SUV',
        parameters: [{ key: 'year', name: 'Год', value: '2022' }],
      },
    ]

    const vehicle = mapVehicle('LFV3B2FY2N3102396', jetta)
    expect(vehicle?.year).toBe(2022)
    // Детали ищутся по координатам выбранной машины, а не первой в списке.
    expect(vehicle?.raw?.carId).toBe('jetta-2022-limousine')
  })

  test('год есть только диапазоном в описании — модификация всё равно находится', () => {
    const vehicle = mapVehicle('LFV3B2FY2N3102396', [
      { brand: 'Volkswagen', modelName: 'Jetta', catalogId: 'vw', carId: 'old', description: '1991-2012' },
      { brand: 'Volkswagen', modelName: 'Jetta', catalogId: 'vw', carId: 'new', description: '2020-2027' },
    ])
    expect(vehicle?.raw?.carId).toBe('new')
  })

  test('год из VIN ничего не подтвердил → порядок каталога не ломаем', () => {
    // Европейский Mercedes: правило ISO даёт «2001», но такой модификации нет —
    // выдумывать выбор не на чем, берём первую, как и раньше.
    const picked = pickCar('WDD1770871V030773', [
      { carId: 'a', description: '2018-2021' },
      { carId: 'b', description: '2022-2025' },
    ])
    expect(picked?.['carId']).toBe('a')
  })

  test('единственная модификация возвращается без разбора года', () => {
    expect(pickCar('LFV3B2FY2N3102396', [{ carId: 'only' }])?.['carId']).toBe('only')
    expect(pickCar('LFV3B2FY2N3102396', [])).toBeNull()
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

  test('английский справочник: узел по термину запроса остаётся, чужой уходит', () => {
    // У каталогов без русского дерева справочник английский, и запрос сверяется
    // с терминами ряда («oil filter»): фильтр — то, что спросили, само масло —
    // соседний узел, и показывать его вместо фильтра нельзя.
    const english = [
      { sid: '87', name: 'Engine oil filter' },
      { sid: '433', name: 'Engine oil' },
    ]
    expect(rankSuggestions(english, 'фильтр масляный')).toEqual(['87'])
  })

  test('справочник говорит незнакомыми словами → порядок каталога сохраняется', () => {
    // Ни одно название не отозвалось на слова запроса: словаря на этот язык у
    // нас нет. Обнулять такую выдачу нельзя — поиск исчез бы совсем.
    const unknown = [
      { sid: '87', name: 'Ölfilter Motor' },
      { sid: '433', name: 'Motoröl' },
    ]
    expect(rankSuggestions(unknown, 'фильтр масляный')).toEqual(['87', '433'])
  })

  test('длинная выдача режется до пяти УЖЕ после сортировки', () => {
    // Соседи похожи на запрос, но слабее самой детали: прокладка крышки ГБЦ.
    const many = Array.from({ length: 8 }, (_, index) => ({ sid: String(index), name: 'Прокладка крышки ГБЦ' }))
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

describe('partDetails', () => {
  // Живые записи parts2 (прод, 17.09.2026). Каталог отдаёт отличия исполнений
  // не в названии, а в description/notice — без них пять АКБ Ford выглядели
  // пятью одинаковыми «Батарея аккумуляторная».
  test('Ford: «Описание» в несколько строк → примечание, дата производства → период', () => {
    const details = partDetails({
      name: 'Батарея аккумуляторная',
      notice: 'АккумулЯтор; С Кислотой; Ford',
      description:
        'Инженерный номер: 9M5T 10655-BA\nДата производства: 29/09/2014 - 28/11/2018\n: 1\n' +
        'Описание: АккумулЯтор\nС Кислотой\nFord\nКальциево-серебряный\n60 AH\nЗавод Ford-Всеволожск',
    })
    // Ёмкости в notice нет — она только в description: берётся description.
    expect(details.note).toBe(
      'АккумулЯтор; С Кислотой; Ford; Кальциево-серебряный; 60 AH; Завод Ford-Всеволожск; ' +
        'Инженерный номер: 9M5T 10655-BA',
    )
    expect(details.appliesPeriod).toBe('29.09.2014 — 28.11.2018')
    expect(details.quantity).toBeNull()
  })

  test('Ford: открытый период — «с даты»', () => {
    const details = partDetails({
      name: 'Батарея аккумуляторная',
      notice: null,
      description: 'Дата производства: 29/09/2014 - \nОписание: АккумулЯтор\n75AH\n700A',
    })
    expect(details.appliesPeriod).toBe('с 29.09.2014')
    expect(details.note).toBe('АккумулЯтор; 75AH; 700A')
  })

  test('Subaru: код модели и назначения — в примечание, количество — числом', () => {
    const details = partDetails({
      name: 'PAD CLIP-FRONT BRAKE',
      notice: null,
      description:
        'Модель: W.IL.20C.LH\nКод назначения: E7\nДата производства: 20200201 - \nКол-во деталей: 04',
    })
    expect(details.note).toBe('Модель: W.IL.20C.LH; Код назначения: E7')
    expect(details.appliesPeriod).toBe('с 01.02.2020')
    expect(details.quantity).toBe(4)
  })

  test('Hyundai: «Диапазон от» — начало периода; notice отличается от названия — примечание', () => {
    const details = partDetails({
      name: 'Колодки тормозные (ремкомплект)',
      notice: 'ПРУЖИНА КОЛОДОК',
      description: 'Кол-во деталей: 4\nДиапазон от: 2007-12-31\n',
    })
    expect(details.note).toBe('ПРУЖИНА КОЛОДОК')
    expect(details.appliesPeriod).toBe('с 31.12.2007')
    expect(details.quantity).toBe(4)
  })

  test('Skoda: табличное описание — сторона фары и оговорка в примечании', () => {
    const details = partDetails({
      name: 'Фара головного света',
      notice: 'Светодиодные фары; не содержит:',
      description:
        '[Наименование]    [Прим.]     [К-во]\n\nСветодиодные фары слева ЛВPЛ  1     \nне содержит:      POZ.14            ',
    })
    expect(details.note).toBe('Светодиодные фары слева ЛВPЛ; не содержит: POZ.14')
    expect(details.quantity).toBe(1)
    expect(details.appliesPeriod).toBeNull()
  })

  test('notice, повторяющий название, и пустое описание ничего не добавляют', () => {
    expect(
      partDetails({ name: 'Капот', notice: 'капот', description: 'Кол-во деталей: 001' }),
    ).toEqual({ note: null, appliesPeriod: null, quantity: 1 })
    expect(partDetails({ name: 'Капот', notice: '', description: null })).toEqual({
      note: null,
      appliesPeriod: null,
      quantity: null,
    })
  })

  test('поиск доносит примечание и период до выдачи', () => {
    const out: Part[] = []
    collectParts(
      {
        partGroups: [
          {
            parts: [
              {
                number: '1917577',
                nameId: '20',
                name: 'Батарея аккумуляторная',
                notice: 'АккумулЯтор; С Кислотой; 75AH; 700A',
                description: 'Дата производства: 29/09/2014 - 05/10/2018\nОписание: АккумулЯтор\n75AH\n700A',
                positionNumber: '10655',
              },
            ],
          },
        ],
      },
      {
        category: 'АКБ',
        imageUrl: null,
        brand: 'Ford',
        sidSet: new Set(['20']),
        englishTerms: [],
        names: queryNames('аккумулятор'),
        seen: new Set(),
        out,
      },
    )
    expect(out[0]?.note).toBe('АккумулЯтор; 75AH; 700A')
    expect(out[0]?.appliesPeriod).toBe('29.09.2014 — 05.10.2018')
  })
})

// Живой случай 22.09.2026: у части машин `schemas?partNameIds=` отдаёт ОДНУ и
// ту же схему на любую деталь (Skoda Kodiaq — «Насос системы охлаждения» на
// термостат, стартер, генератор и сцепление), и восемь ходовых запросов не
// находились ни на одной из 13 машин. Дерево узлов машины (`groups-tree`) и
// схемы по узлу (`schemas?branchId=`) этим не страдают — на них запасной путь.
describe('PartsCatalogsCatalogProvider.searchParts: запасной путь через дерево узлов', () => {
  const car: Vehicle = {
    vin: 'XW8LD6NS2LH410128',
    make: 'Skoda',
    model: 'Kodiaq',
    year: 2020,
    engine: null,
    bodyType: null,
    raw: { catalogId: 'skoda', carId: 'car-1', criteria: 'crit', [CATALOG_SOURCE_KEY]: 'partscatalogs' },
  }

  const TREE = [
    {
      id: '1',
      name: 'Электрооборудование',
      parentId: null,
      subGroups: [
        { id: '827', name: 'Стартер', parentId: '1', subGroups: [] },
        { id: '797', name: 'Генератор', parentId: '1', subGroups: [] },
      ],
    },
    // Приманки: общее слово «крышка» не должно вытеснить узел из подсказки.
    {
      id: '6',
      name: 'Кузов, остекление',
      parentId: null,
      subGroups: [
        { id: '41', name: 'Крышка багажника', parentId: '6', subGroups: [] },
        { id: '42', name: 'Крышка топливного бака', parentId: '6', subGroups: [] },
        { id: '43', name: 'Крышка головки блока', parentId: '6', subGroups: [] },
      ],
    },
    {
      id: '2',
      name: 'Охлаждение ДВС',
      parentId: null,
      subGroups: [
        { id: '10', name: 'Насос системы охлаждения', parentId: '2', subGroups: [] },
        { id: '30', name: 'Бачок расширительный', parentId: '2', subGroups: [] },
      ],
    },
    {
      id: '3',
      name: 'Трансмиссия, КПП',
      parentId: null,
      subGroups: [{ id: '4', name: 'Привод колеса', parentId: '3', subGroups: [{ id: '31', name: 'Приводной вал', parentId: '4', subGroups: [] }] }],
    },
    // Subaru: лист «Колодки тормозные» ведёт только в задний тормоз, передние колодки — в узле диска.
    {
      id: '7',
      name: 'Детали ТО',
      parentId: null,
      subGroups: [
        { id: '51', name: 'Колодки тормозные', parentId: '7', subGroups: [] },
        { id: '52', name: 'Диск, барабан тормозной', parentId: '7', subGroups: [] },
      ],
    },
    {
      id: '8',
      name: 'Подвеска, шасси',
      parentId: null,
      subGroups: [{ id: '9', name: 'Стабилизатор, составляющие', parentId: '8', subGroups: [
        { id: '53', name: 'Сайлентблоки, втулки стабилизатора', parentId: '9', subGroups: [] },
      ] }],
    },
    // Hyundai: лампа фары лежит в листе «Фара», а лист «Лампа» ведёт в багажник.
    {
      id: '10',
      name: 'Кузов, остекление',
      parentId: null,
      subGroups: [{ id: '11', name: 'Система наружного освещения автомобиля', parentId: '10', subGroups: [
        { id: '832', name: 'Фара', parentId: '11', subGroups: [] },
        { id: '862', name: 'Лампа', parentId: '11', subGroups: [] },
      ] }],
    },
    // Ловушка: тот же лист «Приводной вал», но в смазках — смазка для ШРУСа, не сам ШРУС.
    { id: '5', name: 'ГСМ, автохимия', parentId: null, subGroups: [{ id: '32', name: 'Приводной вал', parentId: '5', subGroups: [] }] },
  ]

  /** Каталог со сломанным `partNameIds`: на любую деталь — схема помпы. */
  function brokenCatalog(url: string): Response {
    const u = new URL(url)
    if (u.pathname.endsWith('/groups-suggest')) return json([{ sid: '900', name: 'Стартер' }])
    if (u.pathname.endsWith('/groups-tree')) return json(TREE)
    if (u.pathname.endsWith('/schemas')) {
      const branch = u.searchParams.get('branchId')
      if (branch === '827') return json({ group: null, list: [{ groupId: 'g-starter', name: 'Стартер и детали не в сборе', img: '' }] })
      if (branch === '30') return json({ group: null, list: [{ groupId: 'g-rad', name: 'Радиатор охлаждающей жидкости', img: '' }] })
      if (branch === '31') return json({ group: null, list: [{ groupId: 'g-shaft', name: 'Приводной вал 1', img: '' }] })
      if (branch === '32') return json({ group: null, list: [{ groupId: 'g-grease', name: 'Смазка', img: '' }] })
      if (branch === '832') return json({ group: null, list: [{ groupId: 'g-head-lamp', name: 'Фары', img: '' }] })
      if (branch === '862') return json({ group: null, list: [{ groupId: 'g-trunk', name: 'Багажное отделение', img: '' }] })
      if (branch === '53') return json({ group: null, list: [{ groupId: 'g-front-susp', name: 'Передняя подвеска', img: '' }] })
      if (branch === '51') return json({ group: null, list: [{ groupId: 'g-rear-brake', name: 'Задний тормоз', img: '' }] })
      if (branch === '52') {
        return json({ group: null, list: [
          { groupId: 'g-rear-brake', name: 'Задний тормоз', img: '' },
          { groupId: 'g-front-brake', name: 'Передний тормоз', img: '' },
        ] })
      }
      return json({ group: null, list: [{ groupId: 'g-pump', name: 'Насос системы охлаждения', img: '' }] })
    }
    if (u.pathname.endsWith('/parts2')) {
      if (u.searchParams.get('groupId') === 'g-starter') {
        return json({ partGroups: [{ name: '', parts: [
          { number: '02E911022H', name: 'Стартер', positionNumber: '1' },
          { number: 'N10721501', name: 'Винт с 6-гр. головкой', positionNumber: '2' },
        ] }] })
      }
      if (u.searchParams.get('groupId') === 'g-rad') {
        return json({ partGroups: [{ name: '', parts: [
          { number: '5Q0121251GB', name: 'Радиатор охлаждения ДВС', nameId: '1075' },
          { number: '5Q0121407D', name: 'Бачок расширительный системы охлаждения', nameId: '778' },
          { number: '5Q0121321', name: 'Крышка расширительного бачка системы охлаждения', nameId: '407' },
        ] }] })
      }
      if (u.searchParams.get('groupId') === 'g-shaft') {
        return json({ partGroups: [{ name: '', parts: [
          // Коды — настоящие коды справочника каталога (999 — ШРУС, 565 — пыльник).
          { number: '8V0498103', name: 'ШРУС', nameId: '999' },
          { number: '8V0498203', name: 'Пыльник ШРУСа', nameId: '565' },
        ] }] })
      }
      if (u.searchParams.get('groupId') === 'g-rear-brake') {
        return json({ partGroups: [{ name: '', parts: [{ number: '26696AL020', name: 'Колодки тормозные дисковые', nameId: '289' }] }] })
      }
      if (u.searchParams.get('groupId') === 'g-front-brake') {
        return json({ partGroups: [{ name: '', parts: [
          { number: '26292SJ000', name: 'PAD CLIP-FRONT BRAKE' },
          { number: '26296SJ020', name: 'PAD KIT-FRONT DISK BRAKE' },
          { number: '26300SJ000', name: 'Диск тормозной', nameId: '215' },
        ] }] })
      }
      if (u.searchParams.get('groupId') === 'g-front-susp') {
        return json({ partGroups: [{ name: '', parts: [
          { number: '20414FJ000', name: 'CLAMP-STABILIZER BUSHING' },
          { number: '20401SJ010', name: 'STABILIZER-FRONT' },
          { number: '20420FL000', name: 'LINK ASSEMBLY-FRONT STABILIZER RIGHT' },
        ] }] })
      }
      if (u.searchParams.get('groupId') === 'g-head-lamp') {
        return json({ partGroups: [{ name: 'HEAD LAMP', parts: [
          { number: '18647-61566-L', name: 'Лампа', nameId: '1384' },
          { number: '18643-05009-N', name: 'Лампа', nameId: '1384' },
          { number: '92101-2E010', name: 'Фара головного света', nameId: '170' },
          { number: '92161-2E000', name: 'ЧАШКА ЛАМПЫ' },
        ] }] })
      }
      if (u.searchParams.get('groupId') === 'g-trunk') {
        return json({ partGroups: [{ name: '', parts: [{ number: '18645-05009-N', name: 'Лампа', nameId: '1384' }] }] })
      }
      if (u.searchParams.get('groupId') === 'g-grease') {
        return json({ partGroups: [{ name: '', parts: [{ number: 'G052186A3', name: 'Смазка ШРУС', nameId: '9001' }] }] })
      }
      return json({ partGroups: [{ name: '', parts: [{ number: '06L121111L', name: 'Насос - помпа системы охлаждения ДВС', nameId: '1234' }] }] })
    }
    return new Response('', { status: 404 })
  }

  test('основной путь отдал чужой узел → деталь находится по дереву', async () => {
    const parts = await providerWith(brokenCatalog).searchParts(car, 'стартер')
    expect(parts.map((part) => part.oemNumber)).toEqual(['02E911022H'])
    expect(parts[0]!.schemeId).toBe('g-starter')
  })

  // Живьём 23.09.2026: schemas?partNameIds на всё отдавал «Педали тормоза», а в
  // дереве деталь лежит в узле, названном не ею: крышка бачка — в «Бачке
  // расширительном», ШРУС — в «Привод колеса > Приводной вал». Дерево у
  // parts-catalogs общее для марок, поэтому узел ищется по его пути.
  test('деталь из узла, названного не ею: крышка бачка — в «Бачке расширительном»', async () => {
    const parts = await providerWith(brokenCatalog).searchParts(car, 'крышка расширительного бачка')
    expect(parts.map((part) => part.name)).toEqual(['Крышка расширительного бачка системы охлаждения'])
  })

  test('ШРУС — из привода колеса, а не смазка из ГСМ и не пыльник', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const parts = await providerWith(brokenCatalog, calls).searchParts(car, 'шрус')
    expect(parts.map((part) => part.oemNumber)).toEqual(['8V0498103'])
    expect(calls.some((call) => call.url.includes('branchId=32'))).toBe(false)
  })

  // Живьём 23.09.2026, Subaru JF1SK7LL5MG129305 (машина заказчика): основной путь
  // отдал давние чужие схемы, а лист «Колодки тормозные» ведёт только в задний тормоз.
  test('передние колодки — из узла дискового тормоза, а не «не найдено»', async () => {
    const parts = await providerWith(brokenCatalog).searchParts({ ...car, make: 'Subaru' }, 'колодки тормозные передние')
    // Порядок строк задаёт сервис (близость к запросу), адаптер отвечает за состав.
    expect(parts.map((part) => part.oemNumber)).toContain('26296SJ020')
    expect(parts.map((part) => part.oemNumber)).not.toContain('26696AL020')
  })

  // Живьём 23.09.2026, Subaru заказчика: стойка стабилизатора зовётся «LINK ASSEMBLY-FRONT
  // STABILIZER RIGHT» и лежит в листе «Сайлентблоки, втулки стабилизатора».
  test('стойка стабилизатора — сама стойка, а не хомут или штанга', async () => {
    const parts = await providerWith(brokenCatalog).searchParts({ ...car, make: 'Subaru' }, 'стойка стабилизатора')
    expect(parts.map((part) => part.oemNumber)).toEqual(['20420FL000'])
  })

  // Живьём 23.09.2026, Hyundai Tucson KMHJN81VP8U903944: «лампа ближнего света» — «не
  // найдено». Справочник знает только «Лампа», а в узле фары лампы так и зовутся.
  test('лампа ближнего света — лампы из схемы фары, а не пусто и не лампа багажника', async () => {
    const parts = await providerWith(brokenCatalog).searchParts({ ...car, make: 'Hyundai' }, 'лампа ближнего света')
    expect(parts.map((part) => part.oemNumber)).toEqual(['18647-61566-L', '18643-05009-N'])
    expect(parts.every((part) => part.schemeId === 'g-head-lamp')).toBe(true)
  })

  // Живьём 23.09.2026: словарь жаргона разворачивал «датчик положения коленвала»
  // в вариант «коленчатый вал», и поиск по варианту отдавал сам коленвал.
  test('вариант из словаря не подменяет деталь: строка таблицы — по запросу мастера', async () => {
    const crankNode = (url: string): Response => {
      const u = new URL(url)
      if (u.pathname.endsWith('/groups-tree')) return json([])
      if (u.pathname.endsWith('/groups-suggest')) return json([{ sid: '73', name: 'Коленвал' }])
      if (u.pathname.endsWith('/schemas')) return json({ group: null, list: [{ groupId: 'g-crank', name: 'Коленчатый вал', img: '' }] })
      if (u.pathname.endsWith('/parts2')) {
        return json({ partGroups: [{ name: '', parts: [
          { number: '06H105101', name: 'Коленвал', nameId: '73' },
          { number: '06H906433', name: 'Датчик положения коленвала', nameId: '1074' },
        ] }] })
      }
      return new Response('', { status: 404 })
    }
    const provider = providerWith(crankNode)
    const byVariant = await provider.searchParts(car, 'коленчатый вал', 'датчик положения коленвала')
    expect(byVariant.map((part) => part.oemNumber)).toEqual(['06H906433'])
    // Без исходного запроса вариант — это и есть вопрос: коленвал.
    const plain = await providerWith(crankNode).searchParts(car, 'коленчатый вал')
    expect(plain.map((part) => part.oemNumber)).toEqual(['06H105101'])
  })

  test('дерево машины запрашивается один раз на машину, а не на каждый поиск', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const provider = providerWith(brokenCatalog, calls)
    await provider.searchParts(car, 'стартер')
    await provider.searchParts(car, 'генератор')
    expect(calls.filter((call) => call.url.includes('/groups-tree'))).toHaveLength(1)
  })

  test('похожего узла в дереве нет → честное «не найдено», схем по узлам не просим', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const parts = await providerWith(brokenCatalog, calls).searchParts(car, 'глушитель')
    expect(parts).toEqual([])
    expect(calls.some((call) => call.url.includes('branchId='))).toBe(false)
  })

  // Стартер есть в таблице part-nodes: дерево теперь спрашивается всегда (один
  // раз на машину, см. тест ниже), а деталь без своего листа находится по коду.
  test('листа из таблицы нет → деталь по коду справочника (partNameIds), а не по словам', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const healthy = (url: string): Response => {
      const u = new URL(url)
      if (u.pathname.endsWith('/schemas') && !u.searchParams.get('branchId')) {
        return json({ group: null, list: [{ groupId: 'g-starter', name: 'Стартер', img: '' }] })
      }
      if (u.pathname.endsWith('/parts2')) {
        return json({ partGroups: [{ name: '', parts: [{ number: '02E911022H', name: 'Стартер', nameId: '900' }] }] })
      }
      return brokenCatalog(url)
    }
    const parts = await providerWith(healthy, calls).searchParts(car, 'стартер')
    expect(parts.map((part) => part.oemNumber)).toEqual(['02E911022H'])
    expect(calls.some((call) => call.url.includes('partNameIds=900'))).toBe(true)
    expect(calls.some((call) => call.url.includes('/groups-suggest'))).toBe(false)
  })
})

// Живой случай 22.09.2026, Toyota Prado: на «тормозные диски» каталог по
// schemas?partNameIds отдал узел «Генератор», и мастер получил «Ротор - якорь
// генератора» (ротор — синоним тормозного диска), на «ступичный подшипник» —
// «Подшипник генератора». У деталей узла есть nameId, но ни одного из
// искомых: значит, узел чужой, и похожее слово в названии ничего не доказывает.
describe('PartsCatalogsCatalogProvider.searchParts: чужой узел от каталога', () => {
  const car: Vehicle = {
    vin: 'LFMGJE720DS070251',
    make: 'Toyota',
    model: 'Land Cruiser',
    year: 2013,
    engine: null,
    bodyType: null,
    raw: { catalogId: 'toyota', carId: 'car-t', criteria: 'crit', [CATALOG_SOURCE_KEY]: 'partscatalogs' },
  }

  function staleCatalog(url: string): Response {
    const u = new URL(url)
    if (u.pathname.endsWith('/groups-suggest')) return json([{ sid: '400', name: 'Диск тормозной' }])
    if (u.pathname.endsWith('/groups-tree')) return json([])
    if (u.pathname.endsWith('/schemas')) return json({ group: null, list: [{ groupId: 'g-alt', name: 'Генератор', img: '' }] })
    if (u.pathname.endsWith('/parts2')) {
      return json({ partGroups: [{ name: '', parts: [
        { number: '27330-0P070', name: 'Ротор - якорь генератора', nameId: '5612' },
        { number: '27415-0W130', name: 'Шкив генератора', nameId: '843' },
      ] }] })
    }
    return new Response('', { status: 404 })
  }

  test('ни одного искомого nameId в узле → узел чужой, похожие по слову детали не берём', async () => {
    expect(await providerWith(staleCatalog).searchParts(car, 'тормозные диски')).toEqual([])
  })

  test('дерево локализовано частично: чужой nameId у соседа не выбрасывает свой узел (Subaru)', async () => {
    // Живьём 22.09.2026: в узле «Передний тормоз» nameId есть у скобы суппорта
    // (296), а у самих колодок нет. Узел похож на запрос — он свой.
    const subaru = (url: string): Response => {
      const u = new URL(url)
      if (u.pathname.endsWith('/groups-suggest')) return json([{ sid: '1109', name: 'Колодки тормозные (ремкомплект)' }])
      if (u.pathname.endsWith('/schemas')) return json({ group: null, list: [{ groupId: 'g-front', name: 'Передний тормоз', img: '' }] })
      if (u.pathname.endsWith('/parts2')) {
        return json({ partGroups: [{ name: '', parts: [
          { number: '26225FL000', name: 'Скоба тормозного суппорта', nameId: '296' },
          { number: '26296SJ020', name: 'PAD KIT-FRONT DISK BRAKE' },
        ] }] })
      }
      return staleCatalog(url)
    }
    // Запрос ровно тот, что уходит в каталог после словаря: «колодки тормозные передние».
    const parts = await providerWith(subaru).searchParts({ ...car, make: 'Subaru' }, 'колодки тормозные передние')
    expect(parts.map((part) => part.oemNumber)).toContain('26296SJ020')
  })

  test('у деталей узла нет nameId вовсе (каталог без универсального дерева) → отбор по названию как раньше', async () => {
    const noIds = (url: string): Response => {
      if (new URL(url).pathname.endsWith('/parts2')) {
        return json({ partGroups: [{ name: '', parts: [{ number: '26300SJ000', name: 'Диск тормозной' }] }] })
      }
      return staleCatalog(url)
    }
    const parts = await providerWith(noIds).searchParts(car, 'тормозные диски')
    expect(parts.map((part) => part.oemNumber)).toEqual(['26300SJ000'])
  })
})
