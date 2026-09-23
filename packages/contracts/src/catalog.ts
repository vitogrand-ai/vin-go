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

// Frame (номер кузова, JDM/правый руль): код модели + дефис + серийный номер,
// например SXA10-0012345. У «серых» японцев VIN нет — каталоги ищут по frame.
// Максимум 17 символов — совпадает с ограничением полей ввода VIN.
const FRAME_PATTERN = /^[A-Z][A-Z0-9]{1,7}-\d{4,8}$/

export const frameSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(FRAME_PATTERN, 'Номер кузова (frame) — вида SXA10-0012345')

/** Идентификатор автомобиля: VIN (17 симв.) или frame-номер кузова (JDM). */
export const vinOrFrameSchema = z.union([vinSchema, frameSchema])

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
  /** VIN или frame-номер кузова (JDM) — единый идентификатор автомобиля. */
  vin: vinOrFrameSchema,
  make: z.string(),
  model: z.string(),
  /** Модельный год; null — каталог его не отдал (европейские VIN год не кодируют). */
  year: z.number().int().nullable(),
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
  /** URL схемы узла (иллюстрация каталога), если провайдер её отдаёт. */
  imageUrl: z.string().nullable().optional(),
  /** Номер детали на схеме узла: на картинке он стоит выноской («9»). */
  position: z.string().nullable().optional(),
  /**
   * Идентификатор узла в каталоге. По нему открывается весь узел — так мастер
   * выбирает деталь номером с картинки, а не названием.
   */
  schemeId: z.string().nullable().optional(),
  /**
   * Сколько таких деталей стоит на машине. Мастер заказывает комплект, а не
   * штуку: болтов крепления суппорта — 4, прокладок — 2.
   */
  quantity: z.number().int().positive().nullable().optional(),
  /**
   * Номер, которым завод заменил эту деталь. Заказывать надо его: старый номер
   * у поставщиков уже не найдётся (у 17vin — `replacement`).
   */
  replacedBy: z.string().nullable().optional(),
  /**
   * Примечание каталога — то, чем деталь отличается от соседней такой же:
   * мотор и шасси («GRJ150..TX»), мощность лампы («12V 55W,HALOGEN»),
   * производитель («MARK ADVICS PV565H»).
   */
  note: z.string().nullable().optional(),
  /** Период выпуска, когда деталь ставилась на конвейере («05.2010 — 11.2013»). */
  appliesPeriod: z.string().nullable().optional(),
  /**
   * Где выноска этой детали стоит на схеме — доли ширины и высоты картинки
   * (0..1), чтобы клиент не знал её пиксельных размеров. По ним деталь
   * обводится прямо на схеме: искать глазами номер «15650» среди полусотни
   * выносок мастеру не нужно.
   */
  schemeHotspot: z
    .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
    .nullable()
    .optional(),
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

/**
 * Источник данных в ответе. Продукт может работать на демо-данных (моки), и
 * пользователь должен это видеть: выдуманные цены поставщиков нельзя выдавать
 * за реальные. `names` — подключённые источники («abcp», «emex», «mock»).
 */
export const dataSourceSchema = z.object({
  names: z.array(z.string()),
  /** true — данные демонстрационные: цены, сроки и наличие условные. */
  demo: z.boolean(),
})

// --- Запросы и ответы ---

export const decodeVinRequestSchema = z.object({
  vin: vinOrFrameSchema,
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
  vin: vinOrFrameSchema,
  query: z.string().trim().min(1, 'Введите название запчасти').max(120),
})

export const searchPartsResponseSchema = z.object({
  vehicle: vehicleSchema,
  parts: z.array(partSchema),
  /**
   * Запрос, по которому реально нашлось, — когда он отличается от введённого.
   * Мастер пишет «гранатка», каталог знает «ШРУС»: без подсказки выдача
   * выглядит случайной. Отсутствует, если искали ровно так, как ввели.
   */
  resolvedQuery: z.string().optional(),
  /** Каталог, из которого пришла выдача (демо или боевой). */
  source: dataSourceSchema.optional(),
})

/**
 * Узел каталога по его идентификатору (`Part.schemeId`). Мастер смотрит на
 * схему и выбирает деталь номером с картинки: в боте — цифрой в чате, в вебе —
 * нажатием на выноску. Ответ — тот же `searchPartsResponseSchema`.
 */
export const schemePartsRequestSchema = z.object({
  vin: vinOrFrameSchema,
  schemeId: z.string().trim().min(1).max(500),
  /** Номер выноски; без него отдаётся весь узел. */
  position: z.string().trim().min(1).max(20).optional(),
})

