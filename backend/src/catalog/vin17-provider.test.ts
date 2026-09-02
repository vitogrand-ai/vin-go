import { describe, expect, test } from 'bun:test'

import type { Vehicle } from '@web-app-demo/contracts'

import { AppError } from '../http/errors'
import {
  Vin17CatalogProvider,
  VIN17_MAX_PARTS,
  brandFromEpc,
  buildVin17Token,
  mapParts,
  mapVehicle,
  safeBase64,
  stripBrandPrefix,
} from './vin17-provider'

/** Стаб fetch: отвечает заданной функцией, без реальной сети. */
function stubFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: unknown) => handler(String(input))) as unknown as typeof fetch
}

function providerWith(handler: (url: string) => Response): Vin17CatalogProvider {
  return new Vin17CatalogProvider({
    user: 'myuser',
    password: 'mypass',
    baseUrl: 'http://api.17vin.test:8080',
    fetchImpl: stubFetch(handler),
  })
}

function envelope(code: number, data: unknown = null, msg = ''): Response {
  return new Response(JSON.stringify({ code, msg, data }), { status: 200 })
}

const VIN = 'LFMGJE720DS070251'

/** Payload декодирования в формате живого ответа 17vin (проверен реальным вызовом). */
const DECODE_PAYLOAD = {
  full_vin: VIN,
  model_year_from_vin: '2013',
  epc: 'toyota',
  brand: '丰田',
  build_date: '201309',
  model_list: [
    {
      Brand_en: 'Toyota',
      Series_en: 'Prado',
      Model_en: 'Prado',
      Model_detail_en: 'Toyota Prado 4.0L AMT(5-speed) Four-wheel Drive TX-L 2010',
      Model_year: '2010',
      Engine_no_en: '1GR',
      Chassis_code: 'J150',
    },
  ],
}

describe('buildVin17Token / safeBase64', () => {
  test('токен = MD5(MD5(user)+MD5(pass)+путь) — фиксированный вектор', () => {
    // Алгоритм подтверждён по документационному примеру 17vin байт-в-байт.
    expect(buildVin17Token('myuser', 'mypass', '/?vin=TEST123')).toBe(
      'e8fb973be43ef373e7def292a45a226f',
    )
  })

  test('safeBase64 совпадает с примером из документации 17vin (URL-safe, без паддинга)', () => {
    expect(safeBase64('千斤顶把手加长杆分总成')).toBe('5Y2D5pak6aG25oqK5omL5Yqg6ZW_5p2G5YiG5oC75oiQ')
    expect(safeBase64('机油滤清器')).toBe('5py65rK55ruk5riF5Zmo')
  })
})

describe('Vin17CatalogProvider.decodeVin', () => {
  test('подписанный запрос → карточка авто с epc в raw', async () => {
    const calls: string[] = []
    const provider = providerWith((url) => {
      calls.push(url)
      return envelope(1, DECODE_PAYLOAD)
    })

    const vehicle = await provider.decodeVin(` ${VIN.toLowerCase()} `)

    expect(calls).toHaveLength(1)
    const url = new URL(calls[0]!)
    expect(url.searchParams.get('vin')).toBe(VIN) // нормализация: trim + верхний регистр
    expect(url.searchParams.get('user')).toBe('myuser')
    expect(url.searchParams.get('token')).toBe(
      buildVin17Token('myuser', 'mypass', `/?vin=${VIN}`),
    )

    expect(vehicle).not.toBeNull()
    expect(vehicle!.make).toBe('Toyota')
    expect(vehicle!.model).toBe('Prado')
    expect(vehicle!.year).toBe(2013) // год из VIN точнее года поколения (2010)
    expect(vehicle!.engine).toBe('1GR')
    expect(vehicle!.raw?.['epc']).toBe('toyota')
  })

  test('code 0 (нет данных) → null, это не ошибка', async () => {
    const provider = providerWith(() => envelope(0, '', '请求返回无数据'))
    expect(await provider.decodeVin(VIN)).toBeNull()
  })

  test('code 1005 (баланс исчерпан) → AppError(502) с кодом, а НЕ «не найдено»', async () => {
    const provider = providerWith(() => envelope(1005, '', '查询次数耗尽或到期'))
    const error = await provider.decodeVin(VIN).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).status).toBe(502)
    expect((error as AppError).message).toContain('1005')
  })

  test('сетевой сбой → бросок AppError(502)', async () => {
    const provider = new Vin17CatalogProvider({
      user: 'myuser',
      password: 'mypass',
      fetchImpl: (() => {
        throw new Error('ECONNRESET')
      }) as unknown as typeof fetch,
    })
    const error = await provider.decodeVin(VIN).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).status).toBe(502)
  })
})

