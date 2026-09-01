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
  // Каталог acat.online (400+ марок, поиск по VIN/Frame). Пусто — мок-каталог.
  // Ключ включает боевой OEM-адаптер в createCatalogProviders (шире, чем Laximo).
  ACAT_API_KEY: optionalStringSchema,
  // Базовый URL API acat (по умолчанию ACAT_DEFAULT_BASE_URL). Переопределять
  // при смене хоста/версии по документации провайдера.
  ACAT_BASE_URL: optionalUrlSchema,
  // Каталог PartsAPI.ru — REST поверх TecDoc 2025Q4 + CrossBase (~428 млн кроссов).
  // Боевая интеграция, перенесена из Python-прототипа: VIN → carId → дерево
  // товарных групп на русском → применимые артикулы с брендами.
  // ⚠️ Требует российского IP: с зарубежных адресов API висит до таймаута.
  PARTSAPI_KEY: optionalStringSchema,
  // Базовый URL (по умолчанию PARTSAPI_DEFAULT_BASE_URL).
  PARTSAPI_BASE_URL: optionalUrlSchema,
  // Демо-тариф PartsAPI выдаёт отдельный ключ на каждый метод. Заданы — идут
  // вместо общего PARTSAPI_KEY для своего метода; на платном тарифе не нужны.
  PARTSAPI_KEY_VINDECODE: optionalStringSchema,
  PARTSAPI_KEY_GETSEARCHTREE: optionalStringSchema,
  PARTSAPI_KEY_GETARTICLES: optionalStringSchema,
  // Каталог PartsIndex (parts-index.ru) — второй OEM-источник, свежие китайцы.
  // Ключ включает адаптер; с acat вместе агрегируются через FallbackCatalogProvider.
  PARTSINDEX_API_KEY: optionalStringSchema,
  // Базовый URL API PartsIndex (по умолчанию PARTSINDEX_DEFAULT_BASE_URL).
  PARTSINDEX_BASE_URL: optionalUrlSchema,
  // Мировой OEM-каталог parts-catalogs.com (легковые + грузовые, VIN и frame,
  // данные локализуются на русский через Accept-Language). Ключ включает адаптер.
  // Тестовый ключ ограничен квотой VIN (при исчерпании — ошибка 1004 QUOTA_DENY);
  // доступ дополнительно привязан к IP-allowlist на стороне провайдера.
  PARTSCATALOGS_API_KEY: optionalStringSchema,
  // Базовый URL API parts-catalogs (по умолчанию PARTSCATALOGS_DEFAULT_BASE_URL).
  PARTSCATALOGS_BASE_URL: optionalUrlSchema,
  // JDM-каталог (epcdata/amayama) — японцы с правым рулём, поиск по frame-номеру.
  // Третий источник каталога в fallback-цепочке. ⚠️ Публичного API у них нет —
  // ключ появится после договорённости о доступе.
  EPCDATA_API_KEY: optionalStringSchema,
  // Базовый URL API JDM-каталога (по умолчанию EPCDATA_DEFAULT_BASE_URL).
  EPCDATA_BASE_URL: optionalUrlSchema,
  // Каталог 17vin.com — китайский EPC (VIN→авто→оригинальные детали), сильная
  // сторона — китайские авто и китайский рынок. Логин+пароль задаются ВМЕСТЕ.
  // Тариф: $0.15/VIN, повторы по тому же VIN 3 месяца бесплатны.
  VIN17_USER: optionalStringSchema,
  VIN17_PASSWORD: optionalStringSchema,
  // Базовый URL API 17vin (по умолчанию VIN17_DEFAULT_BASE_URL — HTTP, порт 8080).
  VIN17_BASE_URL: optionalUrlSchema,
  // Реестр госномер→VIN (Avtocod). Ключ включает боевой PlateProvider;
  // пусто — мок-реестр (демо-номера).
  AVTOCOD_API_KEY: optionalStringSchema,
  // Базовый URL API Avtocod (по умолчанию AVTOCOD_DEFAULT_BASE_URL).
  AVTOCOD_BASE_URL: optionalUrlSchema,
  // Поставщик на платформе ABCP, напр. 4mycar.ru (слой цен/наличия по
  // OEM-номеру). Все ТРИ значения задаются вместе и включают боевой
  // SupplierProvider; пусто — мок-поставщики.
  ABCP_LOGIN: optionalStringSchema,
  ABCP_PASSWORD: optionalStringSchema,
  // Хост клиентского API магазина (формат https://idNNNN.public.api.abcp.ru).
  // Универсального дефолта нет — хост выдаёт поддержка магазина вместе с
  // включением API-доступа для аккаунта.
  ABCP_API_URL: optionalUrlSchema,
  // Поставщик Emex — второй источник предложений. Вместе с ABCP выдачи
  // сливаются (MergingSupplierProvider): сравнение цен из нескольких источников.
  EMEX_API_KEY: optionalStringSchema,
  // Базовый URL API Emex (по умолчанию EMEX_DEFAULT_BASE_URL).
  EMEX_BASE_URL: optionalUrlSchema,
  // Перевод названий деталей и категорий каталога на русский (Claude). EPC-каталоги
  // отдают заводские названия латиницей/иероглифами («CAP ASSY, OIL FILTER W/ELEMEMT»),
  // а рынок пилота — СНГ. Ключ включает перевод; пусто — показываем как есть.
  // Каждая строка переводится один раз и кладётся в кэш (таблица catalog_translations).
  ANTHROPIC_API_KEY: optionalStringSchema,
  // Модель перевода (по умолчанию DEFAULT_TRANSLATION_MODEL — claude-sonnet-5).
  // claude-opus-5 — точнее на редком жаргоне, claude-haiku-4-5 — дешевле и быстрее.
  TRANSLATION_MODEL: optionalStringSchema,
  // Распознавание VIN с фотографии шильдика (Claude Vision, тот же ANTHROPIC_API_KEY).
  // Мастер под капотом фотографирует табличку вместо ввода 17 символов вслепую.
  // Пусто — берётся VIN_OCR_DEFAULT_MODEL; без ANTHROPIC_API_KEY фото не разбираются.
  VIN_OCR_MODEL: optionalStringSchema,
  // Голосовые в боте: расшифровка через OpenAI Whisper (у Anthropic нет аудио-API).
  // Пусто — бот вежливо просит написать текстом, остальные функции не страдают.
  OPENAI_API_KEY: optionalStringSchema,
  // Telegram-бот. Пусто — бот не запускается (entrypoint завершится с подсказкой).
  TELEGRAM_BOT_TOKEN: optionalStringSchema,
  // Имя бота (без @) для deep-link привязки t.me/<bot>?start=<code>.
  TELEGRAM_BOT_USERNAME: optionalStringSchema,
}).superRefine((env, ctx) => {
  validateJwtSecret(env, ctx)
  validateCorsOrigins(env, ctx)
  validateStorageEnv(env, ctx)
  validatePaymentEnv(env, ctx)
  validateAbcpEnv(env, ctx)
  validateVin17Env(env, ctx)
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

function validateAbcpEnv(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  // Хост клиентского API у ABCP индивидуален для магазина, поэтому без
  // ABCP_API_URL логин/пароль бесполезны — требуем все три сразу.
  const keys = ['ABCP_LOGIN', 'ABCP_PASSWORD', 'ABCP_API_URL'] as const
  const missing = keys.filter((key) => env[key] === undefined)
  if (missing.length === 0 || missing.length === keys.length) return
  for (const key of missing) {
    ctx.addIssue({
      code: 'custom',
      path: [key],
      message: 'ABCP_LOGIN, ABCP_PASSWORD и ABCP_API_URL должны задаваться вместе',
    })
  }
}

function validateVin17Env(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  const hasUser = env.VIN17_USER !== undefined
  const hasPassword = env.VIN17_PASSWORD !== undefined
  if (hasUser !== hasPassword) {
    ctx.addIssue({
      code: 'custom',
      path: [hasUser ? 'VIN17_PASSWORD' : 'VIN17_USER'],
      message: 'VIN17_USER и VIN17_PASSWORD должны задаваться вместе',
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
