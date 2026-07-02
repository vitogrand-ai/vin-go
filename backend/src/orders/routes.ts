import {
  addCartItemRequestSchema,
  apiErrorSchema,
  cartResponseSchema,
  orderResponseSchema,
  ordersResponseSchema,
  removeCartItemRequestSchema,
  setCartVehicleRequestSchema,
  updateCartItemRequestSchema,
  updateOrderNotesRequestSchema,
  updateOrderStatusRequestSchema,
} from '@web-app-demo/contracts'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import { requireAuth } from '../auth/middleware'
import type { AuthService } from '../auth/service'
import { validationErrorHook } from '../http/errors'
import type { OrdersService } from './service'

type OrdersRouteEnv = {
  Variables: {
    authService: AuthService
    ordersService: OrdersService
    userId: string
  }
}

const errorResponseContent = { 'application/json': { schema: apiErrorSchema } }
const unauthorized = { content: errorResponseContent, description: 'Требуется авторизация' }

const getCartRoute = createRoute({
  method: 'get',
  path: '/cart',
  responses: {
    200: {
      content: { 'application/json': { schema: cartResponseSchema } },
      description: 'Текущая корзина (черновик заказа)',
    },
    401: unauthorized,
  },
})

const addItemRoute = createRoute({
  method: 'post',
  path: '/cart/items',
  request: { body: { content: { 'application/json': { schema: addCartItemRequestSchema } } } },
  responses: {
    200: {
      content: { 'application/json': { schema: orderResponseSchema } },
      description: 'Позиция добавлена, обновлённая корзина',
    },
    400: { content: errorResponseContent, description: 'Некорректный запрос' },
    401: unauthorized,
    404: { content: errorResponseContent, description: 'Предложение недоступно' },
  },
})

const updateItemRoute = createRoute({
  method: 'post',
  path: '/cart/items/quantity',
  request: { body: { content: { 'application/json': { schema: updateCartItemRequestSchema } } } },
  responses: {
    200: {
      content: { 'application/json': { schema: orderResponseSchema } },
      description: 'Количество обновлено',
    },
    401: unauthorized,
    404: { content: errorResponseContent, description: 'Позиция не найдена' },
  },
})

const removeItemRoute = createRoute({
  method: 'post',
  path: '/cart/items/remove',
  request: { body: { content: { 'application/json': { schema: removeCartItemRequestSchema } } } },
  responses: {
    200: {
      content: { 'application/json': { schema: orderResponseSchema } },
      description: 'Позиция удалена',
    },
    401: unauthorized,
    404: { content: errorResponseContent, description: 'Позиция не найдена' },
  },
})

const clearCartRoute = createRoute({
  method: 'post',
  path: '/cart/clear',
  responses: {
    204: { description: 'Корзина очищена' },
    401: unauthorized,
  },
})

const checkoutRoute = createRoute({
  method: 'post',
  path: '/cart/checkout',
  responses: {
    200: {
      content: { 'application/json': { schema: orderResponseSchema } },
      description: 'Заказ оформлен',
    },
    400: { content: errorResponseContent, description: 'Корзина пуста' },
    401: unauthorized,
  },
})

const setCartVehicleRoute = createRoute({
  method: 'post',
  path: '/cart/vehicle',
  request: { body: { content: { 'application/json': { schema: setCartVehicleRequestSchema } } } },
  responses: {
    200: {
      content: { 'application/json': { schema: orderResponseSchema } },
      description: 'Авто привязано к корзине',
    },
    400: { content: errorResponseContent, description: 'Некорректный VIN' },
    401: unauthorized,
  },
})

const getOrderRoute = createRoute({
  method: 'get',
  path: '/orders/{id}',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: orderResponseSchema } },
      description: 'Заказ',
    },
    401: unauthorized,
    404: { content: errorResponseContent, description: 'Заказ не найден' },
  },
})

const updateNotesRoute = createRoute({
  method: 'post',
  path: '/orders/notes',
  request: {
    body: { content: { 'application/json': { schema: updateOrderNotesRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: orderResponseSchema } },
      description: 'Заметка сохранена',
    },
    401: unauthorized,
    404: { content: errorResponseContent, description: 'Заказ не найден' },
  },
})

const updateStatusRoute = createRoute({
  method: 'post',
  path: '/orders/status',
  request: {
    body: { content: { 'application/json': { schema: updateOrderStatusRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: orderResponseSchema } },
      description: 'Статус заказа обновлён',
    },
    400: { content: errorResponseContent, description: 'Недопустимый переход' },
    401: unauthorized,
    404: { content: errorResponseContent, description: 'Заказ не найден' },
  },
})

const listOrdersRoute = createRoute({
  method: 'get',
  path: '/orders',
  responses: {
    200: {
      content: { 'application/json': { schema: ordersResponseSchema } },
      description: 'История заказов',
    },
    401: unauthorized,
  },
})

export function createOrdersRoutes() {
  const routes = new OpenAPIHono<OrdersRouteEnv>({
    defaultHook: validationErrorHook,
  })

  routes.use('*', requireAuth())

  routes.openapi(getCartRoute, async (c) => {
    const service = c.get('ordersService')
    return c.json(await service.getCart(c.get('userId')), 200)
  })

  routes.openapi(addItemRoute, async (c) => {
    const service = c.get('ordersService')
    return c.json(await service.addItem(c.get('userId'), c.req.valid('json')), 200)
  })

  routes.openapi(updateItemRoute, async (c) => {
    const service = c.get('ordersService')
    const { itemId, quantity } = c.req.valid('json')
    return c.json(await service.updateItemQuantity(c.get('userId'), itemId, quantity), 200)
  })

  routes.openapi(removeItemRoute, async (c) => {
    const service = c.get('ordersService')
    return c.json(await service.removeItem(c.get('userId'), c.req.valid('json').itemId), 200)
  })

  routes.openapi(clearCartRoute, async (c) => {
    const service = c.get('ordersService')
    await service.clear(c.get('userId'))
    return c.body(null, 204)
  })

  routes.openapi(setCartVehicleRoute, async (c) => {
    const service = c.get('ordersService')
    return c.json(await service.setCartVehicle(c.get('userId'), c.req.valid('json').vin), 200)
  })

  routes.openapi(updateNotesRoute, async (c) => {
    const service = c.get('ordersService')
    const { orderId, notes } = c.req.valid('json')
    return c.json(await service.updateNotes(c.get('userId'), orderId, notes), 200)
  })

  routes.openapi(checkoutRoute, async (c) => {
    const service = c.get('ordersService')
    return c.json(await service.checkout(c.get('userId')), 200)
  })

  routes.openapi(updateStatusRoute, async (c) => {
    const service = c.get('ordersService')
    const { orderId, status } = c.req.valid('json')
    return c.json(await service.updateStatus(c.get('userId'), orderId, status), 200)
  })

  routes.openapi(listOrdersRoute, async (c) => {
    const service = c.get('ordersService')
    return c.json(await service.listOrders(c.get('userId')), 200)
  })

  routes.openapi(getOrderRoute, async (c) => {
    const service = c.get('ordersService')
    return c.json(await service.getOrder(c.get('userId'), c.req.valid('param').id), 200)
  })

  return routes
}
