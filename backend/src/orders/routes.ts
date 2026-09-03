import {
  addCartItemRequestSchema,
  apiErrorSchema,
  cartResponseSchema,
  orderResponseSchema,
  ordersResponseSchema,
  removeCartItemRequestSchema,
  setCartCustomerRequestSchema,
  setCartVehicleRequestSchema,
  updateCartItemRequestSchema,
  updateCartItemSalePriceRequestSchema,
  updateOrderNotesRequestSchema,
  updateOrderStatusRequestSchema,
} from '@web-app-demo/contracts'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { Actor } from '../auth/actor'
import { requireAuth } from '../auth/middleware'
import type { AuthService } from '../auth/service'
import { validationErrorHook } from '../http/errors'
import type { OrdersService } from './service'

type OrdersRouteEnv = {
  Variables: {
    authService: AuthService
    ordersService: OrdersService
    actor: Actor
  }
}

const errorResponseContent = { 'application/json': { schema: apiErrorSchema } }
const unauthorized = { content: errorResponseContent, description: 'Требуется авторизация' }
const orderResponse = (description: string) => ({
  content: { 'application/json': { schema: orderResponseSchema } },
  description,
})

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
    200: orderResponse('Позиция добавлена, обновлённая корзина'),
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
    200: orderResponse('Количество обновлено'),
    401: unauthorized,
    404: { content: errorResponseContent, description: 'Позиция не найдена' },
  },
})

const updateItemSalePriceRoute = createRoute({
  method: 'post',
  path: '/cart/items/sale-price',
  request: {
    body: { content: { 'application/json': { schema: updateCartItemSalePriceRequestSchema } } },
  },
  responses: {
    200: orderResponse('Цена для клиента обновлена'),
    400: { content: errorResponseContent, description: 'Некорректная цена' },
    401: unauthorized,
    404: { content: errorResponseContent, description: 'Позиция не найдена' },
  },
})

const removeItemRoute = createRoute({
  method: 'post',
  path: '/cart/items/remove',
  request: { body: { content: { 'application/json': { schema: removeCartItemRequestSchema } } } },
  responses: {
    200: orderResponse('Позиция удалена'),
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
    200: orderResponse('Заказ оформлен'),
    400: { content: errorResponseContent, description: 'Корзина пуста' },
    401: unauthorized,
  },
})

const setCartVehicleRoute = createRoute({
  method: 'post',
  path: '/cart/vehicle',
  request: { body: { content: { 'application/json': { schema: setCartVehicleRequestSchema } } } },
  responses: {
    200: orderResponse('Авто привязано к корзине'),
    400: { content: errorResponseContent, description: 'Некорректный VIN' },
    401: unauthorized,
  },
})

const setCartCustomerRoute = createRoute({
  method: 'post',
  path: '/cart/customer',
  request: { body: { content: { 'application/json': { schema: setCartCustomerRequestSchema } } } },
  responses: {
    200: orderResponse('Клиент привязан к корзине'),
    401: unauthorized,
    404: { content: errorResponseContent, description: 'Клиент не найден' },
  },
})

const getOrderRoute = createRoute({
  method: 'get',
  path: '/orders/{id}',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: orderResponse('Заказ'),
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
    200: orderResponse('Заметка сохранена'),
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
    200: orderResponse('Статус заказа обновлён'),
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
      description: 'Заказы автосервиса (оператору платформы — все)',
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
    return c.json(await c.get('ordersService').getCart(c.get('actor')), 200)
  })

  routes.openapi(addItemRoute, async (c) => {
    const service = c.get('ordersService')
    return c.json(await service.addItem(c.get('actor'), c.req.valid('json')), 200)
  })

  routes.openapi(updateItemRoute, async (c) => {
    const service = c.get('ordersService')
    const { itemId, quantity } = c.req.valid('json')
    return c.json(await service.updateItemQuantity(c.get('actor'), itemId, quantity), 200)
  })

  routes.openapi(updateItemSalePriceRoute, async (c) => {
    const service = c.get('ordersService')
    const { itemId, saleAmount } = c.req.valid('json')
    return c.json(await service.updateItemSalePrice(c.get('actor'), itemId, saleAmount), 200)
  })

  routes.openapi(removeItemRoute, async (c) => {
    const service = c.get('ordersService')
    return c.json(await service.removeItem(c.get('actor'), c.req.valid('json').itemId), 200)
  })

  routes.openapi(clearCartRoute, async (c) => {
    await c.get('ordersService').clear(c.get('actor'))
    return c.body(null, 204)
  })

  routes.openapi(setCartVehicleRoute, async (c) => {
    const service = c.get('ordersService')
    return c.json(await service.setCartVehicle(c.get('actor'), c.req.valid('json').vin), 200)
  })

  routes.openapi(setCartCustomerRoute, async (c) => {
    const service = c.get('ordersService')
    return c.json(
      await service.setCartCustomer(c.get('actor'), c.req.valid('json').customerId),
      200,
    )
  })

  routes.openapi(updateNotesRoute, async (c) => {
    const service = c.get('ordersService')
    const { orderId, notes } = c.req.valid('json')
    return c.json(await service.updateNotes(c.get('actor'), orderId, notes), 200)
  })

  routes.openapi(checkoutRoute, async (c) => {
    return c.json(await c.get('ordersService').checkout(c.get('actor')), 200)
  })

  routes.openapi(updateStatusRoute, async (c) => {
    const service = c.get('ordersService')
    const { orderId, status } = c.req.valid('json')
    return c.json(await service.updateStatus(c.get('actor'), orderId, status), 200)
  })

  routes.openapi(listOrdersRoute, async (c) => {
    return c.json(await c.get('ordersService').listOrders(c.get('actor')), 200)
  })

  routes.openapi(getOrderRoute, async (c) => {
    const service = c.get('ordersService')
    return c.json(await service.getOrder(c.get('actor'), c.req.valid('param').id), 200)
  })

  return routes
}
