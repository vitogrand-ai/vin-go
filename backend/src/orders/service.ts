import {
  allowedOrderTransitionsFor,
  type AddCartItemRequest,
  type CartResponse,
  type Currency,
  type OfferTier,
  type OrderDto,
  type OrderPaymentStatus,
  type OrderResponse,
  type OrdersResponse,
  type OrderStatus,
  type PartQuality,
  type UserRole,
} from '@web-app-demo/contracts'

import type { OfferResolver } from '../catalog/offer-cache'
import type { SupplierProvider } from '../catalog/providers'
import type { DbClient } from '../db'
import { Prisma } from '../generated/prisma/client'
import { AppError } from '../http/errors'
import type { NotificationService } from '../notifications/service'

const ORDER_STATUS_LABEL_RU: Record<OrderStatus, string> = {
  DRAFT: 'Черновик',
  PLACED: 'Оформлен',
  PAID: 'Оплачен',
  PROCESSING: 'В работе',
  READY: 'Готов к выдаче',
  COMPLETED: 'Выдан',
  CANCELLED: 'Отменён',
  REFUNDED: 'Возврат',
}

type OrderItemRecord = {
  id: string
  oemNumber: string
  partName: string
  brand: string
  articleNumber: string
  supplierName: string
  quality: string
  isOriginal: boolean
  tier: string | null
  priceAmount: number
  currency: string
  deliveryDays: number
  quantity: number
}

type OrderRecord = {
  id: string
  status: string
  vehicleVin: string | null
  notes: string | null
  currency: string
  createdAt: Date
  placedAt: Date | null
  items: OrderItemRecord[]
  payments: { status: string }[]
}

const itemsInclude = {
  items: { orderBy: { createdAt: 'asc' as const } },
  payments: { orderBy: { createdAt: 'desc' as const }, take: 1 },
}

/**
 * Корзина и заказы. Корзина — это единственный черновик (DRAFT) пользователя.
 * Цена позиции берётся с сервера по offerId провайдера поставщиков,
 * а не из тела запроса, чтобы клиент не мог подменить стоимость.
 */
export class OrdersService {
  constructor(
    private readonly db: DbClient,
    private readonly suppliers: SupplierProvider,
    private readonly notifications?: NotificationService,
    /** Снимок выдачи для резолва offerId; при промахе — fallback на getOffers. */
    private readonly offerCache?: OfferResolver,
  ) {}

  async getCart(userId: string): Promise<CartResponse> {
    const order = await this.loadDraft(userId)
    return { order: order ? toOrderDto(order) : null }
  }

  async getOrder(userId: string, role: UserRole, orderId: string): Promise<OrderResponse> {
    const order = await this.db.order.findFirst({
      // Оператор может открыть любой заказ, клиент — только свой.
      where: role === 'OPERATOR' ? { id: orderId } : { id: orderId, userId },
      include: itemsInclude,
    })
    if (!order) {
      throw new AppError(404, 'NOT_FOUND', 'Заказ не найден')
    }
    return { order: toOrderDto(order) }
  }

  /** Привязывает текущую корзину (черновик) к автомобилю по VIN. */
  async setCartVehicle(userId: string, vin: string): Promise<OrderResponse> {
    const draftId = await this.ensureDraft(userId, 'RUB', vin)
    const order = await this.db.order.update({
      where: { id: draftId },
      data: { vehicleVin: vin },
      include: itemsInclude,
    })
    return { order: toOrderDto(order) }
  }

