import { z } from 'zod'

import { markupBpsSchema } from './pricing'

/**
 * Автосервис (организация) — рабочее пространство сотрудников: общий гараж,
 * клиенты, заказы и наценка. OWNER управляет настройками и приглашениями,
 * MEMBER работает с заказами.
 */
export const orgRoleSchema = z.enum(['OWNER', 'MEMBER'])

export const orgNameSchema = z.string().trim().min(2).max(80)
export const orgPhoneSchema = z.string().trim().min(5).max(32)

export const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  /** Наценка по умолчанию на закупочную цену (базисные пункты, 2000 = 20%). */
  defaultMarkupBps: markupBpsSchema,
  /** Код приглашения сотрудников: регистрация с ним ведёт в эту организацию. */
  inviteCode: z.string(),
  memberCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
})

export const updateOrganizationRequestSchema = z.object({
  name: orgNameSchema.optional(),
  /** null — очистить телефон. */
  phone: orgPhoneSchema.nullable().optional(),
  defaultMarkupBps: markupBpsSchema.optional(),
})

export const inviteCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(4, 'Код приглашения слишком короткий')
  .max(32)

/** Перейти в другую организацию по коду приглашения. */
export const joinOrganizationRequestSchema = z.object({
  inviteCode: inviteCodeSchema,
})

export const organizationResponseSchema = z.object({
  organization: organizationSchema,
})

export type OrgRole = z.infer<typeof orgRoleSchema>
export type OrganizationDto = z.infer<typeof organizationSchema>
export type UpdateOrganizationRequest = z.infer<typeof updateOrganizationRequestSchema>
export type JoinOrganizationRequest = z.infer<typeof joinOrganizationRequestSchema>
export type OrganizationResponse = z.infer<typeof organizationResponseSchema>
