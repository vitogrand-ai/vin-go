import type { PaymentStatus } from '@web-app-demo/contracts'

import type {
  CreatePaymentParams,
  ParsedWebhookEvent,
  PaymentProvider,
  ProviderPayment,
  ProviderRefund,
  RefundParams,
} from './providers'

const YOOKASSA_API = 'https://api.yookassa.ru/v3'

/** Сопоставление статусов ЮKassa с нашими. */
function mapStatus(raw: string): PaymentStatus {
  switch (raw) {
    case 'succeeded':
      return 'SUCCEEDED'
    case 'canceled':
      return 'CANCELED'
    default:
      // pending, waiting_for_capture
      return 'PENDING'
  }
}

type YooKassaPayment = {
  id: string
  status: string
  confirmation?: { confirmation_url?: string }
}

/**
 * Боевой провайдер ЮKassa (REST API v3). Активируется при заданных
 * YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY. Не покрывается тестами (нужны реальные
 * ключи); в тестах и без ключей используется MockPaymentProvider.
 */
export class YooKassaPaymentProvider implements PaymentProvider {
  readonly name = 'yookassa'
  readonly supportsMockConfirm = false

  constructor(
    private readonly shopId: string,
    private readonly secretKey: string,
  ) {}

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.shopId}:${this.secretKey}`).toString('base64')}`
  }

  async createPayment(params: CreatePaymentParams): Promise<ProviderPayment> {
    const body: Record<string, unknown> = {
      amount: {
        value: (params.amount.amount / 100).toFixed(2),
        currency: params.amount.currency,
      },
      capture: true,
      confirmation: { type: 'redirect', return_url: params.returnUrl },
      description: params.description,
      metadata: { paymentId: params.paymentId },
    }
    // СБП как способ оплаты.
    if (params.method === 'sbp') {
      body.payment_method_data = { type: 'sbp' }
    }
    // Фискализация (54-ФЗ): при подключённой кассе/ОФД добавьте сюда объект
    // `receipt` (позиции заказа, ставки НДС, контакт клиента). Требует
    // настройки в ЛК ЮKassa и реальных данных, поэтому оставлено точкой расширения.

    const response = await fetch(`${YOOKASSA_API}/payments`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Idempotence-Key': params.paymentId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new Error(`ЮKassa: создание платежа не удалось (${response.status})`)
    }

    const data = (await response.json()) as YooKassaPayment
    return {
      providerPaymentId: data.id,
      status: mapStatus(data.status),
      confirmationUrl: data.confirmation?.confirmation_url ?? null,
    }
  }

  async refund(params: RefundParams): Promise<ProviderRefund> {
    const response = await fetch(`${YOOKASSA_API}/refunds`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Idempotence-Key': params.refundId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        payment_id: params.providerPaymentId,
        amount: {
          value: (params.amount.amount / 100).toFixed(2),
          currency: params.amount.currency,
        },
      }),
    })

    if (!response.ok) {
      throw new Error(`ЮKassa: возврат не удался (${response.status})`)
    }

    const data = (await response.json()) as { id: string; status: string }
    return { providerRefundId: data.id, status: mapStatus(data.status) }
  }

  async getStatus(providerPaymentId: string): Promise<PaymentStatus> {
    const response = await fetch(`${YOOKASSA_API}/payments/${providerPaymentId}`, {
      headers: { Authorization: this.authHeader() },
    })
    if (!response.ok) {
      throw new Error(`ЮKassa: получение статуса не удалось (${response.status})`)
    }
    const data = (await response.json()) as YooKassaPayment
    return mapStatus(data.status)
  }

  async getRefundStatus(providerRefundId: string): Promise<PaymentStatus> {
    const response = await fetch(`${YOOKASSA_API}/refunds/${providerRefundId}`, {
      headers: { Authorization: this.authHeader() },
    })
    if (!response.ok) {
      throw new Error(`ЮKassa: получение статуса возврата не удалось (${response.status})`)
    }
    const data = (await response.json()) as { status: string }
    return mapStatus(data.status)
  }

  parseWebhook(body: unknown): ParsedWebhookEvent | null {
    if (!body || typeof body !== 'object') return null
    const event = body as { event?: string; object?: { id?: string; status?: string } }
    const id = event.object?.id
    const status = event.object?.status
    if (!id || !status || typeof event.event !== 'string') return null
    // event: 'payment.succeeded' | 'payment.canceled' | 'refund.succeeded' и т.п.
    if (event.event.startsWith('payment.')) {
      return { kind: 'payment', providerPaymentId: id, status: mapStatus(status) }
    }
    if (event.event.startsWith('refund.')) {
      return { kind: 'refund', providerRefundId: id, status: mapStatus(status) }
    }
    return null
  }
}
