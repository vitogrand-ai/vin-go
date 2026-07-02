import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type {
  CartResponse,
  GarageResponse,
  OffersResponse,
  OrderResponse,
  OrdersResponse,
} from '@web-app-demo/contracts'

import { createApp } from './app'
import { createPrisma } from './db'
import type { AppEnv } from './env'

const databaseUrl = process.env.TEST_DATABASE_URL
const maybeDescribe = databaseUrl ? describe : describe.skip

const DEMO_VIN = 'WVWZZZ1JZ3W386752'

maybeDescribe('личный кабинет: гараж, корзина, заказы', () => {
  const env: AppEnv = {
    PORT: 3000,
    DATABASE_URL: databaseUrl!,
    JWT_SECRET: '12345678901234567890123456789012',
    CORS_ORIGINS: ['http://localhost:5173'],
    ACCESS_TOKEN_TTL_SECONDS: 900,
    REFRESH_TOKEN_TTL_DAYS: 30,
    COOKIE_SECURE: false,
    SPACES_UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
    SPACES_UPLOAD_URL_TTL_SECONDS: 900,
    SPACES_DOWNLOAD_URL_TTL_SECONDS: 300,
    SPACES_PUBLIC_CACHE_CONTROL: 'public, max-age=31536000, immutable',
  }
  const prisma = createPrisma(databaseUrl!)
  const app = createApp({ env, prisma })

  async function reset() {
    await prisma.orderItem.deleteMany()
    await prisma.order.deleteMany()
    await prisma.vehicle.deleteMany()
    await prisma.authSession.deleteMany()
    await prisma.user.deleteMany()
  }

  async function registerUser(): Promise<string> {
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Platform': 'mobile' },
      body: JSON.stringify({ email: 'service@example.com', password: 'password123' }),
    })
    const data = (await res.json()) as { accessToken: string }
    return data.accessToken
  }

  function authed(token: string, path: string, body?: unknown, method: 'GET' | 'POST' = body === undefined ? 'GET' : 'POST') {
    return app.request(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  const post = (token: string, path: string) => authed(token, path, undefined, 'POST')

  beforeEach(reset)
  afterAll(reset)

  test('защищённые роуты требуют авторизации', async () => {
    const res = await app.request('/api/cart')
    expect(res.status).toBe(401)
  })

  test('гараж: добавление по VIN и удаление', async () => {
    const token = await registerUser()

    const add = await authed(token, '/api/vehicles', { vin: DEMO_VIN, nickname: 'Гольф' })
    expect(add.status).toBe(201)

    const list = (await (await authed(token, '/api/vehicles')).json()) as GarageResponse
    expect(list.vehicles).toHaveLength(1)
    expect(list.vehicles[0]?.make).toBe('Volkswagen')

    await authed(token, '/api/vehicles/remove', { id: list.vehicles[0]!.id })
    const after = (await (await authed(token, '/api/vehicles')).json()) as GarageResponse
    expect(after.vehicles).toHaveLength(0)
  })

  test('корзина: добавление, количество, итог и оформление заказа', async () => {
    const token = await registerUser()

    // Берём реальный offerId из выдачи поставщиков.
    const offersRes = await app.request('/api/catalog/offers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oemNumber: '1J0698151' }),
    })
    const offers = (await offersRes.json()) as OffersResponse
    const economy = offers.picks.find((p) => p.tier === 'ECONOMY')!.offer

    const added = (await (
      await authed(token, '/api/cart/items', {
        oemNumber: economy.oemNumber,
        offerId: economy.id,
        partName: 'Колодки тормозные передние',
        tier: 'ECONOMY',
        vehicleVin: DEMO_VIN,
      })
    ).json()) as OrderResponse
    expect(added.order.items).toHaveLength(1)

    // Цена в корзине авторитетна с сервера, а не из запроса.
    expect(added.order.items[0]?.price.amount).toBe(economy.price.amount)

    const itemId = added.order.items[0]!.id
    const updated = (await (
      await authed(token, '/api/cart/items/quantity', { itemId, quantity: 3 })
    ).json()) as OrderResponse
    expect(updated.order.itemCount).toBe(3)
    expect(updated.order.total.amount).toBe(economy.price.amount * 3)

    // Повторное добавление того же предложения увеличивает количество, а не дублирует.
    const again = (await (
      await authed(token, '/api/cart/items', {
        oemNumber: economy.oemNumber,
        offerId: economy.id,
        partName: 'Колодки тормозные передние',
      })
    ).json()) as OrderResponse
    expect(again.order.items).toHaveLength(1)
    expect(again.order.itemCount).toBe(4)

    const checkout = (await (await post(token, '/api/cart/checkout')).json()) as OrderResponse
    expect(checkout.order.status).toBe('PLACED')
    expect(checkout.order.placedAt).not.toBeNull()

    // После оформления корзина пуста.
    const cart = (await (await authed(token, '/api/cart')).json()) as CartResponse
    expect(cart.order).toBeNull()

    // Заказ виден в истории.
    const orders = (await (await authed(token, '/api/orders')).json()) as OrdersResponse
    expect(orders.orders).toHaveLength(1)
    expect(orders.orders[0]?.itemCount).toBe(4)
  })

  test('привязка корзины к авто, карточка заказа и заметки', async () => {
    const token = await registerUser()

    // Привязываем корзину к авто из гаража (создаёт черновик).
    const cartWithVehicle = (await (
      await authed(token, '/api/cart/vehicle', { vin: DEMO_VIN })
    ).json()) as OrderResponse
    expect(cartWithVehicle.order.vehicleVin).toBe(DEMO_VIN)

    // Добавляем позицию и оформляем.
    const offersRes = await app.request('/api/catalog/offers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oemNumber: '1J0698151' }),
    })
    const economy = ((await offersRes.json()) as OffersResponse).picks.find(
      (p) => p.tier === 'ECONOMY',
    )!.offer
    await authed(token, '/api/cart/items', {
      oemNumber: economy.oemNumber,
      offerId: economy.id,
      partName: 'Колодки',
    })
    const checkout = (await (
      await authed(token, '/api/cart/checkout', undefined, 'POST')
    ).json()) as OrderResponse
    const orderId = checkout.order.id
    expect(checkout.order.vehicleVin).toBe(DEMO_VIN)

    // Карточка заказа.
    const detail = (await (await authed(token, `/api/orders/${orderId}`)).json()) as OrderResponse
    expect(detail.order.id).toBe(orderId)
    expect(detail.order.notes).toBeNull()

    // Заметка к заказу.
    const noted = (await (
      await authed(token, '/api/orders/notes', { orderId, notes: '  Срочно, клиент ждёт  ' })
    ).json()) as OrderResponse
    expect(noted.order.notes).toBe('Срочно, клиент ждёт')

    // Очистка заметки.
    const cleared = (await (
      await authed(token, '/api/orders/notes', { orderId, notes: '' })
    ).json()) as OrderResponse
    expect(cleared.order.notes).toBeNull()
  })

  test('карточка несуществующего заказа возвращает 404', async () => {
    const token = await registerUser()
    const res = await authed(token, '/api/orders/00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(404)
  })

  test('оформление пустой корзины запрещено', async () => {
    const token = await registerUser()
    const res = await post(token, '/api/cart/checkout')
    expect(res.status).toBe(400)
  })

  test('нельзя добавить позицию с несуществующим offerId', async () => {
    const token = await registerUser()
    const res = await authed(token, '/api/cart/items', {
      oemNumber: '1J0698151',
      offerId: 'НЕСУЩЕСТВУЕТ',
      partName: 'Колодки',
    })
    expect(res.status).toBe(404)
  })
})
