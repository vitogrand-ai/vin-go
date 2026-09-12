import { describe, expect, test } from 'bun:test'

import { vinModelYear } from './vin-year'

describe('vinModelYear', () => {
  test('буква на 7-й позиции → цикл 2010+ (живой VW Jetta 2022, не 1992)', () => {
    expect(vinModelYear('LFV3B2FY2N3102396')).toBe(2022)
  })

  test('цифра на 7-й позиции → цикл 1980-2009', () => {
    // Живой VW из кэша прода: 7-я позиция «1», 10-я «3» → 2003.
    expect(vinModelYear('WVWZZZ1JZ3W386752')).toBe(2003)
  })

  test('регистр и пробелы не мешают', () => {
    expect(vinModelYear(' lfv3b2fy2n3102396 ')).toBe(2022)
  })

  test('frame-номер JDM года не кодирует', () => {
    expect(vinModelYear('SXA10-0012345')).toBeNull()
  })

  test('чужой код на 10-й позиции (I, O, Q, U, Z, ноль) → null', () => {
    expect(vinModelYear('WVWZZZ1JZ0W386752')).toBeNull()
  })

  test('год из будущего → правило к этому VIN не применимо', () => {
    // «Y» во втором цикле — 2030: столько ещё не прошло.
    expect(vinModelYear('LFV3B2FY2Y3102396')).toBeNull()
  })

  test('европейский Mercedes: правило даёт гипотезу, и она заведомо мимо', () => {
    // Машина 2019 года, а 10-я позиция «1» при цифре на 7-й даёт 2001 —
    // поэтому такой год годится только как подсказка каталогу, не как факт.
    expect(vinModelYear('WDD1770871V030773')).toBe(2001)
  })
})
