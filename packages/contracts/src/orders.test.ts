import { describe, expect, test } from 'bun:test'

import { addOrderWorkRequestSchema, updateOrderReceptionRequestSchema } from './orders'

describe('заказ-наряд: работы и приём машины', () => {
  test('работа: цена в копейках целым числом, название обязательно', () => {
    const parsed = addOrderWorkRequestSchema.parse({
      orderId: 'o1',
      name: '  Замена колодок  ',
      amount: 250_000,
    })
    expect(parsed.name).toBe('Замена колодок')
    expect(parsed.quantity).toBeUndefined()
    expect(addOrderWorkRequestSchema.safeParse({ orderId: 'o1', name: '', amount: 1 }).success).toBe(
      false,
    )
    expect(addOrderWorkRequestSchema.safeParse({ orderId: 'o1', name: 'x', amount: -1 }).success).toBe(
      false,
    )
    expect(
      addOrderWorkRequestSchema.safeParse({ orderId: 'o1', name: 'x', amount: 10.5 }).success,
    ).toBe(false)
  })

  test('приём: госномер нормализуется в кириллицу, null очищает, пробег в разумных пределах', () => {
    const parsed = updateOrderReceptionRequestSchema.parse({
      orderId: 'o1',
      plate: 'a123bc777',
      mileageKm: 145_000,
      complaint: null,
    })
    expect(parsed.plate).toBe('А123ВС777')
    expect(parsed.complaint).toBeNull()
    expect(parsed.dueAt).toBeUndefined()
    expect(
      updateOrderReceptionRequestSchema.safeParse({ orderId: 'o1', mileageKm: 5_000_000 }).success,
    ).toBe(false)
    expect(updateOrderReceptionRequestSchema.safeParse({ orderId: 'o1', dueAt: 'завтра' }).success).toBe(
      false,
    )
  })
})
