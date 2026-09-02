import { describe, expect, test } from 'bun:test'

import type { Part } from '@web-app-demo/contracts'

import { filterByPosition } from './position-filter'

function part(name: string, category = ''): Part {
  return { oemNumber: name, name, category, brand: null }
}

describe('filterByPosition', () => {
  test('«передние» отрезает детали, явно помеченные rear/задними', () => {
    const parts = [
      part('Brake pad wear sensor, front'),
      part('Brake-pad sensor, rear'),
      part('Repair kit, brake pads asbestos-free'), // позиция не указана — остаётся
      part('Колодки тормозные задние'),
      part('Колодки тормозные передние'),
    ]

    const names = filterByPosition(parts, 'колодки передние').map((p) => p.name)
    expect(names).toEqual([
      'Brake pad wear sensor, front',
      'Repair kit, brake pads asbestos-free',
      'Колодки тормозные передние',
    ])
  })

  test('«задние» — зеркально', () => {
    const parts = [part('Колодки тормозные передние'), part('Колодки тормозные задние')]
    const names = filterByPosition(parts, 'задние колодки').map((p) => p.name)
    expect(names).toEqual(['Колодки тормозные задние'])
  })

  test('комплект на обе оси остаётся: упоминание нужной стороны спасает деталь', () => {
    const parts = [part('Brake pads set, front and rear')]
    expect(filterByPosition(parts, 'колодки передние')).toHaveLength(1)
  })

  test('запрос без позиции ничего не фильтрует', () => {
    const parts = [part('Колодки передние'), part('Колодки задние')]
    expect(filterByPosition(parts, 'колодки')).toHaveLength(2)
  })

  test('«передача» и «задача» не считаются позицией (корень + не «н»)', () => {
    const parts = [part('Колодки задние')]
    expect(filterByPosition(parts, 'коробка передач')).toHaveLength(1)
  })

  test('лево/право фильтруются независимо от перед/зад', () => {
    const parts = [
      part('Фара левая передняя'),
      part('Фара правая передняя'),
      part('Фонарь задний левый'),
    ]
    const names = filterByPosition(parts, 'фара передняя левая').map((p) => p.name)
    expect(names).toEqual(['Фара левая передняя'])
  })

  test('китайские позиции: 前 (перед) и 后 (зад)', () => {
    const parts = [part('前制动摩擦片'), part('后制动摩擦片'), part('制动摩擦片')]
    const names = filterByPosition(parts, 'колодки передние').map((p) => p.name)
    expect(names).toEqual(['前制动摩擦片', '制动摩擦片'])
  })
})
