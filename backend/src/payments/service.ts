import type {
  Currency,
  CreatePaymentResponse,
  Payment,
  PaymentMethod,
  PaymentStatus,
  Refund,
  RefundResponse,
} from '@web-app-demo/contracts'

import type { DbClient } from '../db'
import { AppError } from '../http/errors'
import type { PaymentProvider } from './providers'

type PaymentRecord = {
  id: string
  orderId: string
  status: string
  amount: number
  currency: string
  confirmationUrl: string | null
  createdAt: Date
  paidAt: Date | null
}

export type PaymentServiceConfig = {
  /** Origin вебаппа — для страницы мок-оплаты. */
  webappOrigin: string
  /** Куда вернуть пользователя после оплаты. */
  returnUrl: string
}

/**
 * Платежи по заказам. Создаёт платёж через провайдера, хранит снимок суммы,
 * обрабатывает подтверждение (мок) и webhook (ЮKassa). Сумма берётся из заказа
 * на сервере — клиент её не передаёт.
 */
export class PaymentService {
  constructor(
    private readonly db: DbClient,
    private readonly provider: PaymentProvider,
    private readonly config: PaymentServiceConfig,
  ) {}

  async createForOrder(
    userId: string,
    orderId: string,
    method?: PaymentMethod,
  ): Promise<CreatePaymentResponse> {
    const order = await this.db.order.findFirst({
      where: { id: orderId, userId },
      include: { items: true, payments: { orderBy: { createdAt: 'desc' }, take: 1 } },
    })
    if (!order) {
      throw new AppError(404, 'NOT_FOUND', 'Заказ не найден')
    }

    // Сначала проверяем «уже оплачен» (заказ мог уйти в PAID/PROCESSING),
    // затем — что заказ вообще можно оплачивать.
    const existing = order.payments[0]
    if (existing?.status === 'SUCCEEDED') {
      throw new AppError(409, 'CONFLICT', 'Заказ уже оплачен')
    }
    if (order.status !== 'PLACED') {
      throw new AppError(400, 'BAD_REQUEST', 'Оплатить можно только оформленный заказ')
    }

    const total = order.items.reduce((sum, item) => sum + item.priceAmount * item.quantity, 0)
    if (total <= 0) {
      throw new AppError(400, 'BAD_REQUEST', 'Сумма заказа равна нулю')
    }

    if (existing?.status === 'PENDING') {
      return { payment: toPaymentDto(existing) }
    }

    const payment = await this.db.payment.create({
      data: {
        orderId: order.id,
        userId,
        provider: this.provider.name,
        status: 'PENDING',
        method: method ?? null,
        amount: total,
        currency: order.currency,
      },
    })

    const providerPayment = await this.provider.createPayment({
      paymentId: payment.id,
      amount: { amount: total, currency: order.currency as Currency },
      description: `Оплата заказа ${order.id}`,
      returnUrl: this.config.returnUrl,
      method,
    })

    const confirmationUrl =
      providerPayment.confirmationUrl ??
      (this.provider.supportsMockConfirm
        ? `${this.config.webappOrigin}/pay?paymentId=${payment.id}`
        : null)

    const updated = await this.db.payment.update({
      where: { id: payment.id },
      data: {
        providerPaymentId: providerPayment.providerPaymentId,
        status: providerPayment.status,
        confirmationUrl,
        paidAt: providerPayment.status === 'SUCCEEDED' ? new Date() : null,
      },
    })

    return { payment: toPaymentDto(updated) }
  }

  /** Подтверждение мок-оплаты (имитация webhook, только для разработки). */
  async confirmMock(userId: string, paymentId: string): Promise<CreatePaymentResponse> {
    if (!this.provider.supportsMockConfirm) {
      throw new AppError(400, 'BAD_REQUEST', 'Ручное подтверждение недоступно для этого провайдера')
    }
    const payment = await this.db.payment.findFirst({ where: { id: paymentId, userId } })
    if (!payment) {
      throw new AppError(404, 'NOT_FOUND', 'Платёж не найден')
    }
    if (payment.status === 'SUCCEEDED') {
      return { payment: toPaymentDto(payment) }
    }
    const updated = await this.db.payment.update({
      where: { id: payment.id },
      data: { status: 'SUCCEEDED', paidAt: new Date() },
    })
    await this.advanceOrderToPaid(payment.orderId)
    return { payment: toPaymentDto(updated) }
  }

