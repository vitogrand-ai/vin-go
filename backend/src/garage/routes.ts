import {
  addVehicleRequestSchema,
  apiErrorSchema,
  garageResponseSchema,
  removeVehicleRequestSchema,
  vehicleResponseSchema,
} from '@web-app-demo/contracts'
import { createRoute, OpenAPIHono } from '@hono/zod-openapi'

import { requireAuth } from '../auth/middleware'
import type { AuthService } from '../auth/service'
import { validationErrorHook } from '../http/errors'
import type { GarageService } from './service'

type GarageRouteEnv = {
  Variables: {
    authService: AuthService
    garageService: GarageService
    userId: string
  }
}

const errorResponseContent = { 'application/json': { schema: apiErrorSchema } }

const listRoute = createRoute({
  method: 'get',
  path: '/',
  responses: {
    200: {
      content: { 'application/json': { schema: garageResponseSchema } },
      description: 'Список сохранённых автомобилей',
    },
    401: { content: errorResponseContent, description: 'Требуется авторизация' },
  },
})

const addRoute = createRoute({
  method: 'post',
  path: '/',
  request: {
    body: { content: { 'application/json': { schema: addVehicleRequestSchema } } },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: vehicleResponseSchema } },
      description: 'Автомобиль добавлен',
    },
    400: { content: errorResponseContent, description: 'Некорректный VIN' },
    401: { content: errorResponseContent, description: 'Требуется авторизация' },
    404: { content: errorResponseContent, description: 'Автомобиль не найден' },
  },
})

const removeRoute = createRoute({
  method: 'post',
  path: '/remove',
  request: {
    body: { content: { 'application/json': { schema: removeVehicleRequestSchema } } },
  },
  responses: {
    204: { description: 'Автомобиль удалён' },
    401: { content: errorResponseContent, description: 'Требуется авторизация' },
    404: { content: errorResponseContent, description: 'Автомобиль не найден' },
  },
})

export function createGarageRoutes() {
  const routes = new OpenAPIHono<GarageRouteEnv>({
    defaultHook: validationErrorHook,
  })

  routes.use('*', requireAuth())

  routes.openapi(listRoute, async (c) => {
    const service = c.get('garageService')
    return c.json(await service.list(c.get('userId')), 200)
  })

  routes.openapi(addRoute, async (c) => {
    const service = c.get('garageService')
    return c.json(await service.add(c.get('userId'), c.req.valid('json')), 201)
  })

  routes.openapi(removeRoute, async (c) => {
    const service = c.get('garageService')
    await service.remove(c.get('userId'), c.req.valid('json').id)
    return c.body(null, 204)
  })

  return routes
}
