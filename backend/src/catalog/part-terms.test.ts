import { describe, expect, test } from 'bun:test'

import { englishPartTerms, translatePartQuery } from './part-terms'

describe('translatePartQuery', () => {
  test('русская морфология и порядок слов не мешают сработке стемов', () => {
    expect(translatePartQuery('масляный фильтр')).toBe('机油滤清器')
    expect(translatePartQuery('фильтр масляный')).toBe('机油滤清器')
    expect(translatePartQuery('замена масляного фильтра')).toBe('机油滤清器')
    expect(translatePartQuery('колодки тормозные передние')).toBe('制动摩擦片')
    expect(translatePartQuery('свечи зажигания')).toBe('火花塞')
  })

  test('специфичная запись (2 стема) выигрывает у родовой (1 стем)', () => {
    expect(translatePartQuery('фильтр')).toBe('滤清器') // родовой
    expect(translatePartQuery('воздушный фильтр')).toBe('空气滤清器') // специфичный
    expect(translatePartQuery('радиатор')).toBe('散热器')
    expect(translatePartQuery('радиатор кондиционера')).toBe('冷凝器')
  })

  test('конфликты одиночных стемов решает порядок словаря', () => {
    // «приводной ремень» — это ремень (皮带), а не полуось (半轴 от стема «привод»).
    expect(translatePartQuery('приводной ремень')).toBe('皮带')
    expect(translatePartQuery('привод передний')).toBe('半轴')
    // «ремень ГРМ» — узел ГРМ (у части моторов цепь), а не просто ремень.
    expect(translatePartQuery('ремень грм')).toBe('正时')
  })

  test('ё нормализуется, регистр не важен', () => {
    expect(translatePartQuery('СтеклоподъЁмник')).toBe('升降')
  })

  test('подушка: двигателя → опоры, безопасности → airbag, одна — не переводится', () => {
    expect(translatePartQuery('подушка двигателя')).toBe('悬置')
    expect(translatePartQuery('подушка безопасности')).toBe('气囊')
    expect(translatePartQuery('подушка')).toBeNull()
  })

  test('маслоотделитель → родовой EPC-«сепаратор» (запрос с пилота)', () => {
    expect(translatePartQuery('маслоотделитель')).toBe('分离器')
    expect(translatePartQuery('замена маслоотделителя')).toBe('分离器')
  })

  test('клапанная крышка → 气缸盖罩; специфичнее одиночной «крышки» нет — та не переводится', () => {
    expect(translatePartQuery('клапанная крышка')).toBe('气缸盖罩')
    expect(translatePartQuery('крышка')).toBeNull()
  })

  test('неизвестный запрос → null (сырьё для пополнения словаря)', () => {
    expect(translatePartQuery('тормозная жидкость')).toBeNull()
    expect(translatePartQuery('какая-то штука')).toBeNull()
    expect(translatePartQuery('')).toBeNull()
  })
})

describe('englishPartTerms', () => {
  test('термины ищут нелокализованное название детали и не ловят соседей', () => {
    const terms = englishPartTerms('колодки тормозные передние')
    expect(terms).toContain('pad')
    // Так их использует parts-catalogs: подстрока в названии детали.
    expect(terms.some((t) => 'PAD KIT-FRONT DISK BRAKE'.toLowerCase().includes(t))).toBe(true)
    expect(terms.some((t) => 'BOLT-DISK BRAKE'.toLowerCase().includes(t))).toBe(false)
  })

  test('неизвестный запрос → пусто (остаётся точное совпадение по nameId)', () => {
    expect(englishPartTerms('тормозная жидкость')).toEqual([])
    expect(englishPartTerms('')).toEqual([])
  })
})
