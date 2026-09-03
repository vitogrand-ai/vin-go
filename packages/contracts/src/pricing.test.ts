import { describe, expect, test } from 'bun:test'

import { applyMarkup, bpsToPercent, marginPercent, markupBpsSchema, percentToBps } from './pricing'

describe('наценка', () => {
  test('applyMarkup: 20% на 1 000 ₽ = 1 200 ₽, копейки округляются', () => {
    expect(applyMarkup(100_000, 2_000)).toBe(120_000)
    // 33,3% на 999 ₽ = 1331,667 ₽ → 1331,67 ₽
    expect(applyMarkup(99_900, 3_330)).toBe(133_167)
    expect(applyMarkup(0, 5_000)).toBe(0)
    expect(applyMarkup(12_345, 0)).toBe(12_345)
  })

  test('проценты ↔ базисные пункты без потери десятых', () => {
    expect(percentToBps(20.5)).toBe(2_050)
    expect(bpsToPercent(2_050)).toBe(20.5)
    expect(percentToBps(bpsToPercent(3_333))).toBe(3_333)
  })

  test('marginPercent считает фактическую наценку по паре закуп/продажа', () => {
    expect(marginPercent(98_000, 242_700)).toBe(147.7)
    expect(marginPercent(0, 100)).toBe(0)
    expect(marginPercent(100, 100)).toBe(0)
  })

  test('markupBpsSchema отвергает отрицательные, дробные и абсурдные значения', () => {
    expect(markupBpsSchema.safeParse(2_000).success).toBe(true)
    expect(markupBpsSchema.safeParse(-1).success).toBe(false)
    expect(markupBpsSchema.safeParse(20.5).success).toBe(false)
    expect(markupBpsSchema.safeParse(100_001).success).toBe(false)
  })
})