  /**
   * Возвращает id корзины пользователя, создавая её при отсутствии. Гонку двух
   * черновиков исключает unique-констрейнт draftKey: параллельный проигравший
   * запрос ловит P2002 и перечитывает уже созданный черновик. Вынесено из
   * транзакции addItem, чтобы конфликт не отравлял её (в Postgres ошибка в
   * транзакции переводит её в aborted).
   */
  private async ensureDraft(
    userId: string,
    currency: string,
    vehicleVin?: string | null,
  ): Promise<string> {
    const existing = await this.db.order.findFirst({
      where: { userId, status: 'DRAFT' },
      select: { id: true },
    })
    if (existing) return existing.id
    try {
      const created = await this.db.order.create({
        data: { userId, status: 'DRAFT', draftKey: userId, currency, vehicleVin: vehicleVin ?? null },
        select: { id: true },
      })
      return created.id
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const draft = await this.db.order.findFirstOrThrow({
          where: { userId, status: 'DRAFT' },
          select: { id: true },
        })
        return draft.id
      }
      throw error
    }
  }

  async updateNotes(userId: string, orderId: string, notes: string): Promise<OrderResponse> {
    const trimmed = notes.trim()
    const result = await this.db.order.updateMany({
      where: { id: orderId, userId },
      data: { notes: trimmed === '' ? null : trimmed },
    })
    if (result.count === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Заказ не найден')
    }
    // Заметка редактируется владельцем своего заказа (where уже по userId).
    return this.getOrder(userId, 'USER', orderId)
  }

  async addItem(userId: string, input: AddCartItemRequest): Promise<OrderResponse> {
    // Сначала берём предложение из снимка выдачи (id стабилен между поиском и
    // «в корзину»); при промахе снимка — повторный getOffers (работает для мока,
    // а для реального API означает «предложение устарело, найдите заново»).
    const offer =
      this.offerCache?.findOffer(input.offerId) ??
      (await this.suppliers.getOffers(input.oemNumber)).find(
        (candidate) => candidate.id === input.offerId,
      )
    if (!offer) {
      throw new AppError(404, 'NOT_FOUND', 'Предложение не найдено или больше недоступно')
    }

    const quantity = input.quantity ?? 1

    // Get-or-create корзины вне транзакции (защита от гонки на draftKey внутри).
    const draftId = await this.ensureDraft(userId, offer.price.currency, input.vehicleVin)

    const order = await this.db.$transaction(async (tx) => {
      // Привязываем авто, только если ещё не привязано (без гонки на чтении).
      if (input.vehicleVin) {
        await tx.order.updateMany({
          where: { id: draftId, vehicleVin: null },
          data: { vehicleVin: input.vehicleVin },
        })
      }

      const existing = await tx.orderItem.findFirst({
        where: {
          orderId: draftId,
          oemNumber: offer.oemNumber,
          brand: offer.brand,
          articleNumber: offer.articleNumber,
        },
      })

      if (existing) {
        await tx.orderItem.update({
          where: { id: existing.id },
          data: {
            quantity: Math.min(99, existing.quantity + quantity),
            priceAmount: offer.price.amount,
            deliveryDays: offer.deliveryDays,
          },
        })
      } else {
        await tx.orderItem.create({
          data: {
            orderId: draftId,
            oemNumber: offer.oemNumber,
            partName: input.partName,
            brand: offer.brand,
            articleNumber: offer.articleNumber,
            supplierName: offer.supplierName,
            quality: offer.quality,
            isOriginal: offer.isOriginal,
            tier: input.tier ?? null,
            priceAmount: offer.price.amount,
            currency: offer.price.currency,
            deliveryDays: offer.deliveryDays,
            quantity,
          },
        })
      }

      return tx.order.findFirstOrThrow({ where: { id: draftId }, include: itemsInclude })
    })

    return { order: toOrderDto(order) }
  }

  async updateItemQuantity(
    userId: string,
    itemId: string,
    quantity: number,
  ): Promise<OrderResponse> {
    const draft = await this.requireDraft(userId)
    const result = await this.db.orderItem.updateMany({
      where: { id: itemId, orderId: draft.id },
      data: { quantity },
    })
    if (result.count === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Позиция не найдена в корзине')
    }
    return { order: toOrderDto(await this.reloadDraft(draft.id)) }
  }

  async removeItem(userId: string, itemId: string): Promise<OrderResponse> {
    const draft = await this.requireDraft(userId)
    const result = await this.db.orderItem.deleteMany({
      where: { id: itemId, orderId: draft.id },
    })
    if (result.count === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Позиция не найдена в корзине')
    }
    return { order: toOrderDto(await this.reloadDraft(draft.id)) }
  }

  async clear(userId: string): Promise<void> {
    const draft = await this.db.order.findFirst({ where: { userId, status: 'DRAFT' } })
    if (draft) {
      await this.db.orderItem.deleteMany({ where: { orderId: draft.id } })
    }
  }

  async checkout(userId: string): Promise<OrderResponse> {
    const draft = await this.loadDraft(userId)
    if (!draft || draft.items.length === 0) {
      throw new AppError(400, 'BAD_REQUEST', 'Корзина пуста')
    }
    const order = await this.db.order.update({
      where: { id: draft.id },
      // draftKey → null: заказ перестаёт быть корзиной, освобождая место под новую.
      data: { status: 'PLACED', placedAt: new Date(), draftKey: null },
      include: itemsInclude,
    })
    return { order: toOrderDto(order) }
  }

  /**
   * Переход статуса заказа с учётом роли. Клиент может только отменить свой
   * ещё не оплаченный заказ; вести заказ по жизненному циклу
   * (PAID → PROCESSING → READY → COMPLETED) может только оператор, причём по
   * любому заказу. Уведомление уходит владельцу заказа, а не тому, кто меняет статус.
   */
  async updateStatus(
    userId: string,
    role: UserRole,
    orderId: string,
    status: OrderStatus,
  ): Promise<OrderResponse> {
    const order = await this.db.order.findFirst({
      // Оператор ведёт чужие заказы, клиент — только свои.
      where: role === 'OPERATOR' ? { id: orderId } : { id: orderId, userId },
      select: { id: true, status: true, userId: true },
    })
    if (!order) {
      throw new AppError(404, 'NOT_FOUND', 'Заказ не найден')
    }
    if (!allowedOrderTransitionsFor(role, order.status as OrderStatus).includes(status)) {
      throw new AppError(
        400,
        'BAD_REQUEST',
        `Недопустимый переход статуса из «${order.status}» в «${status}»`,
      )
    }
    const updated = await this.db.order.update({
      where: { id: order.id },
      data: { status },
      include: itemsInclude,
    })

    // Уведомляем владельца заказа (push + Telegram). Не должно ломать ответ.
    await this.notifications?.notifyUser(
      order.userId,
      'Статус заказа изменён',
      `Заказ № ${updated.id.slice(0, 8).toUpperCase()}: ${ORDER_STATUS_LABEL_RU[status]}`,
    )

    return { order: toOrderDto(updated) }
  }

  async listOrders(userId: string, role: UserRole): Promise<OrdersResponse> {
    const orders = await this.db.order.findMany({
      // Оператор видит очередь всех заказов, клиент — только свои.
      where: { status: { not: 'DRAFT' }, ...(role === 'OPERATOR' ? {} : { userId }) },
      include: itemsInclude,
      orderBy: { placedAt: 'desc' },
    })
    return { orders: orders.map(toOrderDto) }
  }

  private async loadDraft(userId: string): Promise<OrderRecord | null> {
    return this.db.order.findFirst({
      where: { userId, status: 'DRAFT' },
      include: itemsInclude,
    })
  }

  private async requireDraft(userId: string): Promise<{ id: string }> {
    const draft = await this.db.order.findFirst({
      where: { userId, status: 'DRAFT' },
      select: { id: true },
    })
    if (!draft) {
      throw new AppError(404, 'NOT_FOUND', 'Корзина пуста')
    }
    return draft
  }

  private async reloadDraft(orderId: string): Promise<OrderRecord> {
    return this.db.order.findFirstOrThrow({ where: { id: orderId }, include: itemsInclude })
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

function toOrderDto(order: OrderRecord): OrderDto {
  const currency = order.currency as Currency
  const items = order.items.map((item) => {
    const itemCurrency = item.currency as Currency
    return {
      id: item.id,
      oemNumber: item.oemNumber,
      partName: item.partName,
      brand: item.brand,
      articleNumber: item.articleNumber,
      supplierName: item.supplierName,
      quality: item.quality as PartQuality,
      isOriginal: item.isOriginal,
      tier: (item.tier as OfferTier | null) ?? null,
      price: { amount: item.priceAmount, currency: itemCurrency },
      deliveryDays: item.deliveryDays,
      quantity: item.quantity,
      lineTotal: { amount: item.priceAmount * item.quantity, currency: itemCurrency },
    }
  })

  const latestPayment = order.payments[0]
  const paymentStatus: OrderPaymentStatus = latestPayment
    ? (latestPayment.status as OrderPaymentStatus)
    : 'NONE'

  return {
    id: order.id,
    status: order.status as OrderStatus,
    paymentStatus,
    vehicleVin: order.vehicleVin,
    notes: order.notes,
    items,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    total: { amount: items.reduce((sum, item) => sum + item.lineTotal.amount, 0), currency },
    createdAt: order.createdAt.toISOString(),
    placedAt: order.placedAt ? order.placedAt.toISOString() : null,
  }
}
