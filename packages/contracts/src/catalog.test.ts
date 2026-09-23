import { describe, expect, test } from 'bun:test'

import {
  frameSchema,
  offerTierSchema,
  partsWithVariants,
  plateSchema,
  schemePartsRequestSchema,
  searchPartsRequestSchema,
  vinOrFrameSchema,
  vinSchema,
} from './catalog'

describe('vinSchema', () => {
  test('принимает корректный VIN и приводит к верхнему регистру', () => {
    const result = vinSchema.parse('  wvwzzz1jz3w386752 ')
    expect(result).toBe('WVWZZZ1JZ3W386752')
  })

  test('отвергает VIN неверной длины', () => {
    expect(() => vinSchema.parse('ABC123')).toThrow()
  })

  test('отвергает запрещённые символы I, O, Q', () => {
    expect(() => vinSchema.parse('WVWZZZ1JZ3W38675O')).toThrow()
    expect(() => vinSchema.parse('IWVWZZZ1JZ3W38675')).toThrow()
    expect(() => vinSchema.parse('QWVWZZZ1JZ3W38675')).toThrow()
  })
})

describe('frameSchema (номер кузова JDM)', () => {
  test('принимает frame и приводит к верхнему регистру', () => {
    expect(frameSchema.parse(' sxa10-0012345 ')).toBe('SXA10-0012345')
    expect(frameSchema.parse('NZE121-3123456')).toBe('NZE121-3123456')
  })

  test('отвергает строки без дефиса и без серийной части', () => {
    expect(() => frameSchema.parse('SXA100012345')).toThrow()
    expect(() => frameSchema.parse('SXA10-')).toThrow()
    expect(() => frameSchema.parse('-0012345')).toThrow()
  })
})

describe('vinOrFrameSchema (единый идентификатор авто)', () => {
  test('принимает и VIN, и frame', () => {
    expect(vinOrFrameSchema.parse('WVWZZZ1JZ3W386752')).toBe('WVWZZZ1JZ3W386752')
    expect(vinOrFrameSchema.parse('sxa10-0012345')).toBe('SXA10-0012345')
  })

  test('отвергает мусор', () => {
    expect(() => vinOrFrameSchema.parse('ABC123')).toThrow()
  })

  test('searchPartsRequestSchema принимает frame вместо VIN', () => {
    const parsed = searchPartsRequestSchema.parse({ vin: 'SXA10-0012345', query: 'колодки' })
    expect(parsed.vin).toBe('SXA10-0012345')
  })
})

describe('searchPartsRequestSchema', () => {
  test('требует непустой запрос', () => {
    expect(() => searchPartsRequestSchema.parse({ vin: 'WVWZZZ1JZ3W386752', query: '' })).toThrow()
  })

  test('тримит запрос и нормализует VIN', () => {
    const result = searchPartsRequestSchema.parse({
      vin: 'wvwzzz1jz3w386752',
      query: '  тормозные колодки  ',
    })
    expect(result.vin).toBe('WVWZZZ1JZ3W386752')
    expect(result.query).toBe('тормозные колодки')
  })
})

describe('plateSchema', () => {
  test('нормализует пробелы и регистр', () => {
    expect(plateSchema.parse(' а123вс 777 ')).toBe('А123ВС777')
  })

  test('переводит латинские двойники в кириллицу', () => {
    // Латинские A,B,C при вводе превращаются в кириллические А,В,С.
    expect(plateSchema.parse('A123BC777')).toBe('А123ВС777')
  })

  test('принимает 2- и 3-значный регион', () => {
    expect(plateSchema.parse('О001АА99')).toBe('О001АА99')
    expect(plateSchema.parse('Е777КХ797')).toBe('Е777КХ797')
  })

  test('отвергает некорректный формат', () => {
    expect(() => plateSchema.parse('123456')).toThrow()
    expect(() => plateSchema.parse('АБ123ВС77')).toThrow() // Б не разрешена
  })
})

describe('offerTierSchema', () => {
  test('содержит три тира', () => {
    expect(offerTierSchema.options).toEqual(['ECONOMY', 'BALANCED', 'ORIGINAL'])
  })
})

describe('partsWithVariants', () => {
  const battery = (oemNumber: string) => ({
    oemNumber,
    name: 'Батарея аккумуляторная',
    schemeId: 'FORD-10655',
    position: '10655',
  })

  test('несколько номеров под одной выноской узла — исполнения одной позиции', () => {
    // Живой Ford Mondeo: пять АКБ под позицией 10655, различаются только ёмкостью.
    const parts = [battery('1935737'), battery('1917577'), { ...battery('5245802'), position: '10732' }]
    expect([...partsWithVariants(parts)]).toEqual(['1935737', '1917577'])
  })

  test('разные позиции и разные детали — не исполнения', () => {
    const parts = [
      { oemNumber: '26232FL003', name: 'PAD CLIP-FRONT BRAKE', schemeId: 'S1', position: '26232' },
      { oemNumber: '26296SJ020', name: 'PAD KIT-FRONT DISK BRAKE', schemeId: 'S1', position: '26296' },
    ]
    expect(partsWithVariants(parts).size).toBe(0)
  })

  test('без схемы исполнения узнаются по одинаковому названию', () => {
    const parts = [
      { oemNumber: '566941015F', name: 'Фара головного света' },
      { oemNumber: '566941016F', name: 'фара головного света ' },
      { oemNumber: '06A115561B', name: 'Фильтр масляный двигателя' },
    ]
    expect([...partsWithVariants(parts)]).toEqual(['566941015F', '566941016F'])
  })

  test('одна позиция из разных узлов — не исполнения: номер выноски свой у каждой схемы', () => {
    const parts = [battery('1935737'), { ...battery('1917577'), schemeId: 'OTHER' }]
    expect(partsWithVariants(parts).size).toBe(0)
  })
})

describe('schemePartsRequestSchema', () => {
  test('без номера выноски — запрос всего узла', () => {
    const parsed = schemePartsRequestSchema.parse({ vin: 'WVWZZZ1JZ3W386752', schemeId: ' G1 ' })
    expect(parsed.schemeId).toBe('G1')
    expect(parsed.position).toBeUndefined()
  })

  test('номер выноски обрезается по краям', () => {
    const parsed = schemePartsRequestSchema.parse({
      vin: 'WVWZZZ1JZ3W386752',
      schemeId: 'G1',
      position: ' 9 ',
    })
    expect(parsed.position).toBe('9')
  })

  test('узел без идентификатора не открыть', () => {
    expect(() => schemePartsRequestSchema.parse({ vin: 'WVWZZZ1JZ3W386752', schemeId: '  ' })).toThrow()
  })
})
