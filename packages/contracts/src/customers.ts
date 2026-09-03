import { z } from 'zod'

/**
 * Клиент автосервиса — владелец машины, для которого приёмщик подбирает
 * запчасти. Не пользователь системы: у него нет входа, только имя и телефон,
 * чтобы смета и история были привязаны к человеку.
 */
export const customerNameSchema = z.string().trim().min(1).max(120)
export const customerPhoneSchema = z.string().trim().min(5).max(32)
export const customerNoteSchema = z.string().trim().max(500)

/** Краткая карточка клиента — вкладывается в авто и заказ. */
export const customerBriefSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
})

export const customerSchema = customerBriefSchema.extend({
  note: z.string().nullable(),
  vehicleCount: z.number().int().nonnegative(),
  orderCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
})

export const createCustomerRequestSchema = z.object({
  name: customerNameSchema,
  phone: customerPhoneSchema.optional(),
  note: customerNoteSchema.optional(),
})

export const updateCustomerRequestSchema = z.object({
  id: z.string().min(1),
  name: customerNameSchema.optional(),
  /** null — очистить поле. */
  phone: customerPhoneSchema.nullable().optional(),
  note: customerNoteSchema.nullable().optional(),
})

export const removeCustomerRequestSchema = z.object({
  id: z.string().min(1),
})

export const customersResponseSchema = z.object({
  customers: z.array(customerSchema),
})

export const customerResponseSchema = z.object({
  customer: customerSchema,
})

export type CustomerBrief = z.infer<typeof customerBriefSchema>
export type CustomerDto = z.infer<typeof customerSchema>
export type CreateCustomerRequest = z.infer<typeof createCustomerRequestSchema>
export type UpdateCustomerRequest = z.infer<typeof updateCustomerRequestSchema>
export type RemoveCustomerRequest = z.infer<typeof removeCustomerRequestSchema>
export type CustomersResponse = z.infer<typeof customersResponseSchema>
export type CustomerResponse = z.infer<typeof customerResponseSchema>
