import {
  addVehicleRequestSchema,
  apiErrorSchema,
  garageResponseSchema,
  removeVehicleRequestSchema,
  updateVehicleRequestSchema,
  vehicleResponseSchema,
} from '@web-app-demo/contracts'
import { createRoute, OpenAPIHono } from '@hono/zod-openapi'

import type { Actor } from '../auth/actor'
import { requireAuth } from '../auth/middleware'
import type { AuthService } from '../auth/service'
import { validationErrorHook } from '../http/errors'
import type { GarageService } from './service'

type GarageRouteEnv = {
  Variables: {
    authService: AuthService
    garageService: GarageService
    actor: Actor
  }
}

const errorResponseContent = { 'application/json': { schema: apiErrorSchema } }
const unauthorized = { content: errorResponseContent, description: 'Требуется авторизация' }
const vehicleResponse = (description: string) => ({
  content: { 'application/json': { schema: vehicleResponseSchema } },
  description,
})

const listRoute = createRoute({
  method: 'get',
  path: '/',
  responses: {
    200: {
      content: { 'application/json': { schema: garageResponseSchema } },
      description: 'Гараж автосервиса',
    },
    401: unauthorized,
  },
})

const addRoute = createRoute({
  method: 'post',
  path: '/',
  request: {
    body: { content: { 'application/json': { schema: addVehicleRequestSchema } } },
  },
  responses: {
    201: vehicleResponse('Автомобиль добавлен'),
    400: { content: errorResponseContent, description: 'Некорректный VIN' },
    401: unauthorized,
    404: { content: errorResponseContent, description: 'Автомобиль или клиент не найден' },
  },
})

const updateRoute = createRoute({
  method: 'post',
  path: '/update',
  request: {
    body: { content: { 'application/json': { schema: updateVehicleRequestSchema } } },
  },
  responses: {
    200: vehicleResponse('Карточка обновлена'),
    400: { content: errorResponseContent, description: 'Некорректные данные' },
    401: unauthorized,
    404: { content: errorResponseContent, description: 'Автомобиль или клиент не найден' },
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
    401: unauthorized,
    404: { content: errorResponseContent, description: 'Автомобиль не найден' },
  },
})

export function createGarageRoutes() {
  const routes = new OpenAPIHono<GarageRouteEnv>({
    defaultHook: validationErrorHook,
  })

  routes.use('*', requireAuth())

  routes.openapi(listRoute, async (c) => {
    return c.json(await c.get('garageService').list(c.get('actor')), 200)
  })

  routes.openapi(addRoute, async (c) => {
    const service = c.get('garageService')
    return c.json(await service.add(c.get('actor'), c.req.valid('json')), 201)
  })

  routes.openapi(updateRoute, async (c) => {
    const service = c.get('garageService')
    return c.json(await service.update(c.get('actor'), c.req.valid('json')), 200)
  })

  routes.openapi(removeRoute, async (c) => {
    await c.get('garageService').remove(c.get('actor'), c.req.valid('json').id)
    return c.body(null, 204)
  })

  return routes
}
