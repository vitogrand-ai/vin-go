import { describe, expect, test } from 'bun:test'
import type { Vehicle } from '@web-app-demo/contracts'

import {
  extractTreeNodes,
  extractVariants,
  mapArticles,
  matchNodes,
  PartsApiCatalogProvider,
} from './partsapi-provider'

const VIN = 'WVWZZZ1JZ3W386752'

/**
 * Ответ VINdecode в реальной форме: модификации приходят словарём с числовыми
 * ключами, а не массивом (проверено на пилоте прототипа).
 */
const VIN_DECODE_RESPONSE = {
  statusMsg: 'OK',
  result: {
    '0': {
      carId: 123456,
      modId: 7788,
      manuId: 121,
      manuName: 'VW',
      modelName: 'GOLF IV (1J1)',
      typeName: '1.6',
      powerHpFrom: 105,
      yearOfConstrFrom: 2000,
      bodyStyle: 'Хэтчбек',
      fuelType: 'Бензин',
      cylinderCapacityLiter: '1.6',
    },
    '1': {
      carId: 123457,
      manuName: 'VW',
      modelName: 'GOLF IV (1J1)',
      typeName: '1.9 TDI',
      yearOfConstrFrom: 2000,
    },
  },
}

const SEARCH_TREE_RESPONSE = {
  result: [
    { STR_ID: 10, STR_ID_PARENT: 0, STR_NODE_NAME: 'Двигатель', STR_PATH: 'Двигатель' },
    {
      STR_ID: 11,
      STR_ID_PARENT: 10,
      STR_NODE_NAME: 'Корпус масляного фильтра',
      STR_PATH: 'Двигатель > Корпус масляного фильтра',
    },
    {
      STR_ID: 12,
      STR_ID_PARENT: 10,
      STR_NODE_NAME: 'Фильтр масляный',
      STR_PATH: 'Двигатель > Система смазки > Фильтр масляный',
    },
  ],
}

const ARTICLES_RESPONSE = {
  result: [
    {
      ART_ID: 1,
      ART_SUP_BRAND: 'MANN-FILTER',
      ART_ARTICLE_NR: 'W 914/2',
      'PRODUCT GROUP': 'Масляный фильтр',
    },
    {
      ART_ID: 2,
      ART_SUP_BRAND: 'BOSCH',
      ART_ARTICLE_NR: 'F 026 407 122',
      'PRODUCT GROUP': 'Масляный фильтр',
    },
    // Дубль артикула от другого поставщика данных — в выдаче должен быть один.
    {
      ART_ID: 3,
      ART_SUP_BRAND: 'MANN-FILTER',
      ART_ARTICLE_NR: 'W 914/2',
      'PRODUCT GROUP': 'Масляный фильтр',
    },
  ],
}

