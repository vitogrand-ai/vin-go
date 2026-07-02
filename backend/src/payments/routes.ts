import {
  apiErrorSchema,
  confirmMockPaymentRequestSchema,
  createPaymentRequestSchema,
  createPaymentResponseSchema,
  refundRequestSchema,
  refundResponseSchema,
} from '@web-app-demo/contracts'
import { createRoute, OpenAPIHono } from '@hono/zod-openapi'

import { requireAuth } from '../auth/middleware'
import type { AuthService } from '../auth/service'
import { validationErrorHook } from '../http/errors'
import type { PaymentService } from './service'

type PaymentRouteEnv = {
  Variables: {
    authService: AuthService
    paymentService: PaymentService
    userId: string
  }
}

const errorResponseContent = { 'application/json': { schema: apiErrorSchema } }
const paymentResponseContent = { 'application/json': { schema: createPaymentResponseSchema } }
const unauthorized = { content: errorResponseContent, description: 'Требуется авторизация' }

const createRouteDef = createRoute({
  method: 'post',
  path: '/create',
  request: { body: { content: { 'application/json': { schema: createPaymentRequestSchema } } } },
  responses: {
    200: { content: paymentResponseContent, description: 'Платёж создан, ссылка на оплату' },
    400: { content: errorResponseContent, description: 'Заказ нельзя оплатить' },
    401: unauthorized,
    404: { content: errorResponseContent, description: 'Заказ не найден' },
    409: { content: errorResponseContent, description: 'Заказ уже оплачен' },
  },
})

const confirmMockRouteDef = createRoute({
  method: 'post',
  path: '/mock/confirm',
  request: {
    body: { content: { 'application/json': { schema: confirmMockPaymentRequestSchema } } },
  },
  responses: {
    200: { content: paymentResponseContent, description: 'Оплата подтверждена (мок)' },
    400: { content: errorResponseContent, description: 'Подтверждение недоступно' },
    401: unauthorized,
    404: { content: errorResponseContent, description: 'Платёж не найден' },
  },
})

const refundRouteDef = createRoute({
  method: 'post',
  path: '/refund',
  request: { body: { content: { 'application/json': { schema: refundRequestSchema } } } },
  responses: {
    200: {
      content: { 'application/json': { schema: refundResponseSchema } },
      description: 'Возврат выполнен',
    },
    400: { content: errorResponseContent, description: 'Заказ не оплачен' },
    401: unauthorized,
    404: { content: errorResponseContent, description: 'Заказ не найден' },
    409: { content: errorResponseContent, description: 'Возврат уже выполнен' },
  },
})

export function createPaymentRoutes() {
  const routes = new OpenAPIHono<PaymentRouteEnv>({
    defaultHook: validationErrorHook,
  })

  // Webhook провайдера (ЮKassa) — без авторизации, до защищённых роутов.
  routes.post('/webhook', async (c) => {
    const service = c.get('paymentService')
    const body = await c.req.json().catch(() => null)
    await service.handleWebhook(body)
    return c.body(null, 200)
  })

  routes.use('/create', requireAuth())
  routes.use('/mock/confirm', requireAuth())
  routes.use('/refund', requireAuth())

  routes.openapi(createRouteDef, async (c) => {
    const service = c.get('paymentService')
    const { orderId, method } = c.req.valid('json')
    return c.json(await service.createForOrder(c.get('userId'), orderId, method), 200)
  })

  routes.openapi(refundRouteDef, async (c) => {
    const service = c.get('paymentService')
    return c.json(await service.refundOrder(c.get('userId'), c.req.valid('json').orderId), 200)
  })

  routes.openapi(confirmMockRouteDef, async (c) => {
    const service = c.get('paymentService')
    return c.json(await service.confirmMock(c.get('userId'), c.req.valid('json').paymentId), 200)
  })

  return routes
}