export const offersRequestSchema = z.object({
  oemNumber: z.string().trim().min(1).max(60),
  region: z.string().trim().max(40).optional(),
})

/**
 * Справочная цена оригинала у официальных дилеров. Ориентир «сколько стоит
 * оригинал», а не предложение: купить по ней нельзя, в корзину и оплату она не
 * попадает. Поэтому своя схема, а не `moneySchema`: та живёт в заказах и
 * допускает только рубли, а цена дилера — в валюте своего рынка.
 */
export const dealerPriceSchema = z.object({
  /** Дешевле всего у дилеров — в минимальных единицах валюты (фэни). */
  min: z.number().int().nonnegative(),
  /** Дороже всего у дилеров, в тех же единицах. */
  max: z.number().int().nonnegative(),
  currency: z.literal('CNY'),
  /** Рынок, где действует цена: для приёмщика в РФ это ориентир, не факт. */
  market: z.literal('CN'),
  /** Сколько дилеров назвали цену. */
  dealers: z.number().int().positive(),
})

export const offersResponseSchema = z.object({
  oemNumber: z.string(),
  /** Рекомендованные предложения по тирам (может не быть какого-то тира). */
  picks: z.array(tierPickSchema),
  /** Полный список предложений, отсортированный по цене. */
  offers: z.array(offerSchema),
  /** Поставщики, из которых собраны предложения (демо или боевые). */
  source: dataSourceSchema.optional(),
  /** Цена оригинала у дилеров, если источник её знает. */
  dealerPrice: dealerPriceSchema.nullable().optional(),
})

/** Состояние подключённых источников данных — для честного индикатора в UI. */
export const catalogStatusResponseSchema = z.object({
  catalog: dataSourceSchema,
  suppliers: dataSourceSchema,
  plates: dataSourceSchema,
})

// --- Типы ---

export type Currency = z.infer<typeof currencySchema>
export type Money = z.infer<typeof moneySchema>
export type PartQuality = z.infer<typeof partQualitySchema>
export type OfferTier = z.infer<typeof offerTierSchema>
export type Vehicle = z.infer<typeof vehicleSchema>
export type PartCategory = z.infer<typeof partCategorySchema>
export type Part = z.infer<typeof partSchema>

/**
 * OEM-номера деталей выдачи, у которых рядом есть другое исполнение той же
 * позиции: под выноской 10655 узла АКБ у Ford Mondeo пять номеров, и все пять
 * называются «Батарея аккумуляторная». Такой выбор делается не по VIN, а по
 * тому, что стоит на машине, — веб и бот обязаны показать, чем исполнения
 * различаются, и сказать мастеру, с чем сверять.
 *
 * Позиция — это узел + номер выноски; номер выноски без узла ничего не значит.
 * Если схемы нет, исполнения узнаются по одинаковому названию.
 */
export function partsWithVariants(
  parts: Pick<Part, 'oemNumber' | 'name' | 'schemeId' | 'position'>[],
): Set<string> {
  const bySlot = new Map<string, Set<string>>()
  for (const part of parts) {
    const slot =
      part.schemeId && part.position
        ? `scheme:${part.schemeId}#${part.position.trim()}`
        : `name:${part.name.trim().toLowerCase()}`
    const oems = bySlot.get(slot) ?? new Set<string>()
    oems.add(part.oemNumber)
    bySlot.set(slot, oems)
  }
  const out = new Set<string>()
  for (const oems of bySlot.values()) {
    if (oems.size > 1) for (const oem of oems) out.add(oem)
  }
  return out
}
export type Offer = z.infer<typeof offerSchema>
export type TierPick = z.infer<typeof tierPickSchema>
export type DecodeVinRequest = z.infer<typeof decodeVinRequestSchema>
export type DecodeVinResponse = z.infer<typeof decodeVinResponseSchema>
export type ResolvePlateRequest = z.infer<typeof resolvePlateRequestSchema>
export type ResolvePlateResponse = z.infer<typeof resolvePlateResponseSchema>
export type SearchPartsRequest = z.infer<typeof searchPartsRequestSchema>
export type SearchPartsResponse = z.infer<typeof searchPartsResponseSchema>
export type SchemePartsRequest = z.infer<typeof schemePartsRequestSchema>
export type OffersRequest = z.infer<typeof offersRequestSchema>
export type OffersResponse = z.infer<typeof offersResponseSchema>
export type DealerPrice = z.infer<typeof dealerPriceSchema>
export type DataSource = z.infer<typeof dataSourceSchema>
export type CatalogStatusResponse = z.infer<typeof catalogStatusResponseSchema>
