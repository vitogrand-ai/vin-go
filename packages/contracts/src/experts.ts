import { z } from 'zod'

import { vinOrFrameSchema } from './catalog'

/**
 * Заявка эксперту — «человек в цикле» для сложных VIN. Когда каталоги не
 * нашли деталь, сотрудник автосервиса описывает, что искал, а оператор
 * платформы подбирает каталожные номера вручную. Это закрывает пробел
 * покрытия каталогов без ожидания идеального API.
 */
export const expertRequestStatusSchema = z.enum(['NEW', 'ANSWERED', 'REJECTED'])

export const expertVehicleSchema = z.object({
  make: z.string(),
  model: z.string(),
  year: z.number().int().nullable(),
})

export const expertRequestSchema = z.object({
  id: z.string(),
  /** Сквозной номер заявки — для переписки и уведомлений. */
  number: z.number().int(),
  status: expertRequestStatusSchema,
  vin: z.string(),
  vehicle: expertVehicleSchema.nullable(),
  query: z.string(),
  comment: z.string().nullable(),
  answerText: z.string().nullable(),
  /** Каталожные номера от эксперта — по ним сразу ищутся предложения. */
  answerOems: z.array(z.string()),
  /** Автосервис-автор (видит оператор в очереди). */
  orgName: z.string(),
  createdAt: z.string().datetime(),
  answeredAt: z.string().datetime().nullable(),
})

export const createExpertRequestSchema = z.object({
  vin: vinOrFrameSchema,
  query: z.string().trim().min(1, 'Опишите, что искали').max(200),
  comment: z.string().trim().max(1000).optional(),
})

export const answerExpertRequestSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['ANSWERED', 'REJECTED']),
  answerText: z.string().trim().min(1, 'Напишите ответ').max(2000),
  answerOems: z
    .array(z.string().trim().min(1).max(60).toUpperCase())
    .max(20)
    .default([]),
})

export const expertRequestsResponseSchema = z.object({
  requests: z.array(expertRequestSchema),
})

export const expertRequestResponseSchema = z.object({
  request: expertRequestSchema,
})

export type ExpertRequestStatus = z.infer<typeof expertRequestStatusSchema>
export type ExpertRequestDto = z.infer<typeof expertRequestSchema>
export type CreateExpertRequest = z.input<typeof createExpertRequestSchema>
export type AnswerExpertRequest = z.input<typeof answerExpertRequestSchema>
export type ExpertRequestsResponse = z.infer<typeof expertRequestsResponseSchema>
export type ExpertRequestResponse = z.infer<typeof expertRequestResponseSchema>
