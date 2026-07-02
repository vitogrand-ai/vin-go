import { z } from 'zod'

import { moneySchema } from './catalog'

/** Статус конкретного платежа. */
export const paymentStatusSchema = z.enum(['PENDING', 'SUCCEEDED', 'CANCELED'])

/** Способ оплаты. */
export const paymentMethodSchema = z.enum(['card', 'sbp'])

/** Платёжный статус заказа: NONE — платёж ещё не создавался. */
export const orderPaymentStatusSchema = z.enum(['NONE', 'PENDING', 'SUCCEEDED', 'CANCELED'])

export const paymentSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  status: paymentStatusSchema,
  amount: moneySchema,
  /** URL формы оплаты провайдера (для редиректа пользователя). */
  confirmationUrl: z.string().nullable(),
  createdAt: z.string().datetime(),
  paidAt: z.string().datetime().nullable(),
})

export const createPaymentRequestSchema = z.object({
  orderId: z.string().min(1),
  method: paymentMethodSchema.optional(),
})

export const createPaymentResponseSchema = z.object({
  payment: paymentSchema,
})

export const refundSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  amount: moneySchema,
  status: paymentStatusSchema,
  createdAt: z.string().datetime(),
})

export const refundRequestSchema = z.object({
  orderId: z.string().min(1),
})

export const refundResponseSchema = z.object({
  refund: refundSchema,
})

/** Подтверждение мок-оплаты (доступно только при мок-провайдере, для разработки). */
export const confirmMockPaymentRequestSchema = z.object({
  paymentId: z.string().min(1),
})

export type PaymentStatus = z.infer<typeof paymentStatusSchema>
export type PaymentMethod = z.infer<typeof paymentMethodSchema>
export type OrderPaymentStatus = z.infer<typeof orderPaymentStatusSchema>
export type Payment = z.infer<typeof paymentSchema>
export type CreatePaymentRequest = z.infer<typeof createPaymentRequestSchema>
export type CreatePaymentResponse = z.infer<typeof createPaymentResponseSchema>
export type ConfirmMockPaymentRequest = z.infer<typeof confirmMockPaymentRequestSchema>
export type Refund = z.infer<typeof refundSchema>
export type RefundRequest = z.infer<typeof refundRequestSchema>
export type RefundResponse = z.infer<typeof refundResponseSchema>
