import {
  apiErrorSchema,
  createCustomerRequestSchema,
  customerResponseSchema,
  customersResponseSchema,
  removeCustomerRequestSchema,
  updateCustomerRequestSchema,
} from '@web-app-demo/contracts'
import { createRoute, OpenAPIHono } from '@hono/zod-openapi'

import type { Actor } from '../auth/actor'
import { requireAuth } from '../auth/middleware'
import type { AuthService } from '../auth/service'
import { validationErrorHook } from '../http/errors'
import type { CustomersService } from './service'

type CustomersRouteEnv = {
  Variables: {
    authService: AuthService
    customersService: CustomersService
    actor: Actor
  }
}

const errorResponseContent = { 'application/json': { schema: apiErrorSchema } }
const unauthorized = { content: errorResponseContent, description: 'Требуется авторизация' }
const customerResponse = {
  content: { 'application/json': { schema: customerResponseSchema } },
  description: 'Карточка клиента',
}

const listRoute = createRoute({
  method: 'get',
  path: '/',
  responses: {
    200: {
      content: { 'application/json': { schema: customersResponseSchema } },
      description: 'Клиенты автосервиса',
    },
    401: unauthorized,
  },
})

const createRouteDef = createRoute({
  method: 'post',
  path: '/',
  request: { body: { content: { 'application/json': { schema: createCustomerRequestSchema } } } },
  responses: {
    201: customerResponse,
    400: { content: errorResponseContent, description: 'Некорректные данные' },
    401: unauthorized,
  },
})

const updateRoute = createRoute({
  method: 'post',
  path: '/update',
  request: { body: { content: { 'application/json': { schema: updateCustomerRequestSchema } } } },
  responses: {
    200: customerResponse,
    400: { content: errorResponseContent, description: 'Некорректные данные' },
    401: unauthorized,
    404: { content: errorResponseContent, description: 'Клиент не найден' },
  },
})

const removeRoute = createRoute({
  method: 'post',
  path: '/remove',
  request: { body: { content: { 'application/json': { schema: removeCustomerRequestSchema } } } },
  responses: {
    204: { description: 'Клиент удалён' },
    401: unauthorized,
    404: { content: errorResponseContent, description: 'Клиент не найден' },
  },
})

export function createCustomersRoutes() {
  const routes = new OpenAPIHono<CustomersRouteEnv>({ defaultHook: validationErrorHook })

  routes.use('*', requireAuth())

  routes.openapi(listRoute, async (c) => {
    return c.json(await c.get('customersService').list(c.get('actor')), 200)
  })

  routes.openapi(createRouteDef, async (c) => {
    const service = c.get('customersService')
    return c.json(await service.create(c.get('actor'), c.req.valid('json')), 201)
  })

  routes.openapi(updateRoute, async (c) => {
    const service = c.get('customersService')
    return c.json(await service.update(c.get('actor'), c.req.valid('json')), 200)
  })

  routes.openapi(removeRoute, async (c) => {
    await c.get('customersService').remove(c.get('actor'), c.req.valid('json').id)
    return c.body(null, 204)
  })

  return routes
}
