import { afterEach, describe, expect, test } from 'bun:test'

import { YooKassaPaymentProvider } from './yookassa-provider'

/**
 * Юнит-тесты боевого провайдера ЮKassa на мокнутом fetch — без сети и реальных
 * ключей. Проверяем именно то, что всплыло бы только на реальных деньгах:
 * формат суммы (копейки → рубли строкой), ключ идемпотентности, СБП, маппинг
 * статусов, тела запросов и обработку ошибок API.
 */

const realFetch = globalThis.fetch

type Captured = {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown> | undefined
}

function mockFetch(response: { status?: number; json?: unknown }): Captured[] {
  const calls: Captured[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    if (init?.headers) Object.assign(headers, init.headers as Record<string, string>)
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    })
    return new Response(JSON.stringify(response.json ?? {}), {
      status: response.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  return calls
}

const provider = new YooKassaPaymentProvider('shop_1', 'secret_1')

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('YooKassaPaymentProvider.createPayment', () => {
  test('формирует корректное тело платежа (копейки → рубли, идемпотентность, metadata)', async () => {
    const calls = mockFetch({
      json: { id: 'yk_1', status: 'pending', confirmation: { confirmation_url: 'https://pay/1' } },
    })
    const res = await provider.createPayment({
      paymentId: 'p1',
      amount: { amount: 150050, currency: 'RUB' },
      description: 'Оплата заказа o1',
      returnUrl: 'https://app/orders',
    })

    expect(res).toEqual({
      providerPaymentId: 'yk_1',
      status: 'PENDING',
      confirmationUrl: 'https://pay/1',
    })
    const call = calls[0]!
    expect(call.method).toBe('POST')
    expect(call.url).toContain('/payments')
    expect(call.headers['Idempotence-Key']).toBe('p1')
    expect(call.headers['Authorization']).toStartWith('Basic ')
    expect(call.body).toMatchObject({
      amount: { value: '1500.50', currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: 'https://app/orders' },
      metadata: { paymentId: 'p1' },
    })
    expect(call.body?.payment_method_data).toBeUndefined()
  })

  test('СБП добавляет payment_method_data', async () => {
    const calls = mockFetch({ json: { id: 'yk_2', status: 'pending' } })
    await provider.createPayment({
      paymentId: 'p2',
      amount: { amount: 10000, currency: 'RUB' },
      description: 'x',
      returnUrl: 'https://app/orders',
      method: 'sbp',
    })
    expect(calls[0]!.body?.payment_method_data).toEqual({ type: 'sbp' })
  })

  test('передаёт фискальный чек (receipt) в тело платежа', async () => {
    const calls = mockFetch({ json: { id: 'yk_r', status: 'pending' } })
    await provider.createPayment({
      paymentId: 'p_r',
      amount: { amount: 200000, currency: 'RUB' },
      description: 'x',
      returnUrl: 'https://app/orders',
      receipt: {
        customerEmail: 'buyer@example.com',
        items: [
          { description: 'Колодки', quantity: 2, amount: { amount: 100000, currency: 'RUB' }, vatCode: 4 },
        ],
      },
    })
    const receipt = calls[0]!.body!.receipt as {
      customer: Record<string, string>
      items: Record<string, unknown>[]
    }
    expect(receipt.customer).toEqual({ email: 'buyer@example.com' })
    expect(receipt.items).toHaveLength(1)
    expect(receipt.items[0]).toMatchObject({
      description: 'Колодки',
      quantity: '2',
      amount: { value: '1000.00', currency: 'RUB' },
      vat_code: 4,
      payment_subject: 'commodity',
      payment_mode: 'full_payment',
    })
  })

  test('без receipt тело не содержит чек', async () => {
    const calls = mockFetch({ json: { id: 'yk_n', status: 'pending' } })
    await provider.createPayment({
      paymentId: 'p_n',
      amount: { amount: 100, currency: 'RUB' },
      description: 'x',
      returnUrl: 'https://app/orders',
    })
    expect(calls[0]!.body?.receipt).toBeUndefined()
  })

  test('ошибка API приводит к исключению', async () => {
    mockFetch({ status: 500 })
    await expect(
      provider.createPayment({
        paymentId: 'p3',
        amount: { amount: 100, currency: 'RUB' },
        description: 'x',
        returnUrl: 'https://app/orders',
      }),
    ).rejects.toThrow()
  })
})

describe('YooKassaPaymentProvider — статусы и возвраты', () => {
  test('маппинг статусов платежа', async () => {
    for (const [raw, mapped] of [
      ['succeeded', 'SUCCEEDED'],
      ['canceled', 'CANCELED'],
      ['pending', 'PENDING'],
      ['waiting_for_capture', 'PENDING'],
    ] as const) {
      mockFetch({ json: { id: 'yk', status: raw } })
      expect(await provider.getStatus('yk')).toBe(mapped)
    }
  })

  test('refund шлёт payment_id и сумму, ключ идемпотентности — refundId', async () => {
    const calls = mockFetch({ json: { id: 'rf_1', status: 'succeeded' } })
    const res = await provider.refund({
      refundId: 'r1',
      providerPaymentId: 'yk_1',
      amount: { amount: 150050, currency: 'RUB' },
    })
    expect(res).toEqual({ providerRefundId: 'rf_1', status: 'SUCCEEDED' })
    const call = calls[0]!
    expect(call.url).toContain('/refunds')
    expect(call.headers['Idempotence-Key']).toBe('r1')
    expect(call.body).toEqual({
      payment_id: 'yk_1',
      amount: { value: '1500.50', currency: 'RUB' },
    })
  })

  test('getRefundStatus запрашивает статус возврата по id', async () => {
    const calls = mockFetch({ json: { id: 'rf_1', status: 'succeeded' } })
    expect(await provider.getRefundStatus('rf_1')).toBe('SUCCEEDED')
    expect(calls[0]!.url).toContain('/refunds/rf_1')
  })
})

describe('YooKassaPaymentProvider.parseWebhook', () => {
  test('различает события оплаты и возврата', () => {
    expect(
      provider.parseWebhook({
        event: 'payment.succeeded',
        object: { id: 'yk_1', status: 'succeeded' },
      }),
    ).toEqual({ kind: 'payment', providerPaymentId: 'yk_1', status: 'SUCCEEDED' })

    expect(
      provider.parseWebhook({
        event: 'refund.succeeded',
        object: { id: 'rf_1', status: 'succeeded' },
      }),
    ).toEqual({ kind: 'refund', providerRefundId: 'rf_1', status: 'SUCCEEDED' })
  })

  test('игнорирует посторонние и неполные события', () => {
    expect(
      provider.parseWebhook({ event: 'payout.succeeded', object: { id: 'x', status: 'succeeded' } }),
    ).toBeNull()
    expect(provider.parseWebhook({ object: { id: 'x', status: 'succeeded' } })).toBeNull()
    expect(provider.parseWebhook({ event: 'payment.succeeded', object: { id: 'x' } })).toBeNull()
    expect(provider.parseWebhook(null)).toBeNull()
  })
})
