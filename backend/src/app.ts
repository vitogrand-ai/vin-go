import { OpenAPIHono } from '@hono/zod-openapi'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'

import type { DbClient } from './db'
import type { AppEnv } from './env'
import { createAuthRoutes } from './auth/routes'
import { AuthService } from './auth/service'
import {
  MockCatalogProvider,
  MockPlateProvider,
  MockSupplierProvider,
} from './catalog/mock-providers'
import { createCatalogRoutes } from './catalog/routes'
import { CatalogService } from './catalog/service'
import { createGarageRoutes } from './garage/routes'
import { GarageService } from './garage/service'
import { createDeviceRoutes } from './devices/routes'
import { DeviceService } from './devices/service'
import {
  makeExpoPushSend,
  makeTelegramSend,
  NotificationService,
} from './notifications/service'
import { createOrdersRoutes } from './orders/routes'
import { OrdersService } from './orders/service'
import { createPaymentProvider } from './payments/factory'
import { createPaymentRoutes } from './payments/routes'
import { PaymentService } from './payments/service'
import { createTelegramRoutes } from './telegram/routes'
import { TelegramLinkService } from './telegram/service'
import { errorResponse, handleError, validationErrorHook } from './http/errors'
import { FixedWindowRateLimiter, rateLimit } from './http/rate-limit'
import { createStorageServiceFromEnv, type StorageService } from './storage/service'

type AppBindings = {
  Variables: {
    authService: AuthService
    catalogService: CatalogService
    garageService: GarageService
    ordersService: OrdersService
    paymentService: PaymentService
    telegramLinkService: TelegramLinkService
    deviceService: DeviceService
    env: AppEnv
    storageService: StorageService | null
    userId: string
  }
}

type CreateAppOptions = {
  env: AppEnv
  prisma: DbClient
}

export function createApp({ env, prisma }: CreateAppOptions) {
  const authService = new AuthService(prisma, env)
  const catalogProvider = new MockCatalogProvider()
  const supplierProvider = new MockSupplierProvider()
  const plateProvider = new MockPlateProvider()
  const catalogService = new CatalogService(catalogProvider, supplierProvider, plateProvider)
  const garageService = new GarageService(prisma, catalogProvider)
  const notificationService = new NotificationService(prisma, {
    pushSend: makeExpoPushSend(),
    telegramSend: env.TELEGRAM_BOT_TOKEN ? makeTelegramSend(env.TELEGRAM_BOT_TOKEN) : undefined,
  })
  const deviceService = new DeviceService(prisma)
  const ordersService = new OrdersService(prisma, supplierProvider, notificationService)
  const paymentProvider = createPaymentProvider(env)
  const webappOrigin = env.CORS_ORIGINS[0] ?? 'http://localhost:5173'
  const paymentService = new PaymentService(
    prisma,
    paymentProvider,
    {
      webappOrigin,
      returnUrl: env.PAYMENT_RETURN_URL ?? `${webappOrigin}/orders`,
    },
    notificationService,
  )
  const telegramLinkService = new TelegramLinkService(prisma, env.TELEGRAM_BOT_USERNAME)
  const storageService = createStorageServiceFromEnv(env)
  const app = new OpenAPIHono<AppBindings>({
    defaultHook: validationErrorHook,
  })

  app.use(secureHeaders())
  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return env.CORS_ORIGINS[0] ?? null
        return env.CORS_ORIGINS.includes(origin) ? origin : null
      },
      allowHeaders: ['Content-Type', 'Authorization', 'X-Client-Platform'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      credentials: true,
      maxAge: 600,
    }),
  )
  app.use('*', async (c, next) => {
    c.set('authService', authService)
    c.set('catalogService', catalogService)
    c.set('garageService', garageService)
    c.set('ordersService', ordersService)
    c.set('paymentService', paymentService)
    c.set('telegramLinkService', telegramLinkService)
    c.set('deviceService', deviceService)
    c.set('env', env)
    c.set('storageService', storageService)
    await next()
  })

  // Rate limiting (опционально, по env). Регистрируем до роутов, чтобы лимитер
  // отрабатывал раньше обработчика. Ключ — по IP клиента (X-Forwarded-For).
  const rateLimitWindowMs = (env.RATE_LIMIT_WINDOW_SECONDS ?? 60) * 1000
  if (env.RATE_LIMIT_AUTH_MAX) {
    const authRateLimit = rateLimit(
      new FixedWindowRateLimiter(env.RATE_LIMIT_AUTH_MAX, rateLimitWindowMs),
      'auth',
    )
    app.use('/api/auth/login', authRateLimit)
    app.use('/api/auth/register', authRateLimit)
  }
  if (env.RATE_LIMIT_PUBLIC_MAX) {
    app.use(
      '/api/catalog/*',
      rateLimit(new FixedWindowRateLimiter(env.RATE_LIMIT_PUBLIC_MAX, rateLimitWindowMs), 'public'),
    )
  }

  app.get('/', (c) => {
    return c.json({
      name: 'web_app_demo backend',
      status: 'ok',
    })
  })

  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
    })
  })

  app.route('/api/auth', createAuthRoutes())
  app.route('/api/catalog', createCatalogRoutes())
  app.route('/api/vehicles', createGarageRoutes())
  app.route('/api', createOrdersRoutes())
  app.route('/api/payments', createPaymentRoutes())
  app.route('/api/telegram', createTelegramRoutes())
  app.route('/api/devices', createDeviceRoutes())

  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: {
      title: 'web_app_demo API',
      version: '1.0.0',
    },
  })

  app.notFound((c) => c.json(errorResponse('NOT_FOUND', 'Route not found'), 404))
  app.onError(handleError)

  return app
}

export type AppType = ReturnType<typeof createApp>
