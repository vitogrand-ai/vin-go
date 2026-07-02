import { z } from 'zod'

/**
 * Локальное зеркало нужных схем из `@web-app-demo/contracts` (auth + catalog).
 * Дублируется намеренно: Expo Go + monorepo + TS-исходники чужого пакета —
 * нестабильная связка. При изменении общих контрактов синхронизируйте здесь.
 */

// --- Auth ---

export const emailSchema = z.string().trim().toLowerCase().email().max(254)
export const passwordSchema = z.string().min(8).max(128)

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  createdAt: z.string(),
})

export const authResponseSchema = z.object({
  user: userSchema,
  accessToken: z.string(),
  refreshToken: z.string().optional(),
})

export const refreshResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
})

export const meResponseSchema = z.object({ user: userSchema })

// --- Catalog ---

export const vinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-HJ-NPR-Z0-9]{17}$/, 'VIN — 17 символов (латиница и цифры, без I, O, Q)')

const LATIN_TO_CYRILLIC: Record<string, string> = {
  A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т', Y: 'У', X: 'Х',
}

function normalizePlate(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .split('')
    .map((char) => LATIN_TO_CYRILLIC[char] ?? char)
    .join('')
}

export const plateSchema = z
  .string()
  .transform(normalizePlate)
  .refine(
    (value) => /^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}\d{2,3}$/u.test(value),
    'Некорректный госномер (пример: А123ВС777)',
  )

export const moneySchema = z.object({
  amount: z.number().int().nonnegative(),
  currency: z.enum(['RUB']),
})

export const partQualitySchema = z.enum(['BUDGET', 'AFTERMARKET', 'PREMIUM', 'OEM'])
export const offerTierSchema = z.enum(['ECONOMY', 'BALANCED', 'ORIGINAL'])

export const vehicleSchema = z.object({
  vin: z.string(),
  make: z.string(),
  model: z.string(),
  year: z.number().int(),
  engine: z.string().nullable(),
  bodyType: z.string().nullable(),
})

export const partSchema = z.object({
  oemNumber: z.string(),
  name: z.string(),
  category: z.string(),
  brand: z.string().nullable(),
})

export const offerSchema = z.object({
  id: z.string(),
  oemNumber: z.string(),
  brand: z.string(),
  articleNumber: z.string(),
  name: z.string(),
  price: moneySchema,
  quality: partQualitySchema,
  isOriginal: z.boolean(),
  inStock: z.boolean(),
  quantityAvailable: z.number().int().nonnegative(),
  deliveryDays: z.number().int().nonnegative(),
  supplierName: z.string(),
})

export const tierPickSchema = z.object({
  tier: offerTierSchema,
  offer: offerSchema,
  reason: z.string(),
})

export const searchPartsResponseSchema = z.object({
  vehicle: vehicleSchema,
  parts: z.array(partSchema),
})

export const offersResponseSchema = z.object({
  oemNumber: z.string(),
  picks: z.array(tierPickSchema),
  offers: z.array(offerSchema),
})

export const resolvePlateResponseSchema = z.object({ vehicle: vehicleSchema })

// --- Гараж ---

export const savedVehicleSchema = vehicleSchema.extend({
  id: z.string(),
  nickname: z.string().nullable(),
  createdAt: z.string(),
})

export const garageResponseSchema = z.object({ vehicles: z.array(savedVehicleSchema) })
export const vehicleResponseSchema = z.object({ vehicle: savedVehicleSchema })

// --- Заказы и корзина ---

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
export const orderPaymentStatusSchema = z.enum(['NONE', 'PENDING', 'SUCCEEDED', 'CANCELED'])

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
  createdAt: z.string(),
  placedAt: z.string().nullable(),
})

export const cartResponseSchema = z.object({ order: orderSchema.nullable() })
export const orderResponseSchema = z.object({ order: orderSchema })
export const ordersResponseSchema = z.object({ orders: z.array(orderSchema) })

// --- Оплата ---

export const paymentSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  status: z.enum(['PENDING', 'SUCCEEDED', 'CANCELED']),
  amount: moneySchema,
  confirmationUrl: z.string().nullable(),
  createdAt: z.string(),
  paidAt: z.string().nullable(),
})
export const createPaymentResponseSchema = z.object({ payment: paymentSchema })

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
})

export type User = z.infer<typeof userSchema>
export type AuthResponse = z.infer<typeof authResponseSchema>
export type Money = z.infer<typeof moneySchema>
export type OfferTier = z.infer<typeof offerTierSchema>
export type Vehicle = z.infer<typeof vehicleSchema>
export type Part = z.infer<typeof partSchema>
export type Offer = z.infer<typeof offerSchema>
export type TierPick = z.infer<typeof tierPickSchema>
export type SearchPartsResponse = z.infer<typeof searchPartsResponseSchema>
export type OffersResponse = z.infer<typeof offersResponseSchema>
export type ResolvePlateResponse = z.infer<typeof resolvePlateResponseSchema>
export type SavedVehicle = z.infer<typeof savedVehicleSchema>
export type GarageResponse = z.infer<typeof garageResponseSchema>
export type VehicleResponse = z.infer<typeof vehicleResponseSchema>
export type OrderStatus = z.infer<typeof orderStatusSchema>
export type OrderItemDto = z.infer<typeof orderItemSchema>
export type OrderDto = z.infer<typeof orderSchema>
export type CartResponse = z.infer<typeof cartResponseSchema>
export type OrderResponse = z.infer<typeof orderResponseSchema>
export type OrdersResponse = z.infer<typeof ordersResponseSchema>
export type CreatePaymentResponse = z.infer<typeof createPaymentResponseSchema>
