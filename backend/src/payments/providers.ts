import type { Money, PaymentMethod, PaymentStatus } from '@web-app-demo/contracts'

export type CreatePaymentParams = {
  /** Наш внутренний id платежа — используется как ключ идемпотентности. */
  paymentId: string
  amount: Money
  description: string
  /** Куда вернуть пользователя после оплаты. */
  returnUrl: string
  /** Способ оплаты (карта / СБП). */
  method?: PaymentMethod
}

export type ProviderPayment = {
  providerPaymentId: string
  status: PaymentStatus
  /** URL формы оплаты; null — если провайдер не отдаёт её (мок). */
  confirmationUrl: string | null
}

export type RefundParams = {
  /** Внутренний id возврата — ключ идемпотентности. */
  refundId: string
  providerPaymentId: string
  amount: Money
}

export type ProviderRefund = {
  providerRefundId: string
  status: PaymentStatus
}

/**
 * Платёжный провайдер. Сейчас есть мок (Этап 3) и ядро ЮKassa, которое
 * активируется при заданных YOOKASSA_*. Маршруты и сервис от провайдера не зависят.
 */
export interface PaymentProvider {
  readonly name: string
  /** Поддерживает ли ручное подтверждение оплаты (только мок, для разработки). */
  readonly supportsMockConfirm: boolean
  createPayment(params: CreatePaymentParams): Promise<ProviderPayment>
  getStatus(providerPaymentId: string): Promise<PaymentStatus>
  refund(params: RefundParams): Promise<ProviderRefund>
  /** Разбирает webhook провайдера; null — если событие не про оплату. */
  parseWebhook(body: unknown): { providerPaymentId: string; status: PaymentStatus } | null
}

/**
 * Мок-провайдер: платёж создаётся в статусе PENDING без внешнего вызова.
 * Подтверждение — через эндпоинт /mock/confirm (имитация webhook).
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock'
  readonly supportsMockConfirm = true

  async createPayment(params: CreatePaymentParams): Promise<ProviderPayment> {
    return {
      providerPaymentId: `mock_${params.paymentId}`,
      status: 'PENDING',
      // URL формы строит сервис (страница /pay вебаппа) — провайдер её не знает.
      confirmationUrl: null,
    }
  }

  async getStatus(): Promise<PaymentStatus> {
    return 'PENDING'
  }

  async refund(params: RefundParams): Promise<ProviderRefund> {
    // Мок: возврат сразу успешен.
    return { providerRefundId: `mock_refund_${params.refundId}`, status: 'SUCCEEDED' }
  }

  parseWebhook(): { providerPaymentId: string; status: PaymentStatus } | null {
    return null
  }
}
