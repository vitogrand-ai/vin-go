import { beforeEach, describe, expect, test } from 'bun:test'
import type { PaymentStatus } from '@web-app-demo/contracts'

import type { DbClient } from '../db'
import type { ParsedWebhookEvent, PaymentProvider } from './providers'
import { PaymentService } from './service'

/**
 * Юнит-тесты обработки webhook: главное — телу webhook не доверяем, статус
 * берём только из API провайдера, а при неудачной верификации падаем (5xx →
 * ретрай провайдера), не проводя платёж. Мок-провайдер эти пути не покрывает
 * (parseWebhook → null), поэтому используем управляемый фейк-провайдер и
 * in-memory фейк БД — так проверяем именно логику PaymentService.
 */

type PaymentRow = {
  id: string
  orderId: string
  providerPaymentId: string
  status: PaymentStatus
  paidAt: Date | null
}
type OrderRow = { id: string; status: string }
type RefundRow = {
  id: string
  orderId: string
  providerRefundId: string
  status: PaymentStatus
}

function makeFakeDb(seed: { payments?: PaymentRow[]; orders?: OrderRow[]; refunds?: RefundRow[] }) {
  const payments = seed.payments ?? []
  const orders = seed.orders ?? []
  const refunds = seed.refunds ?? []
  const db = {
    payment: {
      findFirst: async ({ where }: { where: { providerPaymentId: string } }) =>
        payments.find((p) => p.providerPaymentId === where.providerPaymentId) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<PaymentRow> }) => {
        const row = payments.find((p) => p.id === where.id)!
        Object.assign(row, data)
        return row
      },
    },
    order: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status?: string }
        data: Partial<OrderRow>
      }) => {
        let count = 0
        for (const o of orders) {
          if (o.id !== where.id) continue
          if (where.status !== undefined && o.status !== where.status) continue
          Object.assign(o, data)
          count += 1
        }
        return { count }
      },
    },
    refund: {
      findFirst: async ({ where }: { where: { providerRefundId: string } }) =>
        refunds.find((r) => r.providerRefundId === where.providerRefundId) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<RefundRow> }) => {
        const row = refunds.find((r) => r.id === where.id)!
        Object.assign(row, data)
        return row
      },
    },
  }
  return { db: db as unknown as DbClient, payments, orders, refunds }
}

function makeProvider(overrides: Partial<PaymentProvider>): PaymentProvider {
  return {
    name: 'fake',
    supportsMockConfirm: false,
    createPayment: async () => {
      throw new Error('не используется')
    },
    getStatus: async () => 'PENDING',
    getRefundStatus: async () => 'PENDING',
    refund: async () => {
      throw new Error('не используется')
    },
    parseWebhook: () => null,
    ...overrides,
  }
}

const config = { webappOrigin: 'http://localhost:5173', returnUrl: 'http://localhost:5173/orders' }

const paymentEvent = (status: PaymentStatus): ParsedWebhookEvent => ({
  kind: 'payment',
  providerPaymentId: 'yk_1',
  status,
})

describe('PaymentService.handleWebhook — безопасность', () => {
  let store: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    store = makeFakeDb({
      payments: [
        { id: 'p1', orderId: 'o1', providerPaymentId: 'yk_1', status: 'PENDING', paidAt: null },
      ],
      orders: [{ id: 'o1', status: 'PLACED' }],
    })
  })

  test('не проводит платёж, если верификация статуса недоступна (не доверяем телу webhook)', async () => {
    const provider = makeProvider({
      // Тело webhook утверждает «оплачено»…
      parseWebhook: () => paymentEvent('SUCCEEDED'),
      // …но API провайдера недоступен — верификация невозможна.
      getStatus: async () => {
        throw new Error('API ЮKassa недоступен')
      },
    })
    const service = new PaymentService(store.db, provider, config)

    // Пробрасываем ошибку → маршрут вернёт 5xx, ЮKassa повторит доставку.
    await expect(service.handleWebhook({ event: 'payment.succeeded' })).rejects.toThrow()
    // Платёж и заказ НЕ изменились.
    expect(store.payments[0]!.status).toBe('PENDING')
    expect(store.orders[0]!.status).toBe('PLACED')
  })

  test('статус берётся из API провайдера, а не из тела webhook', async () => {
    const provider = makeProvider({
      // Тело лжёт, что оплачено…
      parseWebhook: () => paymentEvent('SUCCEEDED'),
      // …а API говорит, что всё ещё PENDING.
      getStatus: async () => 'PENDING',
    })
    const service = new PaymentService(store.db, provider, config)

    await service.handleWebhook({ event: 'payment.succeeded' })
    expect(store.payments[0]!.status).toBe('PENDING')
    expect(store.orders[0]!.status).toBe('PLACED')
  })

  test('подтверждённая провайдером оплата проводит платёж и двигает заказ в PAID', async () => {
    const provider = makeProvider({
      parseWebhook: () => paymentEvent('SUCCEEDED'),
      getStatus: async () => 'SUCCEEDED',
    })
    const service = new PaymentService(store.db, provider, config)

    await service.handleWebhook({ event: 'payment.succeeded' })
    expect(store.payments[0]!.status).toBe('SUCCEEDED')
    expect(store.payments[0]!.paidAt).not.toBeNull()
    expect(store.orders[0]!.status).toBe('PAID')
  })

  test('событие не про оплату/возврат игнорируется без обращения к API', async () => {
    let getStatusCalls = 0
    const provider = makeProvider({
      parseWebhook: () => null,
      getStatus: async () => {
        getStatusCalls += 1
        return 'SUCCEEDED'
      },
    })
    const service = new PaymentService(store.db, provider, config)

    await service.handleWebhook({ event: 'payout.succeeded' })
    expect(getStatusCalls).toBe(0)
    expect(store.orders[0]!.status).toBe('PLACED')
  })
})

describe('PaymentService.handleWebhook — возвраты', () => {
  test('refund.succeeded (подтверждён API) переводит заказ в REFUNDED', async () => {
    const store = makeFakeDb({
      orders: [{ id: 'o1', status: 'PAID' }],
      refunds: [{ id: 'r1', orderId: 'o1', providerRefundId: 'rf_1', status: 'PENDING' }],
    })
    const provider = makeProvider({
      parseWebhook: () => ({ kind: 'refund', providerRefundId: 'rf_1', status: 'SUCCEEDED' }),
      getRefundStatus: async () => 'SUCCEEDED',
    })
    const service = new PaymentService(store.db, provider, config)

    await service.handleWebhook({ event: 'refund.succeeded' })
    expect(store.refunds[0]!.status).toBe('SUCCEEDED')
    expect(store.orders[0]!.status).toBe('REFUNDED')
  })

  test('незавершённый возврат (API вернул PENDING) не трогает статус заказа', async () => {
    const store = makeFakeDb({
      orders: [{ id: 'o1', status: 'PAID' }],
      refunds: [{ id: 'r1', orderId: 'o1', providerRefundId: 'rf_1', status: 'PENDING' }],
    })
    const provider = makeProvider({
      parseWebhook: () => ({ kind: 'refund', providerRefundId: 'rf_1', status: 'PENDING' }),
      getRefundStatus: async () => 'PENDING',
    })
    const service = new PaymentService(store.db, provider, config)

    await service.handleWebhook({ event: 'refund.succeeded' })
    expect(store.orders[0]!.status).toBe('PAID')
  })
})
