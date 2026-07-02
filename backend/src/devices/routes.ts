import { apiErrorSchema, registerDeviceRequestSchema } from '@web-app-demo/contracts'
import { createRoute, OpenAPIHono } from '@hono/zod-openapi'

import { requireAuth } from '../auth/middleware'
import type { AuthService } from '../auth/service'
import { validationErrorHook } from '../http/errors'
import type { DeviceService } from './service'

type DeviceRouteEnv = {
  Variables: {
    authService: AuthService
    deviceService: DeviceService
    userId: string
  }
}

const errorResponseContent = { 'application/json': { schema: apiErrorSchema } }

const registerRoute = createRoute({
  method: 'post',
  path: '/register',
  request: { body: { content: { 'application/json': { schema: registerDeviceRequestSchema } } } },
  responses: {
    204: { description: 'Токен зарегистрирован' },
    400: { content: errorResponseContent, description: 'Некорректный токен' },
    401: { content: errorResponseContent, description: 'Требуется авторизация' },
  },
})

export function createDeviceRoutes() {
  const routes = new OpenAPIHono<DeviceRouteEnv>({
    defaultHook: validationErrorHook,
  })

  routes.use('*', requireAuth())

  routes.openapi(registerRoute, async (c) => {
    const service = c.get('deviceService')
    await service.register(c.get('userId'), c.req.valid('json'))
    return c.body(null, 204)
  })

  return routes
}