describe('Vin17CatalogProvider.searchParts', () => {
  const vehicle: Vehicle = {
    vin: VIN,
    make: 'Toyota',
    model: 'Prado',
    year: 2013,
    engine: '1GR',
    bodyType: null,
    raw: { epc: 'toyota' },
  }

  const SEARCH_PAYLOAD = {
    searchlist: [
      {
        cata_name_en: '4>1502_0001>ENGINE OIL PUMP & OIL FILTER',
        partnumber_original: '1565038020',
        partnumber: '1565038020',
        name_en: 'CAP ASSY, OIL FILTER W/ELEMEMT',
        name_zh: '带滤芯的机油滤清器盖总成',
        qty: '01',
        is_fit_for_this_vin: 1,
      },
      { partnumber: 'X1', name_en: 'NOT FOR THIS CAR', is_fit_for_this_vin: 0 }, // не для этого VIN
      { partnumber: '', name_en: 'NO NUMBER' }, // без номера — бесполезна
    ],
  }

  test('русский запрос переводится в китайский EPC-термин; маппинг и фильтры', async () => {
    const calls: string[] = []
    const provider = providerWith((url) => {
      calls.push(url)
      return envelope(1, SEARCH_PAYLOAD)
    })

    const parts = await provider.searchParts(vehicle, 'масляный фильтр')

    expect(calls).toHaveLength(1)
    const url = new URL(calls[0]!)
    expect(url.pathname).toBe('/toyota')
    expect(url.searchParams.get('action')).toBe('search_epc_part_name')
    // «масляный фильтр» → 机油滤清器 (словарь part-query-zh)
    expect(url.searchParams.get('query_part_name')).toBe(safeBase64('机油滤清器'))
    expect(url.searchParams.get('query_part_name_is_safebase64')).toBe('1')

    expect(parts).toEqual([
      {
        oemNumber: '1565038020',
        name: 'CAP ASSY, OIL FILTER W/ELEMEMT',
        category: 'ENGINE OIL PUMP & OIL FILTER', // последний узел пути категорий
        brand: 'Toyota',
      },
    ])
  })

  test('нет epc в raw (авто определял другой каталог) → восстановление через повторный декод', async () => {
    const calls: string[] = []
    const provider = providerWith((url) => {
      calls.push(url)
      if (new URL(url).pathname === '/') return envelope(1, DECODE_PAYLOAD)
      return envelope(1, SEARCH_PAYLOAD)
    })

    const parts = await provider.searchParts({ ...vehicle, raw: {} }, 'фильтр')
    expect(calls).toHaveLength(2)
    expect(new URL(calls[1]!).pathname).toBe('/toyota')
    expect(parts).toHaveLength(1)
  })

  test('русский запрос без перевода → пустой список БЕЗ вызова API (иначе шум всего каталога)', async () => {
    const calls: string[] = []
    const provider = providerWith((url) => {
      calls.push(url)
      return envelope(1, SEARCH_PAYLOAD)
    })
    expect(await provider.searchParts(vehicle, 'загадочная деталь')).toEqual([])
    expect(calls).toHaveLength(0)
  })

  test('китайский запрос уходит как есть, без перевода', async () => {
    const calls: string[] = []
    const provider = providerWith((url) => {
      calls.push(url)
      return envelope(1, SEARCH_PAYLOAD)
    })
    await provider.searchParts(vehicle, '机油滤清器')
    expect(new URL(calls[0]!).searchParams.get('query_part_name')).toBe(safeBase64('机油滤清器'))
  })

  test('латинский запрос: шумная нечёткая выдача дофильтровывается по названию', async () => {
    const provider = providerWith(() =>
      envelope(1, {
        searchlist: [
          {
            cata_name_en: '4>1502_0001>LUBRICATION',
            partnumber: '1565038020',
            name_en: 'CAP ASSY, OIL FILTER W/ELEMEMT',
          },
          // Шум нечёткого поиска: название не содержит слов запроса.
          { cata_name_en: '4>8719_0001>HEATING', partnumber: '90178C0034', name_en: 'STANDARD TOOL' },
        ],
      }),
    )
    const parts = await provider.searchParts(vehicle, 'oil filter')
    expect(parts).toHaveLength(1)
    expect(parts[0]!.oemNumber).toBe('1565038020')
  })

  test('code 1003 (бренд не поддержан) → пустой список, а не ошибка', async () => {
    const provider = providerWith(() => envelope(1003, '', '不支持的品牌接口'))
    expect(await provider.searchParts(vehicle, 'фильтр')).toEqual([])
  })
})

