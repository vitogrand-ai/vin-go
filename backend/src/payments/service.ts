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
import type { NotificationService } from '../notifications/service'
import type { PaymentProvider, ReceiptData } from './providers'

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
  /**
   * Код ставки НДС ЮKassa (1–6). Задан — включает фискализацию (54-ФЗ): к платежу
   * и возврату прикладывается чек. Пусто — чек не формируется (нет подключённой кассы).
   */
  vatCode?: number
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
    private readonly notifications?: NotificationService,
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
      receipt: await this.buildReceiptForOrder(order.id),
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
      receipt: await this.buildReceiptForOrder(orderId),
    })

    const updated = await this.db.refund.update({
      where: { id: refund.id },
      data: { status: providerRefund.status, providerRefundId: providerRefund.providerRefundId },
    })

    if (providerRefund.status === 'SUCCEEDED') {
      await this.db.order.update({ where: { id: orderId }, data: { status: 'REFUNDED' } })
      await this.notifyOrder(userId, orderId, 'Возврат средств выполнен')
    }

    return { refund: toRefundDto(updated) }
  }

  /** Обработка webhook провайдера (ЮKassa). Идемпотентна. */
  async handleWebhook(body: unknown): Promise<void> {
    const parsed = this.provider.parseWebhook(body)
    if (!parsed) return

    if (parsed.kind === 'payment') {
      await this.applyPaymentStatus(parsed.providerPaymentId)
      return
    }
    await this.applyRefundStatus(parsed.providerRefundId)
  }

  /**
   * Синхронизирует статус платежа с провайдером по его providerPaymentId.
   * Телу webhook НЕ доверяем (у ЮKassa нет HMAC-подписи): единственный источник
   * истины — статус из API провайдера. Если верификация не удалась (API недоступен,
   * платёж не найден у провайдера), пробрасываем ошибку — маршрут вернёт 5xx,
   * ЮKassa повторит доставку, а поддельный webhook не сможет провести платёж.
   * Идемпотентно — используется и в webhook, и в reconcile.
   */
  async applyPaymentStatus(providerPaymentId: string): Promise<void> {
    const verifiedStatus = await this.provider.getStatus(providerPaymentId)
    const payment = await this.db.payment.findFirst({ where: { providerPaymentId } })
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

  /**
   * Синхронизирует статус возврата с провайдером. Так же не доверяем телу webhook —
   * перепроверяем статус возврата через API. При успехе двигает заказ в REFUNDED.
   */
  async applyRefundStatus(providerRefundId: string): Promise<void> {
    const verifiedStatus = await this.provider.getRefundStatus(providerRefundId)
    const refund = await this.db.refund.findFirst({ where: { providerRefundId } })
    if (!refund) return
    await this.db.refund.update({ where: { id: refund.id }, data: { status: verifiedStatus } })
    if (verifiedStatus === 'SUCCEEDED') {
      const result = await this.db.order.updateMany({
        where: { id: refund.orderId, status: { not: 'REFUNDED' } },
        data: { status: 'REFUNDED' },
      })
      // Уведомляем владельца только если статус реально сменился (идемпотентно).
      if (result.count > 0) {
        await this.notifyOrder(refund.userId, refund.orderId, 'Возврат средств выполнен')
      }
    }
  }

  /**
   * Reconcile зависших платежей и возвратов — страховка от потерянного webhook.
   * Опрашивает PENDING старше olderThanMs через API провайдера и идемпотентно
   * синхронизирует статус (та же логика, что в webhook). Ошибка по одному элементу
   * не срывает батч. Возвращает, сколько платежей и возвратов проверено.
   */
  async reconcilePending(
    olderThanMs = 5 * 60 * 1000,
  ): Promise<{ payments: number; refunds: number }> {
    const cutoff = new Date(Date.now() - olderThanMs)

    const payments = await this.db.payment.findMany({
      where: { status: 'PENDING', providerPaymentId: { not: null }, createdAt: { lt: cutoff } },
      select: { providerPaymentId: true },
    })
    for (const payment of payments) {
      if (!payment.providerPaymentId) continue
      try {
        await this.applyPaymentStatus(payment.providerPaymentId)
      } catch (error) {
        console.error(`reconcile: платёж ${payment.providerPaymentId} не проверен`, error)
      }
    }

    const refunds = await this.db.refund.findMany({
      where: { status: 'PENDING', providerRefundId: { not: null }, createdAt: { lt: cutoff } },
      select: { providerRefundId: true },
    })
    for (const refund of refunds) {
      if (!refund.providerRefundId) continue
      try {
        await this.applyRefundStatus(refund.providerRefundId)
      } catch (error) {
        console.error(`reconcile: возврат ${refund.providerRefundId} не проверен`, error)
      }
    }

    return { payments: payments.length, refunds: refunds.length }
  }

  /**
   * Строит фискальный чек (54-ФЗ) из позиций заказа и email клиента.
   * undefined — если фискализация выключена (config.vatCode пуст) или нет позиций,
   * тогда провайдер отправит платёж без чека.
   */
  private async buildReceiptForOrder(orderId: string): Promise<ReceiptData | undefined> {
    const vatCode = this.config.vatCode
    if (!vatCode) return undefined
    const order = await this.db.order.findUnique({
      where: { id: orderId },
      select: {
        user: { select: { email: true } },
        items: { select: { partName: true, priceAmount: true, currency: true, quantity: true } },
      },
    })
    if (!order || order.items.length === 0) return undefined
    return {
      customerEmail: order.user.email,
      items: order.items.map((item) => ({
        description: item.partName,
        quantity: item.quantity,
        amount: { amount: item.priceAmount, currency: item.currency as Currency },
        vatCode,
      })),
    }
  }

  /** Двигает заказ PLACED → PAID после успешной оплаты (идемпотентно) и уведомляет владельца. */
  private async advanceOrderToPaid(orderId: string): Promise<void> {
    const result = await this.db.order.updateMany({
      where: { id: orderId, status: 'PLACED' },
      data: { status: 'PAID' },
    })
    // count > 0 → заказ впервые стал PAID; на повторный webhook уведомления не дублируем.
    if (result.count > 0 && this.notifications) {
      const order = await this.db.order.findUnique({
        where: { id: orderId },
        select: { userId: true },
      })
      if (order) await this.notifyOrder(order.userId, orderId, 'Заказ оплачен')
    }
  }

  /** Фоновое уведомление владельцу заказа (push + Telegram). Никогда не бросает. */
  private async notifyOrder(userId: string, orderId: string, body: string): Promise<void> {
    await this.notifications?.notifyUser(
      userId,
      'Статус заказа изменён',
      `Заказ № ${orderId.slice(0, 8).toUpperCase()}: ${body}`,
    )
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
