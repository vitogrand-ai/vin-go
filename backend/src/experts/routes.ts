import {
  answerExpertRequestSchema,
  apiErrorSchema,
  createExpertRequestSchema,
  expertRequestResponseSchema,
  expertRequestsResponseSchema,
} from '@web-app-demo/contracts'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { Actor } from '../auth/actor'
import { requireAuth } from '../auth/middleware'
import type { AuthService } from '../auth/service'
import { validationErrorHook } from '../http/errors'
import type { ExpertsService } from './service'

type ExpertsRouteEnv = {
  Variables: {
    authService: AuthService
    expertsService: ExpertsService
    actor: Actor
  }
}

const errorResponseContent = { 'application/json': { schema: apiErrorSchema } }
const unauthorized = { content: errorResponseContent, description: 'Требуется авторизация' }
const requestResponse = (description: string) => ({
  content: { 'application/json': { schema: expertRequestResponseSchema } },
  description,
})

const listRoute = createRoute({
  method: 'get',
  path: '/requests',
  responses: {
    200: {
      content: { 'application/json': { schema: expertRequestsResponseSchema } },
      description: 'Заявки автосервиса (оператору — общая очередь)',
    },
    401: unauthorized,
  },
})

const createRouteDef = createRoute({
  method: 'post',
  path: '/requests',
  request: { body: { content: { 'application/json': { schema: createExpertRequestSchema } } } },
  responses: {
    201: requestResponse('Заявка создана'),
    400: { content: errorResponseContent, description: 'Некорректные данные' },
    401: unauthorized,
  },
})

const answerRoute = createRoute({
  method: 'post',
  path: '/requests/answer',
  request: { body: { content: { 'application/json': { schema: answerExpertRequestSchema } } } },
  responses: {
    200: requestResponse('Ответ сохранён, автор уведомлён'),
    400: { content: errorResponseContent, description: 'Некорректные данные' },
    401: unauthorized,
    403: { content: errorResponseContent, description: 'Только оператор' },
    404: { content: errorResponseContent, description: 'Заявка не найдена' },
  },
})

const getRoute = createRoute({
  method: 'get',
  path: '/requests/{id}',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: requestResponse('Заявка'),
    401: unauthorized,
    404: { content: errorResponseContent, description: 'Заявка не найдена' },
  },
})

export function createExpertsRoutes() {
  const routes = new OpenAPIHono<ExpertsRouteEnv>({ defaultHook: validationErrorHook })

  routes.use('*', requireAuth())

  routes.openapi(listRoute, async (c) => {
    return c.json(await c.get('expertsService').list(c.get('actor')), 200)
  })

  routes.openapi(createRouteDef, async (c) => {
    const service = c.get('expertsService')
    return c.json(await service.create(c.get('actor'), c.req.valid('json')), 201)
  })

  routes.openapi(answerRoute, async (c) => {
    const service = c.get('expertsService')
    return c.json(await service.answer(c.get('actor'), c.req.valid('json')), 200)
  })

  routes.openapi(getRoute, async (c) => {
    const service = c.get('expertsService')
    return c.json(await service.get(c.get('actor'), c.req.valid('param').id), 200)
  })

  return routes
}
