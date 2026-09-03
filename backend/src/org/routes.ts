import {
  apiErrorSchema,
  joinOrganizationRequestSchema,
  organizationResponseSchema,
  updateOrganizationRequestSchema,
} from '@web-app-demo/contracts'
import { createRoute, OpenAPIHono } from '@hono/zod-openapi'

import type { Actor } from '../auth/actor'
import { requireAuth } from '../auth/middleware'
import type { AuthService } from '../auth/service'
import { validationErrorHook } from '../http/errors'
import type { OrganizationService } from './service'

type OrgRouteEnv = {
  Variables: {
    authService: AuthService
    organizationService: OrganizationService
    actor: Actor
  }
}

const errorResponseContent = { 'application/json': { schema: apiErrorSchema } }
const unauthorized = { content: errorResponseContent, description: 'Требуется авторизация' }
const orgResponse = {
  content: { 'application/json': { schema: organizationResponseSchema } },
  description: 'Автосервис пользователя',
}

const getRoute = createRoute({
  method: 'get',
  path: '/',
  responses: { 200: orgResponse, 401: unauthorized },
})

const updateRoute = createRoute({
  method: 'post',
  path: '/',
  request: {
    body: { content: { 'application/json': { schema: updateOrganizationRequestSchema } } },
  },
  responses: {
    200: orgResponse,
    400: { content: errorResponseContent, description: 'Некорректные данные' },
    401: unauthorized,
    403: { content: errorResponseContent, description: 'Только владелец' },
  },
})

const rotateInviteRoute = createRoute({
  method: 'post',
  path: '/invite/rotate',
  responses: {
    200: orgResponse,
    401: unauthorized,
    403: { content: errorResponseContent, description: 'Только владелец' },
  },
})

const joinRoute = createRoute({
  method: 'post',
  path: '/join',
  request: {
    body: { content: { 'application/json': { schema: joinOrganizationRequestSchema } } },
  },
  responses: {
    200: orgResponse,
    400: { content: errorResponseContent, description: 'Переход невозможен' },
    401: unauthorized,
    404: { content: errorResponseContent, description: 'Код приглашения не найден' },
  },
})

export function createOrgRoutes() {
  const routes = new OpenAPIHono<OrgRouteEnv>({ defaultHook: validationErrorHook })

  routes.use('*', requireAuth())

  routes.openapi(getRoute, async (c) => {
    return c.json(await c.get('organizationService').get(c.get('actor')), 200)
  })

  routes.openapi(updateRoute, async (c) => {
    const service = c.get('organizationService')
    return c.json(await service.update(c.get('actor'), c.req.valid('json')), 200)
  })

  routes.openapi(rotateInviteRoute, async (c) => {
    return c.json(await c.get('organizationService').rotateInviteCode(c.get('actor')), 200)
  })

  routes.openapi(joinRoute, async (c) => {
    const service = c.get('organizationService')
    return c.json(await service.join(c.get('actor'), c.req.valid('json').inviteCode), 200)
  })

  return routes
}
