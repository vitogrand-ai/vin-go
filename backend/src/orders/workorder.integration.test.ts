import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type {
  OffersResponse,
  OrderResponse,
  OrdersResponse,
  OrganizationResponse,
} from '@web-app-demo/contracts'

import { createApp } from '../app'
import { createPrisma } from '../db'
import type { AppEnv } from '../env'

const databaseUrl = process.env.TEST_DATABASE_URL
const maybeDescribe = databaseUrl ? describe : describe.skip

const DEMO_VIN = 'WVWZZZ1JZ3W386752'

/**
 * Заказ-наряд (ПП РФ № 780): работы рядом с запчастями, данные приёма машины,
 * реквизиты исполнителя. Проверяется через реальные роуты и базу, потому что
 * суть — в итогах и в том, что попадает в печатный документ.
 */
maybeDescribe('заказ-наряд: работы, приём машины, реквизиты', () => {
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
    await prisma.orderWork.deleteMany()
    await prisma.orderItem.deleteMany()
    await prisma.order.deleteMany()
    await prisma.vehicle.deleteMany()
    await prisma.customer.deleteMany()
    await prisma.authSession.deleteMany()
    await prisma.user.deleteMany()
    await prisma.organization.deleteMany()
  }

  async function registerUser(email = 'master@example.com'): Promise<string> {
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Platform': 'mobile' },
      body: JSON.stringify({ email, password: 'password123', displayName: 'Иван Приёмщик' }),
    })
    const data = (await res.json()) as { accessToken: string }
    return data.accessToken
  }

  function authed(
    token: string,
    path: string,
    body?: unknown,
    method: 'GET' | 'POST' = body === undefined ? 'GET' : 'POST',
  ) {
    return app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  /** Корзина с одной запчастью, привязанная к машине из гаража. */
  async function cartWithPart(token: string): Promise<OrderResponse> {
    await authed(token, '/api/vehicles', { vin: DEMO_VIN, plate: 'А123ВС777', mileageKm: 120_000 })
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
      partName: 'Колодки тормозные передние',
    })
    return (await (await authed(token, '/api/cart/vehicle', { vin: DEMO_VIN })).json()) as OrderResponse
  }

  beforeEach(reset)
  afterAll(reset)

  test('привязка машины из гаража подставляет госномер и пробег в приём', async () => {
    const token = await registerUser()
    const { order } = await cartWithPart(token)

    expect(order.reception.plate).toBe('А123ВС777')
    expect(order.reception.mileageKm).toBe(120_000)
    expect(order.vehicle?.make).toBe('Volkswagen')
    expect(order.acceptedBy).toBe('Иван Приёмщик')
  })

  test('работы складываются в итог клиенту вместе с запчастями', async () => {
    const token = await registerUser()
    const { order } = await cartWithPart(token)

    const withWork = (await (
      await authed(token, '/api/orders/works', {
        orderId: order.id,
        name: 'Замена колодок',
        amount: 250_000,
        quantity: 2,
      })
    ).json()) as OrderResponse
    expect(withWork.order.works).toHaveLength(1)
    expect(withWork.order.works[0]?.lineTotal.amount).toBe(500_000)
    expect(withWork.order.worksTotal.amount).toBe(500_000)
    expect(withWork.order.grandTotal.amount).toBe(withWork.order.saleTotal.amount + 500_000)

    // Работа снимается, итог возвращается к запчастям.
    const removed = (await (
      await authed(token, '/api/orders/works/remove', {
        orderId: order.id,
        workId: withWork.order.works[0]!.id,
      })
    ).json()) as OrderResponse
    expect(removed.order.works).toHaveLength(0)
    expect(removed.order.grandTotal.amount).toBe(removed.order.saleTotal.amount)

    // Чужую работу удалить нельзя — 404, не молчаливый успех.
    const missing = await authed(token, '/api/orders/works/remove', {
      orderId: order.id,
      workId: '0192abcd-0000-7000-8000-000000000000',
    })
    expect(missing.status).toBe(404)
  })

  test('данные приёма сохраняются, null очищает, госномер нормализуется', async () => {
    const token = await registerUser()
    const { order } = await cartWithPart(token)

    const updated = (await (
      await authed(token, '/api/orders/reception', {
        orderId: order.id,
        dueAt: '2026-09-20T15:00:00.000Z',
        complaint: 'Скрип при торможении',
        conditionNotes: 'Царапина на заднем бампере',
        plate: 'o777oo77',
        mileageKm: 121_500,
      })
    ).json()) as OrderResponse
    expect(updated.order.reception).toEqual({
      dueAt: '2026-09-20T15:00:00.000Z',
      complaint: 'Скрип при торможении',
      conditionNotes: 'Царапина на заднем бампере',
      plate: 'О777ОО77',
      mileageKm: 121_500,
    })

    const cleared = (await (
      await authed(token, '/api/orders/reception', { orderId: order.id, dueAt: null, complaint: null })
    ).json()) as OrderResponse
    expect(cleared.order.reception.dueAt).toBeNull()
    expect(cleared.order.reception.complaint).toBeNull()
    // Что не прислали — не тронуто.
    expect(cleared.order.reception.conditionNotes).toBe('Царапина на заднем бампере')
  })

  test('работы и приём переживают оформление и видны в списке заказов', async () => {
    const token = await registerUser()
    const { order } = await cartWithPart(token)
    await authed(token, '/api/orders/works', { orderId: order.id, name: 'Диагностика', amount: 150_000 })

    const checkout = (await (
      await authed(token, '/api/cart/checkout', undefined, 'POST')
    ).json()) as OrderResponse
    expect(checkout.order.works).toHaveLength(1)
    expect(checkout.order.reception.plate).toBe('А123ВС777')

    const list = (await (await authed(token, '/api/orders')).json()) as OrdersResponse
    expect(list.orders[0]?.worksTotal.amount).toBe(150_000)
    expect(list.orders[0]?.vehicle?.model).toContain('Golf')
  })

  test('выданный заказ не правится', async () => {
    const token = await registerUser()
    const { order } = await cartWithPart(token)
    await prisma.order.update({ where: { id: order.id }, data: { status: 'COMPLETED', draftKey: null } })

    const res = await authed(token, '/api/orders/works', { orderId: order.id, name: 'Поздно', amount: 1 })
    expect(res.status).toBe(400)
  })

  test('другой автосервис заказ не видит и работу в него не добавит', async () => {
    const token = await registerUser()
    const { order } = await cartWithPart(token)
    const stranger = await registerUser('other@example.com')

    const res = await authed(stranger, '/api/orders/works', { orderId: order.id, name: 'Чужая', amount: 1 })
    expect(res.status).toBe(404)
  })

  test('реквизиты исполнителя сохраняются владельцем и валидируются', async () => {
    const token = await registerUser()

    const saved = (await (
      await authed(token, '/api/org', {
        legalName: 'ИП Иванов И.И.',
        inn: '500100732259',
        ogrn: '304500116000157',
        address: 'г. Москва, ул. Автосервисная, 1',
        warrantyText: 'Гарантия на работы 30 дней',
      })
    ).json()) as OrganizationResponse
    expect(saved.organization.inn).toBe('500100732259')
    expect(saved.organization.legalName).toBe('ИП Иванов И.И.')

    const bad = await authed(token, '/api/org', { inn: '12' })
    expect(bad.status).toBe(400)

    const cleared = (await (await authed(token, '/api/org', { ogrn: null })).json()) as OrganizationResponse
    expect(cleared.organization.ogrn).toBeNull()
    expect(cleared.organization.inn).toBe('500100732259')
  })
})