describe('mapVehicle', () => {
  test('без марки и модели → null (VIN не опознан)', () => {
    expect(mapVehicle(VIN, { full_vin: VIN, model_list: [] })).toBeNull()
  })

  test('model_list пуст → фолбэк на атрибуты оригинального EPC (импортный BMW)', () => {
    // Живой формат ответа для WBA…: китайская база модель не знает,
    // но EPC отдаёт CarAttributes в парах zh/en.
    const vehicle = mapVehicle('WBAJP51070BJ28779', {
      epc: 'bmw',
      brand: '',
      model_year_from_vin: '2018',
      model_list: [],
      model_original_epc_list: [
        {
          Epc_id: 12541,
          CarAttributes: [
            { Language: 'zh', Col_name: '品牌', Col_value: '宝马' },
            { Language: 'en', Col_name: 'Brand', Col_value: 'bmw' },
            { Language: 'en', Col_name: 'Model', Col_value: '520dX' },
            { Language: 'en', Col_name: 'Series And Chassis No', Col_value: "5' G31 Touring" },
            { Language: 'en', Col_name: 'Year', Col_value: '2018' },
            { Language: 'en', Col_name: 'Engine', Col_value: 'B47D' },
            { Language: 'en', Col_name: 'Body', Col_value: 'Touring' },
          ],
        },
      ],
    })

    expect(vehicle).not.toBeNull()
    expect(vehicle!.make).toBe('BMW') // нижний регистр EPC нормализован
    expect(vehicle!.model).toBe('520dX')
    expect(vehicle!.year).toBe(2018)
    expect(vehicle!.engine).toBe('B47D')
    expect(vehicle!.bodyType).toBe('Touring')
    expect(vehicle!.raw?.['epc']).toBe('bmw') // поиск деталей остаётся возможен
  })

  test('модель без английских полей → китайский brand как запасной вариант', () => {
    const vehicle = mapVehicle(VIN, { brand: '丰田', model_list: [{ Model_en: 'Prado' }] })
    expect(vehicle!.make).toBe('丰田')
  })
})

describe('mapParts', () => {
  test('нечёткая выдача ограничена потолком VIN17_MAX_PARTS', () => {
    const searchlist = Array.from({ length: VIN17_MAX_PARTS + 50 }, (_, i) => ({
      partnumber: `P${i}`,
      name_en: `PART ${i}`,
    }))
    expect(mapParts({ searchlist }, 'Toyota')).toHaveLength(VIN17_MAX_PARTS)
  })

  test('поддерживает и partlist (оп. 5105), китайские имена как запасной вариант', () => {
    const parts = mapParts(
      { partlist: [{ partnumber_original: '091140G010', name_zh: '千斤顶把手' }] },
      null,
    )
    expect(parts).toEqual([
      { oemNumber: '091140G010', name: '千斤顶把手', category: '', brand: null },
    ])
  })

  test('дубли (номер+название) схлопываются: деталь приходит строкой на каждую позицию', () => {
    const row = { partnumber: '34356890788', name_en: 'Brake pad wear sensor, front' }
    const parts = mapParts({ searchlist: [row, { ...row }, { ...row }] }, 'BMW')
    expect(parts).toHaveLength(1)
  })
})

describe('brandFromEpc / stripBrandPrefix', () => {
  test('марка берётся из кода каталога, когда поля brand нет (живой случай: корейцы)', () => {
    expect(brandFromEpc('hyundai', 'HYUNDAI REURPH517 ACCENT/SOLARIS 17 (2017-2020)')).toBe('Hyundai')
  })

  test('мультибрендовый код каталога маркой не считается', () => {
    expect(brandFromEpc('audi_vw', 'GOLF BLUEMOTION')).toBe('Golf')
  })

  test('код каталога с цифрами за марку не принимается', () => {
    expect(brandFromEpc('audi_vw', 'REURPH517 ACCENT')).toBeNull()
  })

  test('дублирующий префикс марки из модели убирается', () => {
    expect(stripBrandPrefix('HYUNDAI REURPH517 ACCENT/SOLARIS 17', 'Hyundai')).toBe(
      'REURPH517 ACCENT/SOLARIS 17',
    )
  })

  test('модель, состоящая только из марки, остаётся как есть', () => {
    expect(stripBrandPrefix('Hyundai', 'Hyundai')).toBe('Hyundai')
  })

  test('модель без префикса не трогается', () => {
    expect(stripBrandPrefix('Camry 70', 'Toyota')).toBe('Camry 70')
  })
})
