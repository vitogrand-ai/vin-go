import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type {
  CreatePaymentResponse,
  OffersResponse,
  OrderResponse,
  OrdersResponse,
  RefundResponse,
} from '@web-app-demo/contracts'

import { createApp } from '../app'
import { createPrisma } from '../db'
import type { AppEnv } from '../env'
import type { PaymentProvider } from './providers'
import { PaymentService } from './service'

const databaseUrl = process.env.TEST_DATABASE_URL
const maybeDescribe = databaseUrl ? describe : describe.skip

maybeDescribe('оплата заказа (мок-провайдер)', () => {
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
    await prisma.payment.deleteMany()
    await prisma.orderItem.deleteMany()
    await prisma.order.deleteMany()
    await prisma.authSession.deleteMany()
    await prisma.user.deleteMany()
  }

  function authed(token: string, path: string, body?: unknown, method: 'GET' | 'POST' = body === undefined ? 'GET' : 'POST') {
    return app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  async function setupPaidableOrder(): Promise<{ token: string; orderId: string }> {
    const reg = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Platform': 'mobile' },
      body: JSON.stringify({ email: 'pay@example.com', password: 'password123' }),
    })
    const token = ((await reg.json()) as { accessToken: string }).accessToken

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
    return { token, orderId: checkout.order.id }
  }

  beforeEach(reset)
  afterAll(reset)

  test('полный цикл: создание платежа → подтверждение → заказ оплачен', async () => {
    const { token, orderId } = await setupPaidableOrder()

    const created = (await (
      await authed(token, '/api/payments/create', { orderId })
    ).json()) as CreatePaymentResponse
    expect(created.payment.status).toBe('PENDING')
    expect(created.payment.confirmationUrl).toContain('/pay?paymentId=')
    expect(created.payment.amount.amount).toBeGreaterThan(0)

    const confirmed = (await (
      await authed(token, '/api/payments/mock/confirm', { paymentId: created.payment.id })
    ).json()) as CreatePaymentResponse
    expect(confirmed.payment.status).toBe('SUCCEEDED')
    expect(confirmed.payment.paidAt).not.toBeNull()

    const orders = (await (await authed(token, '/api/orders')).json()) as OrdersResponse
    expect(orders.orders[0]?.paymentStatus).toBe('SUCCEEDED')
    // Успешная оплата автоматически перевела заказ PLACED → PAID.
    expect(orders.orders[0]?.status).toBe('PAID')
  })

  test('оператор ведёт жизненный цикл: PAID → PROCESSING → READY → COMPLETED', async () => {
    const { token, orderId } = await setupPaidableOrder()
    const created = (await (
      await authed(token, '/api/payments/create', { orderId })
    ).json()) as CreatePaymentResponse
    await authed(token, '/api/payments/mock/confirm', { paymentId: created.payment.id })

    // Операторские переходы доступны только роли OPERATOR.
    await prisma.user.update({ where: { email: 'pay@example.com' }, data: { role: 'OPERATOR' } })

    for (const status of ['PROCESSING', 'READY', 'COMPLETED'] as const) {
      const res = (await (
        await authed(token, '/api/orders/status', { orderId, status })
      ).json()) as OrderResponse
      expect(res.order.status).toBe(status)
    }
  })

  test('клиент не может провести операторский переход PAID → PROCESSING (400)', async () => {
    const { token, orderId } = await setupPaidableOrder()
    await payOrder(token, orderId)
    // Пользователь остаётся клиентом (USER) — операторский переход запрещён.
    const res = await authed(token, '/api/orders/status', { orderId, status: 'PROCESSING' })
    expect(res.status).toBe(400)
  })

  async function payOrder(token: string, orderId: string): Promise<void> {
    const created = (await (
      await authed(token, '/api/payments/create', { orderId })
    ).json()) as CreatePaymentResponse
    await authed(token, '/api/payments/mock/confirm', { paymentId: created.payment.id })
  }

  test('возврат оплаченного заказа переводит его в REFUNDED', async () => {
    const { token, orderId } = await setupPaidableOrder()
    await payOrder(token, orderId)

    const refunded = (await (
      await authed(token, '/api/payments/refund', { orderId })
    ).json()) as RefundResponse
    expect(refunded.refund.status).toBe('SUCCEEDED')
    expect(refunded.refund.amount.amount).toBeGreaterThan(0)

    const orders = (await (await authed(token, '/api/orders')).json()) as OrdersResponse
    expect(orders.orders[0]?.status).toBe('REFUNDED')
  })

  test('нельзя вернуть неоплаченный заказ (400)', async () => {
    const { token, orderId } = await setupPaidableOrder()
    const res = await authed(token, '/api/payments/refund', { orderId })
    expect(res.status).toBe(400)
  })

  test('повторный возврат запрещён (409)', async () => {
    const { token, orderId } = await setupPaidableOrder()
    await payOrder(token, orderId)
    await authed(token, '/api/payments/refund', { orderId })
    const again = await authed(token, '/api/payments/refund', { orderId })
    expect(again.status).toBe(409)
  })

  test('оплата способом СБП создаётся', async () => {
    const { token, orderId } = await setupPaidableOrder()
    const res = await authed(token, '/api/payments/create', { orderId, method: 'sbp' })
    expect(res.status).toBe(200)
  })

  test('недопустимый переход статуса отклоняется (400)', async () => {
    const { token, orderId } = await setupPaidableOrder()
    // Из PLACED нельзя сразу в COMPLETED.
    const res = await authed(token, '/api/orders/status', { orderId, status: 'COMPLETED' })
    expect(res.status).toBe(400)
  })

  test('заказ можно отменить из PLACED', async () => {
    const { token, orderId } = await setupPaidableOrder()
    const res = (await (
      await authed(token, '/api/orders/status', { orderId, status: 'CANCELLED' })
    ).json()) as OrderResponse
    expect(res.order.status).toBe('CANCELLED')
  })

  test('повторное создание платежа возвращает тот же PENDING (идемпотентность)', async () => {
    const { token, orderId } = await setupPaidableOrder()
    const first = (await (
      await authed(token, '/api/payments/create', { orderId })
    ).json()) as CreatePaymentResponse
    const second = (await (
      await authed(token, '/api/payments/create', { orderId })
    ).json()) as CreatePaymentResponse
    expect(second.payment.id).toBe(first.payment.id)
  })

  test('оплаченный заказ нельзя оплатить повторно (409)', async () => {
    const { token, orderId } = await setupPaidableOrder()
    const created = (await (
      await authed(token, '/api/payments/create', { orderId })
    ).json()) as CreatePaymentResponse
    await authed(token, '/api/payments/mock/confirm', { paymentId: created.payment.id })

    const again = await authed(token, '/api/payments/create', { orderId })
    expect(again.status).toBe(409)
  })

  test('нельзя оплатить чужой/несуществующий заказ (404)', async () => {
    const { token } = await setupPaidableOrder()
    const res = await authed(token, '/api/payments/create', {
      orderId: '00000000-0000-0000-0000-000000000000',
    })
    expect(res.status).toBe(404)
  })

  test('reconcile продвигает зависший PENDING-платёж по статусу провайдера', async () => {
    const { orderId } = await setupPaidableOrder()
    const order = await prisma.order.findFirstOrThrow({ where: { id: orderId } })
    // Платёж «завис» в PENDING (webhook потерян), создан 10 минут назад.
    const past = new Date(Date.now() - 10 * 60 * 1000)
    await prisma.payment.create({
      data: {
        orderId,
        userId: order.userId,
        provider: 'yookassa',
        status: 'PENDING',
        providerPaymentId: 'yk_stuck',
        amount: 1000,
        currency: 'RUB',
        createdAt: past,
      },
    })

    // Провайдер сообщает, что платёж на самом деле успешен.
    const succeedingProvider: PaymentProvider = {
      name: 'stub',
      supportsMockConfirm: false,
      createPayment: async () => {
        throw new Error('не используется')
      },
      getStatus: async () => 'SUCCEEDED',
      getRefundStatus: async () => 'SUCCEEDED',
      refund: async () => {
        throw new Error('не используется')
      },
      parseWebhook: () => null,
    }
    const service = new PaymentService(prisma, succeedingProvider, {
      webappOrigin: 'http://localhost:5173',
      returnUrl: 'http://localhost:5173/orders',
    })

    const result = await service.reconcilePending()
    expect(result.payments).toBeGreaterThanOrEqual(1)

    const paid = await prisma.order.findFirstOrThrow({ where: { id: orderId } })
    expect(paid.status).toBe('PAID')
    const payment = await prisma.payment.findFirstOrThrow({
      where: { providerPaymentId: 'yk_stuck' },
    })
    expect(payment.status).toBe('SUCCEEDED')
  })

  test('создание платежа требует авторизации (401)', async () => {
    const res = await app.request('/api/payments/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: '00000000-0000-0000-0000-000000000000' }),
    })
    expect(res.status).toBe(401)
  })
})
