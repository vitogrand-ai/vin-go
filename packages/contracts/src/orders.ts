import { z } from 'zod'

import { moneySchema, offerTierSchema, partQualitySchema, vinSchema } from './catalog'
import { orderPaymentStatusSchema } from './payments'

export const orderStatusSchema = z.enum([
  'DRAFT',
  'PLACED',
  'PAID',
  'PROCESSING',
  'READY',
  'COMPLETED',
  'CANCELLED',
  'REFUNDED',
])

/**
 * Разрешённые переходы статуса заказа оператором (автосервисом).
 * Переход PLACED → PAID выполняется автоматически при успешной оплате,
 * поэтому здесь его нет. Единый источник правды для бэкенда и фронтенда.
 */
export const ORDER_STATUS_TRANSITIONS: Record<
  z.infer<typeof orderStatusSchema>,
  Array<z.infer<typeof orderStatusSchema>>
> = {
  DRAFT: [],
  PLACED: ['CANCELLED'],
  PAID: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['READY', 'CANCELLED'],
  READY: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  // REFUNDED устанавливается возвратом средств, а не ручным переходом.
  REFUNDED: [],
}

export function allowedOrderTransitions(
  status: z.infer<typeof orderStatusSchema>,
): Array<z.infer<typeof orderStatusSchema>> {
  return ORDER_STATUS_TRANSITIONS[status]
}

export const orderItemSchema = z.object({
  id: z.string(),
  oemNumber: z.string(),
  partName: z.string(),
  brand: z.string(),
  articleNumber: z.string(),
  supplierName: z.string(),
  quality: partQualitySchema,
  isOriginal: z.boolean(),
  tier: offerTierSchema.nullable(),
  price: moneySchema,
  deliveryDays: z.number().int().nonnegative(),
  quantity: z.number().int().positive(),
  /** Стоимость позиции: цена × количество. */
  lineTotal: moneySchema,
})

export const orderSchema = z.object({
  id: z.string(),
  status: orderStatusSchema,
  paymentStatus: orderPaymentStatusSchema,
  vehicleVin: z.string().nullable(),
  notes: z.string().nullable(),
  items: z.array(orderItemSchema),
  itemCount: z.number().int().nonnegative(),
  total: moneySchema,
  createdAt: z.string().datetime(),
  placedAt: z.string().datetime().nullable(),
})

// --- Запросы и ответы ---

export const addCartItemRequestSchema = z.object({
  oemNumber: z.string().trim().min(1).max(60),
  /** id предложения из выдачи поставщиков — сервер по нему берёт авторитетную цену. */
  offerId: z.string().trim().min(1).max(120),
  partName: z.string().trim().min(1).max(160),
  tier: offerTierSchema.optional(),
  quantity: z.number().int().min(1).max(99).optional(),
  vehicleVin: vinSchema.optional(),
})

export const updateCartItemRequestSchema = z.object({
  itemId: z.string().min(1),
  quantity: z.number().int().min(1).max(99),
})

export const removeCartItemRequestSchema = z.object({
  itemId: z.string().min(1),
})

export const updateOrderStatusRequestSchema = z.object({
  orderId: z.string().min(1),
  status: orderStatusSchema,
})

export const updateOrderNotesRequestSchema = z.object({
  orderId: z.string().min(1),
  notes: z.string().max(2000),
})

export const setCartVehicleRequestSchema = z.object({
  vin: vinSchema,
})

/** Корзина = черновик заказа; null, если корзина ещё не создавалась. */
export const cartResponseSchema = z.object({
  order: orderSchema.nullable(),
})

export const orderResponseSchema = z.object({
  order: orderSchema,
})

export const ordersResponseSchema = z.object({
  orders: z.array(orderSchema),
})

export type OrderStatus = z.infer<typeof orderStatusSchema>
export type OrderItemDto = z.infer<typeof orderItemSchema>
export type OrderDto = z.infer<typeof orderSchema>
export type AddCartItemRequest = z.infer<typeof addCartItemRequestSchema>
export type UpdateCartItemRequest = z.infer<typeof updateCartItemRequestSchema>
export type RemoveCartItemRequest = z.infer<typeof removeCartItemRequestSchema>
export type UpdateOrderStatusRequest = z.infer<typeof updateOrderStatusRequestSchema>
export type UpdateOrderNotesRequest = z.infer<typeof updateOrderNotesRequestSchema>
export type SetCartVehicleRequest = z.infer<typeof setCartVehicleRequestSchema>
export type CartResponse = z.infer<typeof cartResponseSchema>
export type OrderResponse = z.infer<typeof orderResponseSchema>
export type OrdersResponse = z.infer<typeof ordersResponseSchema>
