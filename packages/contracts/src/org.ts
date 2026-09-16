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

/**
 * Реквизиты исполнителя для заказ-наряда (ПП РФ № 780 от 29.05.2025, п. 9(а)):
 * наименование, адрес и данные о госрегистрации. Без них заказ-наряд —
 * не договор, а листок.
 */
export const orgLegalNameSchema = z.string().trim().min(2).max(160)
/** ИНН: 10 цифр у юрлица, 12 у ИП. */
export const innSchema = z.string().trim().regex(/^(\d{10}|\d{12})$/, 'ИНН — 10 или 12 цифр')
/** ОГРН — 13 цифр, ОГРНИП — 15. */
export const ogrnSchema = z
  .string()
  .trim()
  .regex(/^(\d{13}|\d{15})$/, 'ОГРН — 13 цифр, ОГРНИП — 15 цифр')
export const orgAddressSchema = z.string().trim().min(5).max(300)
/** Гарантийные обязательства (п. 9(з)) — печатаются в заказ-наряде. */
export const warrantyTextSchema = z.string().trim().max(1000)

export const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  /** Наценка по умолчанию на закупочную цену (базисные пункты, 2000 = 20%). */
  defaultMarkupBps: markupBpsSchema,
  /** Код приглашения сотрудников: регистрация с ним ведёт в эту организацию. */
  inviteCode: z.string(),
  /** Реквизиты для заказ-наряда; null — не заполнены. */
  legalName: z.string().nullable(),
  inn: z.string().nullable(),
  ogrn: z.string().nullable(),
  address: z.string().nullable(),
  warrantyText: z.string().nullable(),
  memberCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
})

export const updateOrganizationRequestSchema = z.object({
  name: orgNameSchema.optional(),
  /** null — очистить телефон. */
  phone: orgPhoneSchema.nullable().optional(),
  defaultMarkupBps: markupBpsSchema.optional(),
  /** Реквизиты: null очищает поле, отсутствие — не трогает. */
  legalName: orgLegalNameSchema.nullable().optional(),
  inn: innSchema.nullable().optional(),
  ogrn: ogrnSchema.nullable().optional(),
  address: orgAddressSchema.nullable().optional(),
  warrantyText: warrantyTextSchema.nullable().optional(),
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
