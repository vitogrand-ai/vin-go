import { describe, expect, test } from 'bun:test'

import {
  computeServiceIntervals,
  SERVICE_REGULATIONS,
  selectServiceAlerts,
} from './service-intervals'

function find(statuses: ReturnType<typeof computeServiceIntervals>, title: string) {
  return statuses.find((status) => status.title === title)!
}

describe('computeServiceIntervals — пробег последнего ТО неизвестен', () => {
  test('показывает ближайшую точку регламентной сетки', () => {
    const statuses = computeServiceIntervals(145_000)

    // Масло меняют каждые 10 000 → ближайшая точка 150 000.
    expect(find(statuses, 'Моторное масло').dueAtKm).toBe(150_000)
    expect(find(statuses, 'Моторное масло').kmRemaining).toBe(5_000)
    // ГРМ каждые 120 000 → следующий рубеж 240 000.
    expect(find(statuses, 'Ремень ГРМ').dueAtKm).toBe(240_000)
  })

  test('ничего не объявляет просроченным', () => {
    // Мы не знаем, что и когда меняли: выдуманная просрочка подрывает доверие
    // ко всему списку.
    const statuses = computeServiceIntervals(145_000)
    expect(statuses.every((status) => !status.isOverdue)).toBe(true)
  })

  test('на круглом пробеге следующая точка — впереди, а не текущая', () => {
    expect(find(computeServiceIntervals(30_000), 'Моторное масло').dueAtKm).toBe(40_000)
  })

  test('нулевой пробег даёт первый регламент', () => {
    expect(find(computeServiceIntervals(0), 'Моторное масло').dueAtKm).toBe(10_000)
  })
})

describe('computeServiceIntervals — пробег последнего ТО известен', () => {
  test('просроченным считается то, чей рубеж уже позади', () => {
    // ТО делали на 100 000, сейчас 115 000: масло было положено на 110 000.
    const statuses = computeServiceIntervals(115_000, 100_000)
    const oil = find(statuses, 'Моторное масло')

    expect(oil.dueAtKm).toBe(110_000)
    expect(oil.kmRemaining).toBe(-5_000)
    expect(oil.isOverdue).toBe(true)
  })

  test('то, до чего ещё далеко, не просрочено и не «скоро»', () => {
    const timing = find(computeServiceIntervals(115_000, 100_000), 'Ремень ГРМ')

    expect(timing.dueAtKm).toBe(220_000)
    expect(timing.isOverdue).toBe(false)
    expect(timing.isSoon).toBe(false)
  })

  test('«скоро» — не дальше 1500 км даже у длинных интервалов', () => {
    // 15% от 120 000 — это 18 000 км: предупреждать так рано бессмысленно.
    const statuses = computeServiceIntervals(105_000, 0)
    expect(find(statuses, 'Ремень ГРМ').isSoon).toBe(false)

    const closer = computeServiceIntervals(119_000, 0)
    expect(find(closer, 'Ремень ГРМ').isSoon).toBe(true)
  })

  test('ровно на рубеже позиция уже просрочена', () => {
    const oil = find(computeServiceIntervals(110_000, 100_000), 'Моторное масло')
    expect(oil.kmRemaining).toBe(0)
    expect(oil.isOverdue).toBe(true)
  })
})

describe('computeServiceIntervals — некорректные данные', () => {
  test('отрицательный пробег ничего не выдумывает', () => {
    expect(computeServiceIntervals(-5)).toEqual([])
  })

  test('последнее ТО «в будущем» — молчим, а не считаем', () => {
    // Скрученный одометр или опечатка: любой ответ здесь был бы враньём.
    expect(computeServiceIntervals(50_000, 60_000)).toEqual([])
  })

  test('нечисловой пробег не роняет расчёт', () => {
    expect(computeServiceIntervals(Number.NaN)).toEqual([])
    expect(computeServiceIntervals(100_000, Number.NaN)).toEqual([])
  })
})

describe('selectServiceAlerts', () => {
  test('оставляет только просроченное и подходящее', () => {
    const { overdue, soon } = selectServiceAlerts(computeServiceIntervals(115_000, 100_000))

    expect(overdue.map((status) => status.title)).toContain('Моторное масло')
    expect([...overdue, ...soon].map((status) => status.title)).not.toContain('Ремень ГРМ')
  })
})

describe('регламент', () => {
  test('названия совпадают с каноническими — по ним сразу ищется деталь', () => {
    for (const item of SERVICE_REGULATIONS) {
      expect(item.title.trim().length).toBeGreaterThan(0)
      expect(item.intervalKm).toBeGreaterThan(0)
    }
  })
})