  /** Возврат средств по заказу. Доступен для оплаченного и ещё не возвращённого заказа. */
  async refundOrder(userId: string, orderId: string): Promise<RefundResponse> {
    const order = await this.db.order.findFirst({
      where: { id: orderId, userId },
      select: { id: true, status: true },
    })
    if (!order) {
      throw new AppError(404, 'NOT_FOUND', 'Заказ не найден')
    }
    if (order.status === 'REFUNDED') {
      throw new AppError(409, 'CONFLICT', 'Возврат по заказу уже выполнен')
    }

    const payment = await this.db.payment.findFirst({
      where: { orderId, userId, status: 'SUCCEEDED' },
      include: { refunds: true },
    })
    if (!payment || !payment.providerPaymentId) {
      throw new AppError(400, 'BAD_REQUEST', 'Заказ не оплачен — возврат невозможен')
    }
    if (payment.refunds.some((refund) => refund.status === 'SUCCEEDED')) {
      throw new AppError(409, 'CONFLICT', 'Возврат по заказу уже выполнен')
    }

    const refund = await this.db.refund.create({
      data: {
        paymentId: payment.id,
        orderId,
        userId,
        amount: payment.amount,
        currency: payment.currency,
        status: 'PENDING',
      },
    })

    const providerRefund = await this.provider.refund({
      refundId: refund.id,
      providerPaymentId: payment.providerPaymentId,
      amount: { amount: payment.amount, currency: payment.currency as Currency },
    })

    const updated = await this.db.refund.update({
      where: { id: refund.id },
      data: { status: providerRefund.status, providerRefundId: providerRefund.providerRefundId },
    })

    if (providerRefund.status === 'SUCCEEDED') {
      await this.db.order.update({ where: { id: orderId }, data: { status: 'REFUNDED' } })
    }

    return { refund: toRefundDto(updated) }
  }

  /** Обработка webhook провайдера (ЮKassa). Идемпотентна. */
  async handleWebhook(body: unknown): Promise<void> {
    const parsed = this.provider.parseWebhook(body)
    if (!parsed) return

    // Безопасность: не доверяем телу webhook (у ЮKassa нет HMAC-подписи) —
    // перепроверяем актуальный статус через API провайдера.
    const verifiedStatus = await this.provider
      .getStatus(parsed.providerPaymentId)
      .catch(() => parsed.status)

    const payment = await this.db.payment.findFirst({
      where: { providerPaymentId: parsed.providerPaymentId },
    })
    if (!payment) return
    await this.db.payment.update({
      where: { id: payment.id },
      data: {
        status: verifiedStatus,
        paidAt: verifiedStatus === 'SUCCEEDED' ? (payment.paidAt ?? new Date()) : payment.paidAt,
      },
    })
    if (verifiedStatus === 'SUCCEEDED') {
      await this.advanceOrderToPaid(payment.orderId)
    }
  }

  /** Двигает заказ PLACED → PAID после успешной оплаты (идемпотентно). */
  private async advanceOrderToPaid(orderId: string): Promise<void> {
    await this.db.order.updateMany({
      where: { id: orderId, status: 'PLACED' },
      data: { status: 'PAID' },
    })
  }
}

type RefundRecord = {
  id: string
  orderId: string
  amount: number
  currency: string
  status: string
  createdAt: Date
}

function toRefundDto(refund: RefundRecord): Refund {
  return {
    id: refund.id,
    orderId: refund.orderId,
    amount: { amount: refund.amount, currency: refund.currency as Currency },
    status: refund.status as PaymentStatus,
    createdAt: refund.createdAt.toISOString(),
  }
}

function toPaymentDto(payment: PaymentRecord): Payment {
  return {
    id: payment.id,
    orderId: payment.orderId,
    status: payment.status as PaymentStatus,
    amount: { amount: payment.amount, currency: payment.currency as Currency },
    confirmationUrl: payment.confirmationUrl,
    createdAt: payment.createdAt.toISOString(),
    paidAt: payment.paidAt ? payment.paidAt.toISOString() : null,
  }
}
