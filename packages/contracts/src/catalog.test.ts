import { describe, expect, test } from 'bun:test'

import {
  offerTierSchema,
  plateSchema,
  searchPartsRequestSchema,
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
