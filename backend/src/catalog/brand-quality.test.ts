import { describe, expect, test } from 'bun:test'

import { classifyQuality, isOriginalBrand } from './brand-quality'

describe('classifyQuality', () => {
  test('топовые бренды → PREMIUM', () => {
    for (const brand of ['Bosch', 'Brembo', 'ZF', 'Sachs', 'Denso', 'Mann-Filter']) {
      expect(classifyQuality(brand)).toBe('PREMIUM')
    }
  })

  test('средний сегмент → AFTERMARKET', () => {
    for (const brand of ['Febi', 'Blue Print', 'Meyle', 'Nipparts', 'Stellox']) {
      expect(classifyQuality(brand)).toBe('AFTERMARKET')
    }
  })

  test('эконом → BUDGET', () => {
    for (const brand of ['Patron', 'StartVolt', 'Fenox', 'LYNXauto', 'Trialli']) {
      expect(classifyQuality(brand)).toBe('BUDGET')
    }
  })

  test('автопроизводители → OEM (включая китайцев и отечественных)', () => {
    for (const brand of ['Toyota', 'Volkswagen', 'Chery', 'Haval', 'LADA', 'ВАЗ']) {
      expect(classifyQuality(brand)).toBe('OEM')
    }
  })

  test('неизвестный бренд → AFTERMARKET (нейтральная середина)', () => {
    expect(classifyQuality('НекийНоунейм')).toBe('AFTERMARKET')
    expect(classifyQuality('')).toBe('AFTERMARKET')
  })

  test('регистр и разделители не важны', () => {
    expect(classifyQuality('  bOsCh ')).toBe('PREMIUM')
    expect(classifyQuality('MANN FILTER')).toBe('PREMIUM') // алиас через пробел
    expect(classifyQuality('mann-filter')).toBe('PREMIUM') // и через дефис
  })
})

describe('isOriginalBrand', () => {
  test('бренд автопроизводителя → true', () => {
    expect(isOriginalBrand('Toyota')).toBe(true)
    expect(isOriginalBrand('chery')).toBe(true)
    expect(isOriginalBrand('ВАЗ')).toBe(true)
  })

  test('афтемаркет-бренд и неизвестный → false', () => {
    expect(isOriginalBrand('Bosch')).toBe(false)
    expect(isOriginalBrand('Febi')).toBe(false)
    expect(isOriginalBrand('НекийНоунейм')).toBe(false)
  })
})
