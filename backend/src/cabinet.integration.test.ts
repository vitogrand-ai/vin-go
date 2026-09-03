import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  applyMarkup,
  type CartResponse,
  type CustomerResponse,
  type GarageResponse,
  type OffersResponse,
  type OrderResponse,
  type OrdersResponse,
  type OrganizationResponse,
  type VehicleResponse,
} from '@web-app-demo/contracts'

import { createApp } from './app'
import { MockSupplierProvider } from './catalog/mock-providers'
import { CachingSupplierProvider } from './catalog/offer-cache'
import type { SupplierProvider } from './catalog/providers'
import { createPrisma } from './db'
import type { AppEnv } from './env'
import { OrdersService } from './orders/service'

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
    YOOKASSA_WEBHOOK_IP_ALLOWLIST: false,
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
    await prisma.customer.deleteMany()
    await prisma.authSession.deleteMany()
    await prisma.user.deleteMany()
    await prisma.organization.deleteMany()
  }

  async function registerUser(
    email = 'service@example.com',
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Platform': 'mobile' },
      body: JSON.stringify({ email, password: 'password123', ...extra }),
    })
    const data = (await res.json()) as { accessToken: string }
    return data.accessToken
  }

  /** Эконом-предложение по демо-OEM из выдачи поставщиков. */
  async function economyOffer(oemNumber = '1J0698151') {
    const offersRes = await app.request('/api/catalog/offers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oemNumber }),
    })
    return ((await offersRes.json()) as OffersResponse).picks.find((p) => p.tier === 'ECONOMY')!
      .offer
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

  test('снимок выдачи: addItem резолвит offerId без повторного запроса к поставщику', async () => {
    const org = await prisma.organization.create({
      data: { name: 'Снимок', inviteCode: 'SNAPSHOT' },
    })
    const user = await prisma.user.create({
      data: { email: 'snapshot@example.com', passwordHash: 'x', orgId: org.id, orgRole: 'OWNER' },
    })
    const actor = { userId: user.id, orgId: org.id, role: 'USER' as const, orgRole: 'OWNER' as const }
    let getOffersCalls = 0
    const inner: SupplierProvider = {
      getOffers: async (oem, region) => {
        getOffersCalls += 1
        return new MockSupplierProvider().getOffers(oem, region)
      },
    }
    const caching = new CachingSupplierProvider(inner)
    const svc = new OrdersService(prisma, caching, undefined, caching)

    // Поиск: наполняет снимок (1-й и единственный вызов getOffers).
    const offers = await caching.getOffers('1J0698151')
    expect(getOffersCalls).toBe(1)

    // В корзину по id из снимка — без повторного getOffers.
    await svc.addItem(actor, {
      oemNumber: '1J0698151',
      offerId: offers[0]!.id,
      partName: 'Колодки',
    })
    expect(getOffersCalls).toBe(1)

    const cart = await svc.getCart(actor)
    expect(cart.order?.items).toHaveLength(1)
    expect(cart.order?.items[0]?.oemNumber).toBe('1J0698151')
  })

  test('гонка: параллельные добавления в корзину создают один черновик', async () => {
    const token = await registerUser()
    const offersRes = await app.request('/api/catalog/offers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oemNumber: '1J0698151' }),
    })
    const economy = ((await offersRes.json()) as OffersResponse).picks.find(
      (p) => p.tier === 'ECONOMY',
    )!.offer

    // Две одновременные вставки в корзину для одного пользователя.
    const item = { oemNumber: economy.oemNumber, offerId: economy.id, partName: 'Колодки' }
    const [a, b] = await Promise.all([
      authed(token, '/api/cart/items', item),
      authed(token, '/api/cart/items', item),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)

    // Черновик остаётся ровно один: unique draftKey исключает второй.
    const drafts = await prisma.order.count({ where: { status: 'DRAFT' } })
    expect(drafts).toBe(1)
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

  test('регистрация создаёт автосервис, а его владелец видит настройки', async () => {
    const token = await registerUser('owner@example.com', { orgName: 'СТО «Гараж 5»' })
    const me = (await (await authed(token, '/api/auth/me')).json()) as {
      user: { orgId: string | null; orgRole: string }
    }
    expect(me.user.orgId).not.toBeNull()
    expect(me.user.orgRole).toBe('OWNER')

    const org = (await (await authed(token, '/api/org')).json()) as OrganizationResponse
    expect(org.organization.name).toBe('СТО «Гараж 5»')
    expect(org.organization.memberCount).toBe(1)
    expect(org.organization.inviteCode.length).toBeGreaterThanOrEqual(6)
  })

  test('изоляция автосервисов: чужие заказы и гараж не видны', async () => {
    const alice = await registerUser('alice@example.com')
    const bob = await registerUser('bob@example.com')

    const economy = await economyOffer()
    await authed(alice, '/api/cart/items', {
      oemNumber: economy.oemNumber,
      offerId: economy.id,
      partName: 'Колодки',
    })
    const placed = (await (await post(alice, '/api/cart/checkout')).json()) as OrderResponse
    await authed(alice, '/api/vehicles', { vin: DEMO_VIN })

    const bobOrders = (await (await authed(bob, '/api/orders')).json()) as OrdersResponse
    expect(bobOrders.orders).toHaveLength(0)
    expect((await authed(bob, `/api/orders/${placed.order.id}`)).status).toBe(404)
    expect((await authed(bob, '/api/orders/notes', { orderId: placed.order.id, notes: 'x' })).status).toBe(404)
    expect((await authed(bob, '/api/payments/create', { orderId: placed.order.id })).status).toBe(404)

    const bobGarage = (await (await authed(bob, '/api/vehicles')).json()) as GarageResponse
    expect(bobGarage.vehicles).toHaveLength(0)
  })

  test('сотрудник по коду приглашения видит заказы и гараж автосервиса', async () => {
    const owner = await registerUser('owner@example.com')
    const org = (await (await authed(owner, '/api/org')).json()) as OrganizationResponse

    const economy = await economyOffer()
    await authed(owner, '/api/cart/items', {
      oemNumber: economy.oemNumber,
      offerId: economy.id,
      partName: 'Колодки',
    })
    await post(owner, '/api/cart/checkout')
    await authed(owner, '/api/vehicles', { vin: DEMO_VIN })

    const member = await registerUser('member@example.com', {
      inviteCode: org.organization.inviteCode,
    })
    const memberOrders = (await (await authed(member, '/api/orders')).json()) as OrdersResponse
    expect(memberOrders.orders).toHaveLength(1)
    const memberGarage = (await (await authed(member, '/api/vehicles')).json()) as GarageResponse
    expect(memberGarage.vehicles).toHaveLength(1)

    const orgAfter = (await (await authed(member, '/api/org')).json()) as OrganizationResponse
    expect(orgAfter.organization.memberCount).toBe(2)

    // Настройки автосервиса меняет только владелец.
    expect((await authed(member, '/api/org', { defaultMarkupBps: 1000 })).status).toBe(403)
    expect((await authed(owner, '/api/org', { defaultMarkupBps: 1000 })).status).toBe(200)

    // Неверный код приглашения при регистрации отклоняется.
    const bad = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com', password: 'password123', inviteCode: 'NOPE1234' }),
    })
    expect(bad.status).toBe(400)
  })

  test('наценка: цена для клиента считается от закупа, правится вручную и даёт маржу', async () => {
    const token = await registerUser('markup@example.com')
    await authed(token, '/api/org', { defaultMarkupBps: 2500 })

    const economy = await economyOffer()
    const added = (await (
      await authed(token, '/api/cart/items', {
        oemNumber: economy.oemNumber,
        offerId: economy.id,
        partName: 'Колодки',
        quantity: 2,
      })
    ).json()) as OrderResponse
    const item = added.order.items[0]!
    expect(item.price.amount).toBe(economy.price.amount)
    expect(item.markupBps).toBe(2500)
    expect(item.salePrice.amount).toBe(applyMarkup(economy.price.amount, 2500))
    expect(added.order.total.amount).toBe(economy.price.amount * 2)
    expect(added.order.saleTotal.amount).toBe(item.salePrice.amount * 2)
    expect(added.order.marginTotal.amount).toBe(
      added.order.saleTotal.amount - added.order.total.amount,
    )

    // Ручная цена для клиента: наценка позиции пересчитывается из факта.
    const manual = economy.price.amount * 2
    const priced = (await (
      await authed(token, '/api/cart/items/sale-price', { itemId: item.id, saleAmount: manual })
    ).json()) as OrderResponse
    expect(priced.order.items[0]?.salePrice.amount).toBe(manual)
    expect(priced.order.items[0]?.markupBps).toBe(10_000)

    // Заказ получает сквозной номер и сохраняет цены для клиента.
    const placed = (await (await post(token, '/api/cart/checkout')).json()) as OrderResponse
    expect(placed.order.number).toBeGreaterThan(0)
    expect(placed.order.saleTotal.amount).toBe(manual * 2)
  })

  test('клиенты автосервиса: карточка, авто с госномером и автопривязка к корзине', async () => {
    const token = await registerUser('customers@example.com')

    const created = (await (
      await authed(token, '/api/customers', { name: 'Иван Петров', phone: '+7 900 000-00-00' })
    ).json()) as CustomerResponse
    expect(created.customer.name).toBe('Иван Петров')

    // Госномер нормализуется (латиница → кириллица), клиент привязан.
    const vehicle = (await (
      await authed(token, '/api/vehicles', {
        vin: DEMO_VIN,
        plate: 'a123bc777',
        mileageKm: 145000,
        customerId: created.customer.id,
      })
    ).json()) as VehicleResponse
    expect(vehicle.vehicle.plate).toBe('А123ВС777')
    expect(vehicle.vehicle.mileageKm).toBe(145000)
    expect(vehicle.vehicle.customer?.id).toBe(created.customer.id)

    // Правка карточки: пробег обновлён, госномер очищен.
    const updated = (await (
      await authed(token, '/api/vehicles/update', {
        id: vehicle.vehicle.id,
        mileageKm: 150000,
        plate: null,
      })
    ).json()) as VehicleResponse
    expect(updated.vehicle.mileageKm).toBe(150000)
    expect(updated.vehicle.plate).toBeNull()

    // Привязка корзины к авто из гаража подставляет клиента.
    const cart = (await (
      await authed(token, '/api/cart/vehicle', { vin: DEMO_VIN })
    ).json()) as OrderResponse
    expect(cart.order.customer?.id).toBe(created.customer.id)

    // Чужого клиента привязать нельзя.
    expect(
      (await authed(token, '/api/cart/customer', { customerId: '00000000-0000-0000-0000-000000000000' })).status,
    ).toBe(404)

    // Список клиентов считает авто и заказы.
    const list = (await (await authed(token, '/api/customers')).json()) as {
      customers: { vehicleCount: number }[]
    }
    expect(list.customers[0]?.vehicleCount).toBe(1)
  })
})
