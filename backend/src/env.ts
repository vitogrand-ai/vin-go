import { z } from 'zod'

const booleanStringSchema = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true')

const knownWeakJwtSecrets = new Set(['replace-with-at-least-32-random-characters'])

const optionalStringSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}, z.string().min(1).optional())

const optionalUrlSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}, z.string().url().optional())

const stringWithDefault = (defaultValue: string) =>
  z.preprocess((value) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }, z.string().min(1).default(defaultValue))

const optionalPositiveIntSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}, z.coerce.number().int().positive().optional())

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:8081,http://localhost:19006')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SECURE: booleanStringSchema,
  SPACES_REGION: optionalStringSchema,
  SPACES_BUCKET: optionalStringSchema,
  SPACES_ENDPOINT: optionalUrlSchema,
  SPACES_CDN_BASE_URL: optionalUrlSchema,
  SPACES_ACCESS_KEY_ID: optionalStringSchema,
  SPACES_SECRET_ACCESS_KEY: optionalStringSchema,
  SPACES_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  SPACES_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().max(7 * 24 * 60 * 60).default(15 * 60),
  SPACES_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().max(7 * 24 * 60 * 60).default(5 * 60),
  SPACES_PUBLIC_CACHE_CONTROL: stringWithDefault('public, max-age=31536000, immutable'),
  // Оплата через ЮKassa. Пусто — используется мок-провайдер (Этап 3).
  YOOKASSA_SHOP_ID: optionalStringSchema,
  YOOKASSA_SECRET_KEY: optionalStringSchema,
  // Куда ЮKassa возвращает пользователя после оплаты (страница заказов).
  PAYMENT_RETURN_URL: optionalUrlSchema,
  // Фискализация (54-ФЗ): код ставки НДС ЮKassa (1–6). Задан — к платежу и
  // возврату прикладывается чек. Пусто — фискализация выключена (нет кассы/ОФД).
  YOOKASSA_VAT_CODE: z.preprocess((value) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }, z.coerce.number().int().min(1).max(6).optional()),
  // Ограничивать webhook оплаты диапазонами IP ЮKassa. Включать только за
  // доверенным прокси (X-Forwarded-For); по умолчанию выкл (локаль/тесты).
  YOOKASSA_WEBHOOK_IP_ALLOWLIST: booleanStringSchema,
  // Rate limiting (in-memory, на инстанс). Пусто — выключено (локаль/тесты).
  // MAX-переменные задают лимит на IP в окне; окно — RATE_LIMIT_WINDOW_SECONDS (60 по умолчанию).
  RATE_LIMIT_AUTH_MAX: optionalPositiveIntSchema, // защита логина/регистрации от подбора
  RATE_LIMIT_PUBLIC_MAX: optionalPositiveIntSchema, // всплески на публичном каталоге
  RATE_LIMIT_WINDOW_SECONDS: optionalPositiveIntSchema,
  // Telegram-бот. Пусто — бот не запускается (entrypoint завершится с подсказкой).
  TELEGRAM_BOT_TOKEN: optionalStringSchema,
  // Имя бота (без @) для deep-link привязки t.me/<bot>?start=<code>.
  TELEGRAM_BOT_USERNAME: optionalStringSchema,
}).superRefine((env, ctx) => {
  validateJwtSecret(env, ctx)
  validateCorsOrigins(env, ctx)
  validateStorageEnv(env, ctx)
  validatePaymentEnv(env, ctx)
})

export type AppEnv = z.infer<typeof envSchema>

export function loadEnv(source: Record<string, string | undefined>) {
  return envSchema.parse(source)
}

function validateJwtSecret(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  if (!isProductionLikeRuntime(env)) return

  if (isWeakJwtSecret(env.JWT_SECRET)) {
    ctx.addIssue({
      code: 'custom',
      path: ['JWT_SECRET'],
      message: 'JWT_SECRET must be a non-placeholder random secret in production',
    })
  }
}

function isProductionLikeRuntime(env: z.infer<typeof envSchema>) {
  return env.NODE_ENV === 'production' || env.COOKIE_SECURE
}

function isWeakJwtSecret(secret: string) {
  const normalized = secret.trim().toLowerCase()
  return (
    normalized.length === 0 ||
    knownWeakJwtSecrets.has(normalized) ||
    new Set(normalized).size === 1
  )
}

function validateCorsOrigins(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  if (env.CORS_ORIGINS.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['CORS_ORIGINS'],
      message: 'CORS_ORIGINS must contain at least one allowed browser origin',
    })
    return
  }

  for (const origin of env.CORS_ORIGINS) {
    if (origin === '*') {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'CORS_ORIGINS must not use wildcard origins when credentials are enabled',
      })
      continue
    }

    let url: URL
    try {
      url = new URL(origin)
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: `CORS_ORIGINS contains an invalid URL: ${origin}`,
      })
      continue
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: `CORS_ORIGINS must use http or https origins: ${origin}`,
      })
    }

    if (url.origin !== origin) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: `CORS_ORIGINS must contain origins only, not paths: ${origin}`,
      })
    }

    if (env.COOKIE_SECURE && url.protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: `CORS_ORIGINS must use HTTPS when COOKIE_SECURE=true: ${origin}`,
      })
    }
  }
}

function validatePaymentEnv(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  const hasShopId = env.YOOKASSA_SHOP_ID !== undefined
  const hasSecret = env.YOOKASSA_SECRET_KEY !== undefined
  if (hasShopId !== hasSecret) {
    ctx.addIssue({
      code: 'custom',
      path: [hasShopId ? 'YOOKASSA_SECRET_KEY' : 'YOOKASSA_SHOP_ID'],
      message: 'YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY должны задаваться вместе',
    })
  }
}

function validateStorageEnv(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  const requiredStorageKeys = [
    'SPACES_REGION',
    'SPACES_BUCKET',
    'SPACES_ENDPOINT',
    'SPACES_ACCESS_KEY_ID',
    'SPACES_SECRET_ACCESS_KEY',
  ] as const
  const storageConfigured =
    requiredStorageKeys.some((key) => env[key] !== undefined) || env.SPACES_CDN_BASE_URL !== undefined

  if (!storageConfigured) return

  for (const key of requiredStorageKeys) {
    if (env[key] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} is required when DigitalOcean Spaces storage is configured`,
      })
    }
  }
}
