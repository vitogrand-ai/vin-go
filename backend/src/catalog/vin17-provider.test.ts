import { describe, expect, test } from 'bun:test'

import type { Vehicle } from '@web-app-demo/contracts'

import { AppError } from '../http/errors'
import {
  Vin17CatalogProvider,
  VIN17_MAX_PARTS,
  brandFromEpc,
  buildVin17Token,
  formatPeriod,
  mapDealerPrice,
  mapParts,
  mapVehicle,
  safeBase64,
  stripBrandPrefix,
} from './vin17-provider'
import { normalizeBrand, yearFromModelDetail } from './vin17-provider'

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
        illustration_img_address: '153008A.png',
        callout: '15650',
        cata_code: '1502_153008A-0001',
        replacement: '1565038021',
        remark_zh: '1GRFE..GRJ150',
        begin_date: '201005',
        end_date: '201311',
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

    // Поиск + узел первой детали: выноски поиск не отдаёт, их даёт только узел.
    expect(calls).toHaveLength(2)
    expect(new URL(calls[1]!).searchParams.get('action')).toBe('part')
    const url = new URL(calls[0]!)
    expect(url.pathname).toBe('/toyota')
    expect(url.searchParams.get('action')).toBe('search_epc_part_name')
    // «масляный фильтр» → 机油滤清器 (словарь part-terms)
    expect(url.searchParams.get('query_part_name')).toBe(safeBase64('机油滤清器'))
    expect(url.searchParams.get('query_part_name_is_safebase64')).toBe('1')

    expect(parts).toEqual([
      {
        oemNumber: '1565038020',
        name: 'CAP ASSY, OIL FILTER W/ELEMEMT',
        category: 'ENGINE OIL PUMP & OIL FILTER', // последний узел пути категорий
        brand: 'Toyota',
        // Схема приходит тем же ответом: отдельного запроса она не стоит.
        imageUrl: 'http://resource.17vin.com/img/toyota/153008A.png',
        position: '15650', // выноска «15650» подписана на самой картинке
        schemeId: '1502_153008A-0001',
        quantity: 1, // «01» каталога
        replacedBy: '1565038021', // заказывать надо новый номер
        note: '1GRFE..GRJ150', // мотор и шасси — чем деталь отличается от соседней
        appliesPeriod: '05.2010 — 11.2013',
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
    expect(calls).toHaveLength(3) // декод + поиск + узел
    expect(new URL(calls[1]!).pathname).toBe('/toyota')
    expect(parts).toHaveLength(1)
  })

  test('деталь получает координату своей выноски из узла — для обводки на схеме', async () => {
    const provider = providerWith((url) => {
      if (new URL(url).searchParams.get('action') === 'part') {
        return envelope(1, {
          partlist: [],
          all_img_hotspots: [
            {
              img_hotspots: {
                img_width: 760,
                img_height: 1112,
                hotspots: [
                  { callout: '15650', topleft_x: 56, topleft_y: 594 },
                  { callout: '15692', topleft_x: 383, topleft_y: 128 },
                ],
              },
            },
          ],
        })
      }
      return envelope(1, SEARCH_PAYLOAD)
    })

    const [part] = await provider.searchParts(vehicle, 'масляный фильтр')
    expect(part!.position).toBe('15650')
    expect(part!.schemeHotspot!.x).toBeCloseTo(56 / 760)
    expect(part!.schemeHotspot!.y).toBeCloseTo(594 / 1112)
  })

  test('узел не ответил — выдача уходит без обводки, а не падает', async () => {
    const provider = providerWith((url) => {
      if (new URL(url).searchParams.get('action') === 'part') throw new Error('ECONNRESET')
      return envelope(1, SEARCH_PAYLOAD)
    })

    const parts = await provider.searchParts(vehicle, 'масляный фильтр')
    expect(parts).toHaveLength(1)
    expect(parts[0]!.schemeHotspot).toBeUndefined()
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

describe('Vin17CatalogProvider.schemeParts', () => {
  const vehicle: Vehicle = {
    vin: VIN,
    make: 'Toyota',
    model: 'Prado',
    year: 2013,
    engine: '1GR',
    bodyType: null,
    raw: { epc: 'toyota' },
  }

  /** Живой ответ оп. 5105: узел целиком, без отбора по названию. */
  const SCHEME_PAYLOAD = {
    partlist: [
      {
        illustration_img_address: '153008A.png',
        callout: '15650',
        partnumber_original: '1565038020',
        name_en: 'CAP ASSY, OIL FILTER W/ELEMEMT',
        is_fit_for_this_vin: 1,
      },
      {
        illustration_img_address: '153008A.png',
        callout: '15692',
        partnumber_original: '1569231030',
        name_en: 'GASKET, OIL FILTER BRACKET',
        is_fit_for_this_vin: 1,
      },
      // Крепёж каталог отдаёт без названия и выноски — показывать нечего.
      { illustration_img_address: '153008A.png', callout: '', partnumber_original: '9012608056', name_en: '' },
    ],
    imgaddress: '153008A.png',
  }

  test('узел запрашивается оп. 5105 и отдаётся целиком, с выносками и схемой', async () => {
    const calls: string[] = []
    const provider = providerWith((url) => {
      calls.push(url)
      return envelope(1, SCHEME_PAYLOAD)
    })

    const parts = await provider.schemeParts(vehicle, '1502_153008A-0001')

    expect(calls).toHaveLength(1)
    const url = new URL(calls[0]!)
    expect(url.pathname).toBe('/toyota')
    expect(url.searchParams.get('action')).toBe('part')
    expect(url.searchParams.get('last_cata_code')).toBe('1502_153008A-0001')
    expect(url.searchParams.get('vin')).toBe(VIN)

    expect(parts).toEqual([
      {
        oemNumber: '1565038020',
        name: 'CAP ASSY, OIL FILTER W/ELEMEMT',
        category: '',
        brand: 'Toyota',
        imageUrl: 'http://resource.17vin.com/img/toyota/153008A.png',
        position: '15650',
        schemeId: '1502_153008A-0001',
        quantity: null,
        replacedBy: null,
        note: null,
        appliesPeriod: null,
      },
      {
        oemNumber: '1569231030',
        name: 'GASKET, OIL FILTER BRACKET',
        category: '',
        brand: 'Toyota',
        imageUrl: 'http://resource.17vin.com/img/toyota/153008A.png',
        position: '15692',
        schemeId: '1502_153008A-0001',
        quantity: null,
        replacedBy: null,
        note: null,
        appliesPeriod: null,
      },
    ])
  })

  test('нет epc в raw → восстановление повторным декодом, как в поиске', async () => {
    const calls: string[] = []
    const provider = providerWith((url) => {
      calls.push(url)
      if (new URL(url).pathname === '/') return envelope(1, DECODE_PAYLOAD)
      return envelope(1, SCHEME_PAYLOAD)
    })

    const parts = await provider.schemeParts({ ...vehicle, raw: {} }, '1502_153008A-0001')
    expect(calls).toHaveLength(2)
    expect(new URL(calls[1]!).pathname).toBe('/toyota')
    expect(parts).toHaveLength(2)
  })

  test('пустой идентификатор узла → без вызова API', async () => {
    const calls: string[] = []
    const provider = providerWith((url) => {
      calls.push(url)
      return envelope(1, SCHEME_PAYLOAD)
    })
    expect(await provider.schemeParts(vehicle, '  ')).toEqual([])
    expect(calls).toHaveLength(0)
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

  test('model_year_from_vin = «0» (европейский VIN) не отменяет год модели', () => {
    // Живой Mercedes W177 со скриншота пилота: в европейском VIN года нет,
    // 17vin отдаёт нулевой model_year_from_vin — год у него в Model_year.
    const vehicle = mapVehicle('WDD1770871V030773', {
      epc: 'benz',
      model_year_from_vin: '0',
      model_list: [
        {
          Brand_en: 'Mercedes-benz',
          Model_en: 'A200',
          Model_year: '2019',
          Model_detail_en: 'Mercedes-benz A-Class A200 1.3T DCT(7-speed) Dynamic Type 2019',
          Chassis_code: 'W177',
        },
      ],
    })
    expect(vehicle!.year).toBe(2019)
  })

  test('нулевой год и в модели → берём год из описания, а не показываем 0', () => {
    const vehicle = mapVehicle('WDD1770871V030773', {
      epc: 'benz',
      model_year_from_vin: '0',
      model_list: [
        {
          Brand_en: 'Mercedes-benz',
          Model_en: 'A200',
          Model_year: '0',
          Model_detail_en: 'Mercedes-benz A-Class A200 1.3T DCT(7-speed) Dynamic Type 2019',
        },
      ],
    })
    expect(vehicle!.year).toBe(2019)
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
    expect(mapParts({ searchlist }, { brand: 'Toyota', epc: 'toyota' })).toHaveLength(VIN17_MAX_PARTS)
  })

  test('поддерживает и partlist (оп. 5105), китайские имена как запасной вариант', () => {
    const parts = mapParts(
      { partlist: [{ partnumber_original: '091140G010', name_zh: '千斤顶把手' }] },
      { brand: null, epc: null },
    )
    expect(parts).toEqual([
      {
        oemNumber: '091140G010',
        name: '千斤顶把手',
        category: '',
        brand: null,
        imageUrl: null,
        position: null,
        schemeId: null,
        quantity: null,
        replacedBy: null,
        note: null,
        appliesPeriod: null,
      },
    ])
  })

  test('дубли (номер+название) схлопываются: деталь приходит строкой на каждую позицию', () => {
    const row = { partnumber: '34356890788', name_en: 'Brake pad wear sensor, front' }
    const parts = mapParts({ searchlist: [row, { ...row }, { ...row }] }, { brand: 'BMW', epc: 'bmw' })
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

describe('17vin: год и марка на живых нюансах прода', () => {
  test('год берётся из конца описания модели, когда каталог его не отдал', () => {
    expect(yearFromModelDetail('Mercedes-benz A-Class A200 1.3T DCT(7-speed) Dynamic Type 2019')).toBe(2019)
    // Год не в конце или его нет вовсе — null, а не случайное число из описания.
    expect(yearFromModelDetail('Lexus ES260 2.5L AMT(8-speed) F SPORT National V')).toBeNull()
    expect(yearFromModelDetail(null)).toBeNull()
  })

  test('составная марка приводится к читаемому виду', () => {
    expect(normalizeBrand('Mercedes-benz')).toBe('Mercedes-Benz')
    expect(normalizeBrand('alfa romeo')).toBe('Alfa Romeo')
    expect(normalizeBrand('bmw')).toBe('BMW')
    expect(normalizeBrand('toyota')).toBe('Toyota')
    expect(normalizeBrand('Lexus')).toBe('Lexus')
  })
})

describe('formatPeriod', () => {
  test('обе даты каталога → читаемый период', () => {
    expect(formatPeriod('201005', '201311')).toBe('05.2010 — 11.2013')
  })

  test('конец 999999 («ставится до сих пор») периодом не считается', () => {
    expect(formatPeriod('201202', '999999')).toBe('с 02.2012')
  })

  test('дат нет — периода нет', () => {
    expect(formatPeriod(null, null)).toBeNull()
    expect(formatPeriod('', '0')).toBeNull()
  })
})

describe('mapDealerPrice — цена оригинала у дилеров (оп. 4006)', () => {
  test('живой ответ Toyota: диапазон по дилерам в фэнях', () => {
    const price = mapDealerPrice({
      list: [
        { Brand: '丰田', Partnumber: '1565038020', Price: '438' },
        { Brand: '雷克萨斯', Partnumber: '1565038020', Price: '481' },
        { Brand: '四川一汽丰田', Partnumber: '1565038020', Price: '438' },
      ],
    })
    expect(price).toEqual({ min: 43800, max: 48100, currency: 'CNY', market: 'CN', dealers: 3 })
  })

  test('дробная цена переводится без потери копеек', () => {
    expect(mapDealerPrice({ list: [{ Price: '345.82' }] })?.min).toBe(34582)
  })

  test('нет цен или только мусор — цены нет', () => {
    expect(mapDealerPrice({ list: [] })).toBeNull()
    expect(mapDealerPrice({ list: [{ Price: '' }, { Price: '0' }, { Price: 'n/a' }] })).toBeNull()
  })

  test('номер уходит без пробелов и дефисов — как его знает каталог', async () => {
    const calls: string[] = []
    const provider = providerWith((url) => {
      calls.push(url)
      return envelope(1, [{ Price: '401.06' }])
    })
    const price = await provider.dealerPrice('000 098-713 a')
    expect(new URL(calls[0]!).searchParams.get('partnumber')).toBe('000098713A')
    expect(price?.min).toBe(40106)
  })
})
