import { z } from 'zod'

/**
 * Контракты подбора автозапчастей: VIN → автомобиль → запчасть → предложения по тирам.
 *
 * Деньги храним в минимальных единицах валюты (копейках) целым числом,
 * чтобы не накапливать ошибки округления и сразу поддерживать мультивалютность.
 */

// VIN: 17 символов, латиница без I, O, Q (стандарт ISO 3779).
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/

export const vinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(VIN_PATTERN, 'VIN должен содержать 17 символов (латиница и цифры, без I, O, Q)')

// Госномер РФ: буква + 3 цифры + 2 буквы + 2–3 цифры региона.
// Разрешены только буквы, совпадающие по начертанию с латиницей.
const PLATE_PATTERN = /^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}\d{2,3}$/u

// Латинские двойники → кириллица (пользователи часто вводят латиницей).
const LATIN_TO_CYRILLIC: Record<string, string> = {
  A: 'А',
  B: 'В',
  E: 'Е',
  K: 'К',
  M: 'М',
  H: 'Н',
  O: 'О',
  P: 'Р',
  C: 'С',
  T: 'Т',
  Y: 'У',
  X: 'Х',
}

export function normalizePlate(raw: string): string {
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
  .refine((value) => PLATE_PATTERN.test(value), 'Некорректный госномер (пример: А123ВС777)')

export const currencySchema = z.enum(['RUB'])

/** Денежная сумма в минимальных единицах (копейках). */
export const moneySchema = z.object({
  amount: z.number().int().nonnegative(),
  currency: currencySchema,
})

/** Класс качества бренда запчасти — основа для раскладки по тирам. */
export const partQualitySchema = z.enum(['BUDGET', 'AFTERMARKET', 'PREMIUM', 'OEM'])

/** Тиры рекомендаций: эконом / оптимальный (цена-качество) / оригинал. */
export const offerTierSchema = z.enum(['ECONOMY', 'BALANCED', 'ORIGINAL'])

export const vehicleSchema = z.object({
  vin: vinSchema,
  make: z.string(),
  model: z.string(),
  year: z.number().int(),
  engine: z.string().nullable(),
  bodyType: z.string().nullable(),
  /** Сырой ответ провайдера каталога — для отладки и будущих полей. */
  raw: z.record(z.string(), z.unknown()).optional(),
})

export const partCategorySchema = z.object({
  id: z.string(),
  name: z.string(),
})

export const partSchema = z.object({
  /** Каталожный (OEM) номер запчасти. */
  oemNumber: z.string(),
  name: z.string(),
  category: z.string(),
  brand: z.string().nullable(),
})

export const offerSchema = z.object({
  id: z.string(),
  oemNumber: z.string(),
  brand: z.string(),
  /** Артикул в номенклатуре поставщика/бренда. */
  articleNumber: z.string(),
  name: z.string(),
  price: moneySchema,
  quality: partQualitySchema,
  /** true, если это оригинальная деталь производителя автомобиля. */
  isOriginal: z.boolean(),
  inStock: z.boolean(),
  quantityAvailable: z.number().int().nonnegative(),
  deliveryDays: z.number().int().nonnegative(),
  supplierName: z.string(),
})

/** Подобранное предложение в тире + краткое обоснование выбора. */
export const tierPickSchema = z.object({
  tier: offerTierSchema,
  offer: offerSchema,
  reason: z.string(),
})

// --- Запросы и ответы ---

export const decodeVinRequestSchema = z.object({
  vin: vinSchema,
})

export const decodeVinResponseSchema = z.object({
  vehicle: vehicleSchema,
})

export const resolvePlateRequestSchema = z.object({
  plate: plateSchema,
})

export const resolvePlateResponseSchema = z.object({
  vehicle: vehicleSchema,
})

export const searchPartsRequestSchema = z.object({
  vin: vinSchema,
  query: z.string().trim().min(1, 'Введите название запчасти').max(120),
})

export const searchPartsResponseSchema = z.object({
  vehicle: vehicleSchema,
  parts: z.array(partSchema),
})

export const offersRequestSchema = z.object({
  oemNumber: z.string().trim().min(1).max(60),
  region: z.string().trim().max(40).optional(),
})

export const offersResponseSchema = z.object({
  oemNumber: z.string(),
  /** Рекомендованные предложения по тирам (может не быть какого-то тира). */
  picks: z.array(tierPickSchema),
  /** Полный список предложений, отсортированный по цене. */
  offers: z.array(offerSchema),
})

// --- Типы ---

export type Currency = z.infer<typeof currencySchema>
export type Money = z.infer<typeof moneySchema>
export type PartQuality = z.infer<typeof partQualitySchema>
export type OfferTier = z.infer<typeof offerTierSchema>
export type Vehicle = z.infer<typeof vehicleSchema>
export type PartCategory = z.infer<typeof partCategorySchema>
export type Part = z.infer<typeof partSchema>
export type Offer = z.infer<typeof offerSchema>
export type TierPick = z.infer<typeof tierPickSchema>
export type DecodeVinRequest = z.infer<typeof decodeVinRequestSchema>
export type DecodeVinResponse = z.infer<typeof decodeVinResponseSchema>
export type ResolvePlateRequest = z.infer<typeof resolvePlateRequestSchema>
export type ResolvePlateResponse = z.infer<typeof resolvePlateResponseSchema>
export type SearchPartsRequest = z.infer<typeof searchPartsRequestSchema>
export type SearchPartsResponse = z.infer<typeof searchPartsResponseSchema>
export type OffersRequest = z.infer<typeof offersRequestSchema>
export type OffersResponse = z.infer<typeof offersResponseSchema>
