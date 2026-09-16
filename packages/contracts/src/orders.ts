import { z } from 'zod'

import type { UserRole } from './auth'
import { moneySchema, offerTierSchema, partQualitySchema, plateSchema, vinOrFrameSchema } from './catalog'
import { customerBriefSchema } from './customers'
import { mileageKmSchema } from './garage'
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

/**
 * Работа (услуга) в заказ-наряде — вторая половина документа рядом с
 * запчастями (ПП РФ № 780, п. 9(е)): наименование, цена для клиента, количество.
 */
export const orderWorkNameSchema = z.string().trim().min(1).max(160)

export const orderWorkSchema = z.object({
  id: z.string(),
  name: z.string(),
  price: moneySchema,
  quantity: z.number().int().positive(),
  lineTotal: moneySchema,
})

/**
 * Приём машины (ПП № 780, п. 9 и п. 12): срок исполнения, причина обращения,
 * комплектность и повреждения на момент приёма, госномер и пробег.
 */
export const orderReceptionSchema = z.object({
  dueAt: z.string().datetime().nullable(),
  complaint: z.string().nullable(),
  conditionNotes: z.string().nullable(),
  plate: z.string().nullable(),
  mileageKm: z.number().int().nullable(),
})

/** Машина заказа по гаражу автосервиса — марка, модель, год для документа. */
export const orderVehicleSchema = z.object({
  make: z.string(),
  model: z.string(),
  year: z.number().int().nullable(),
})

export const orderSchema = z.object({
  id: z.string(),
  /** Человекочитаемый номер заказа (сквозной). */
  number: z.number().int(),
  status: orderStatusSchema,
  paymentStatus: orderPaymentStatusSchema,
  vehicleVin: z.string().nullable(),
  /** Машина из гаража автосервиса по VIN заказа; null — в гараже её нет. */
  vehicle: orderVehicleSchema.nullable(),
  /** Клиент автосервиса, для которого заказ. */
  customer: customerBriefSchema.nullable(),
  notes: z.string().nullable(),
  reception: orderReceptionSchema,
  /** Кто принял заказ (п. 9(и)): сотрудник, оформивший его. */
  acceptedBy: z.string().nullable(),
  items: z.array(orderItemSchema),
  itemCount: z.number().int().nonnegative(),
  works: z.array(orderWorkSchema),
  /** Закупочная сумма — к оплате поставщику. */
  total: moneySchema,
  /** Сумма запчастей для клиента автосервиса (смета). */
  saleTotal: moneySchema,
  /** Сумма работ. */
  worksTotal: moneySchema,
  /** Итого клиенту: запчасти по цене клиента + работы. */
  grandTotal: moneySchema,
  /** Маржа автосервиса по запчастям: saleTotal − total. */
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

/** Работа в заказ-наряд: цена для клиента в копейках. */
export const addOrderWorkRequestSchema = z.object({
  orderId: z.string().min(1),
  name: orderWorkNameSchema,
  amount: z.number().int().min(0).max(100_000_000),
  quantity: z.number().int().min(1).max(99).optional(),
})

export const removeOrderWorkRequestSchema = z.object({
  orderId: z.string().min(1),
  workId: z.string().min(1),
})

/** Данные приёма машины: null очищает поле, отсутствие — не трогает. */
export const updateOrderReceptionRequestSchema = z.object({
  orderId: z.string().min(1),
  dueAt: z.string().datetime().nullable().optional(),
  complaint: z.string().trim().max(1000).nullable().optional(),
  conditionNotes: z.string().trim().max(2000).nullable().optional(),
  plate: plateSchema.nullable().optional(),
  mileageKm: mileageKmSchema.nullable().optional(),
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
export type OrderWorkDto = z.infer<typeof orderWorkSchema>
export type OrderReceptionDto = z.infer<typeof orderReceptionSchema>
export type OrderVehicleDto = z.infer<typeof orderVehicleSchema>
export type OrderDto = z.infer<typeof orderSchema>
export type AddOrderWorkRequest = z.infer<typeof addOrderWorkRequestSchema>
export type RemoveOrderWorkRequest = z.infer<typeof removeOrderWorkRequestSchema>
export type UpdateOrderReceptionRequest = z.input<typeof updateOrderReceptionRequestSchema>
export type UpdateOrderReceptionPayload = z.output<typeof updateOrderReceptionRequestSchema>
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