/** Фейковый fetch: отдаёт ответ по значению параметра `method`. */
function fakeFetch(responses: Record<string, unknown>, calls: string[] = []): typeof fetch {
  return (async (url: string | URL) => {
    const href = typeof url === 'string' ? url : url.toString()
    calls.push(href)
    const method = new URL(href).searchParams.get('method') ?? ''
    const body = responses[method]
    if (body === undefined) return new Response('', { status: 404 })
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

describe('extractVariants', () => {
  test('читает модификации из словаря с числовыми ключами', () => {
    expect(extractVariants(VIN_DECODE_RESPONSE)).toHaveLength(2)
  })

  test('терпит форму с массивом', () => {
    expect(extractVariants({ result: [{ carId: 1 }] })).toHaveLength(1)
  })

  test('пустой или чужой ответ даёт пустой список', () => {
    expect(extractVariants({ statusMsg: 'NOT FOUND' })).toEqual([])
    expect(extractVariants(null)).toEqual([])
    expect(extractVariants('нет')).toEqual([])
  })
})

describe('PartsApiCatalogProvider.decodeVin', () => {
  test('возвращает карточку автомобиля с carId для следующих шагов', async () => {
    const provider = new PartsApiCatalogProvider({
      apiKey: 'k',
      fetchImpl: fakeFetch({ VINdecode: VIN_DECODE_RESPONSE }),
    })

    const vehicle = await provider.decodeVin(VIN)

    expect(vehicle?.make).toBe('VW')
    expect(vehicle?.model).toBe('GOLF IV (1J1)')
    expect(vehicle?.year).toBe(2000)
    expect(vehicle?.engine).toContain('1.6')
    expect(vehicle?.bodyType).toBe('Хэтчбек')
    // Без carId последующие getSearchTree/getArticles невозможны.
    expect(vehicle?.raw?.carId).toBe(123456)
  })

  test('сохраняет все модификации — мастеру может понадобиться выбрать другую', async () => {
    const provider = new PartsApiCatalogProvider({
      apiKey: 'k',
      fetchImpl: fakeFetch({ VINdecode: VIN_DECODE_RESPONSE }),
    })

    const vehicle = await provider.decodeVin(VIN)

    expect(vehicle?.raw?.variants).toHaveLength(2)
  })

  test('неизвестный VIN — это null, а не ошибка', async () => {
    const provider = new PartsApiCatalogProvider({
      apiKey: 'k',
      fetchImpl: fakeFetch({ VINdecode: { statusMsg: 'NOT FOUND', result: {} } }),
    })

    expect(await provider.decodeVin(VIN)).toBeNull()
  })

  test('на демо-тарифе используется ключ конкретного метода', async () => {
    const calls: string[] = []
    const provider = new PartsApiCatalogProvider({
      apiKey: 'общий',
      methodKeys: { VINdecode: 'ключ-вин' },
      fetchImpl: fakeFetch({ VINdecode: VIN_DECODE_RESPONSE }, calls),
    })

    await provider.decodeVin(VIN)

    expect(new URL(calls[0]!).searchParams.get('key')).toBe('ключ-вин')
  })
})

describe('matchNodes', () => {
  const nodes = extractTreeNodes(SEARCH_TREE_RESPONSE)

  test('точное совпадение имени идёт впереди вхождения', () => {
    // «Корпус масляного фильтра» — другая деталь и другая цена. Точное
    // совпадение обязано выиграть, иначе мастеру придёт не то.
    expect(matchNodes(nodes, 'Фильтр масляный')[0]?.name).toBe('Фильтр масляный')
  })

  test('регистр и «ё» не мешают', () => {
    expect(matchNodes(nodes, 'фильтр масляный')[0]?.strId).toBe(12)
  })

  test('пустой запрос не даёт кандидатов', () => {
    expect(matchNodes(nodes, '   ')).toEqual([])
  })

  test('неизвестная категория не даёт кандидатов', () => {
    expect(matchNodes(nodes, 'катапульта')).toEqual([])
  })
})

describe('mapArticles', () => {
  test('артикулы становятся запчастями с брендом', () => {
    const parts = mapArticles(ARTICLES_RESPONSE, 'Фильтр масляный')
    expect(parts[0]).toEqual({
      oemNumber: 'W 914/2',
      name: 'Масляный фильтр',
      category: 'Фильтр масляный',
      brand: 'MANN-FILTER',
    })
  })

  test('повторяющийся артикул попадает в выдачу один раз', () => {
    expect(mapArticles(ARTICLES_RESPONSE, 'Фильтр масляный')).toHaveLength(2)
  })

  test('запись без артикула пропускается', () => {
    expect(mapArticles({ result: [{ ART_ID: 9, ART_SUP_BRAND: 'X' }] }, 'Фильтр')).toEqual([])
  })
})

describe('PartsApiCatalogProvider.searchParts', () => {
  const vehicle: Vehicle = {
    vin: VIN,
    make: 'VW',
    model: 'GOLF IV (1J1)',
    year: 2000,
    engine: '1.6',
    bodyType: 'Хэтчбек',
    raw: { carId: 123456 },
  }

  test('проходит цепочку дерево → артикулы', async () => {
    const calls: string[] = []
    const provider = new PartsApiCatalogProvider({
      apiKey: 'k',
      fetchImpl: fakeFetch(
        { getSearchTree: SEARCH_TREE_RESPONSE, getArticles: ARTICLES_RESPONSE },
        calls,
      ),
    })

    const parts = await provider.searchParts(vehicle, 'Фильтр масляный')

    expect(parts).toHaveLength(2)
    // Спрошен именно точно совпавший узел (12), а не «Корпус масляного фильтра».
    const articlesCall = calls.find((call) => call.includes('getArticles'))
    expect(new URL(articlesCall!).searchParams.get('strId')).toBe('12')
  })

  test('без carId поиск не делает ни одного платного вызова', async () => {
    const calls: string[] = []
    const provider = new PartsApiCatalogProvider({
      apiKey: 'k',
      fetchImpl: fakeFetch({ getSearchTree: SEARCH_TREE_RESPONSE }, calls),
    })

    const parts = await provider.searchParts({ ...vehicle, raw: undefined }, 'Фильтр масляный')

    expect(parts).toEqual([])
    expect(calls).toHaveLength(0)
  })

  test('категория не найдена в дереве — пустая выдача без запроса артикулов', async () => {
    const calls: string[] = []
    const provider = new PartsApiCatalogProvider({
      apiKey: 'k',
      fetchImpl: fakeFetch(
        { getSearchTree: SEARCH_TREE_RESPONSE, getArticles: ARTICLES_RESPONSE },
        calls,
      ),
    })

    const parts = await provider.searchParts(vehicle, 'катапульта')

    expect(parts).toEqual([])
    expect(calls.some((call) => call.includes('getArticles'))).toBe(false)
  })

  test('русский язык запрашивается явно — иначе дерево придёт латиницей', async () => {
    const calls: string[] = []
    const provider = new PartsApiCatalogProvider({
      apiKey: 'k',
      fetchImpl: fakeFetch({ getSearchTree: SEARCH_TREE_RESPONSE }, calls),
    })

    await provider.searchParts(vehicle, 'Фильтр масляный')

    expect(new URL(calls[0]!).searchParams.get('lang')).toBe('16')
  })
})
