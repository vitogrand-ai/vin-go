import {
  apiErrorSchema,
  telegramLinkCodeResponseSchema,
  telegramStatusResponseSchema,
} from '@web-app-demo/contracts'
import { createRoute, OpenAPIHono } from '@hono/zod-openapi'

import { requireAuth } from '../auth/middleware'
import type { AuthService } from '../auth/service'
import { validationErrorHook } from '../http/errors'
import type { TelegramLinkService } from './service'

type TelegramRouteEnv = {
  Variables: {
    authService: AuthService
    telegramLinkService: TelegramLinkService
    userId: string
  }
}

const errorResponseContent = { 'application/json': { schema: apiErrorSchema } }
const unauthorized = { content: errorResponseContent, description: 'Требуется авторизация' }

const statusRoute = createRoute({
  method: 'get',
  path: '/status',
  responses: {
    200: {
      content: { 'application/json': { schema: telegramStatusResponseSchema } },
      description: 'Статус привязки Telegram',
    },
    401: unauthorized,
  },
})

const linkCodeRoute = createRoute({
  method: 'post',
  path: '/link-code',
  responses: {
    200: {
      content: { 'application/json': { schema: telegramLinkCodeResponseSchema } },
      description: 'Код и ссылка для привязки',
    },
    401: unauthorized,
  },
})

export function createTelegramRoutes() {
  const routes = new OpenAPIHono<TelegramRouteEnv>({
    defaultHook: validationErrorHook,
  })

  routes.use('*', requireAuth())

  routes.openapi(statusRoute, async (c) => {
    const service = c.get('telegramLinkService')
    return c.json(await service.status(c.get('userId')), 200)
  })

  routes.openapi(linkCodeRoute, async (c) => {
    const service = c.get('telegramLinkService')
    return c.json(await service.createLinkCode(c.get('userId')), 200)
  })

  return routes
}
