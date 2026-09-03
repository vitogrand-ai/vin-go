import { z } from 'zod'

import type { UserRole } from './auth'
import { moneySchema, offerTierSchema, partQualitySchema, vinOrFrameSchema } from './catalog'
import { customerBriefSchema } from './customers'
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

/**
 * Переходы, доступные КЛИЕНТУ (владельцу заказа): только отмена ещё не
 * оплаченного заказа. Дальше по жизненному циклу заказ ведёт оператор —
 * клиент не должен сам переводить свой заказ в «В работе»/«Выдан».
 */
const CLIENT_ORDER_TRANSITIONS: Record<
  z.infer<typeof orderStatusSchema>,
  Array<z.infer<typeof orderStatusSchema>>
> = {
  DRAFT: [],
  PLACED: ['CANCELLED'],
  PAID: [],
  PROCESSING: [],
  READY: [],
  COMPLETED: [],
  CANCELLED: [],
  REFUNDED: [],
}

/**
 * Разрешённые переходы статуса с учётом роли. Оператор ведёт полный жизненный
 * цикл (ORDER_STATUS_TRANSITIONS), клиент — только отмену до оплаты. Единый
 * источник правды для бэкенда (проверка) и фронтенда (какие кнопки показывать).
 */
export function allowedOrderTransitionsFor(
  role: UserRole,
  status: z.infer<typeof orderStatusSchema>,
): Array<z.infer<typeof orderStatusSchema>> {
  return role === 'OPERATOR' ? ORDER_STATUS_TRANSITIONS[status] : CLIENT_ORDER_TRANSITIONS[status]
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
  /** Закупочная цена у поставщика — то, что платит автосервис. */
  price: moneySchema,
  /** Цена для клиента автосервиса (закуп × наценка, правится вручную). */
  salePrice: moneySchema,
  /** Наценка, применённая к позиции (базисные пункты). */
  markupBps: z.number().int(),
  deliveryDays: z.number().int().nonnegative(),
  quantity: z.number().int().positive(),
  /** Закупочная стоимость позиции: цена × количество. */
  lineTotal: moneySchema,
  /** Стоимость позиции для клиента: salePrice × количество. */
  saleLineTotal: moneySchema,
})

export const orderSchema = z.object({
  id: z.string(),
  /** Человекочитаемый номер заказа (сквозной). */
  number: z.number().int(),
  status: orderStatusSchema,
  paymentStatus: orderPaymentStatusSchema,
  vehicleVin: z.string().nullable(),
  /** Клиент автосервиса, для которого заказ. */
  customer: customerBriefSchema.nullable(),
  notes: z.string().nullable(),
  items: z.array(orderItemSchema),
  itemCount: z.number().int().nonnegative(),
  /** Закупочная сумма — к оплате поставщику. */
  total: moneySchema,
  /** Сумма для клиента автосервиса (смета). */
  saleTotal: moneySchema,
  /** Маржа автосервиса: saleTotal − total. */
  marginTotal: moneySchema,
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
  vehicleVin: vinOrFrameSchema.optional(),
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
  vin: vinOrFrameSchema,
})

/** Ручная цена для клиента по позиции корзины (копейки). */
export const updateCartItemSalePriceRequestSchema = z.object({
  itemId: z.string().min(1),
  saleAmount: z.number().int().min(0),
})

/** Клиент автосервиса для корзины; null — отвязать. */
export const setCartCustomerRequestSchema = z.object({
  customerId: z.string().min(1).nullable(),
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
export type UpdateCartItemSalePriceRequest = z.infer<typeof updateCartItemSalePriceRequestSchema>
export type SetCartCustomerRequest = z.infer<typeof setCartCustomerRequestSchema>
export type CartResponse = z.infer<typeof cartResponseSchema>
export type OrderResponse = z.infer<typeof orderResponseSchema>
export type OrdersResponse = z.infer<typeof ordersResponseSchema>
