import {
  allowedOrderTransitionsFor,
  applyMarkup,
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
} from '@web-app-demo/contracts'

import type { Actor } from '../auth/actor'
import type { OfferResolver } from '../catalog/offer-cache'
import type { SupplierProvider } from '../catalog/providers'
import { requireOrgCustomer } from '../customers/service'
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
  saleAmount: number
  markupBps: number
  currency: string
  deliveryDays: number
  quantity: number
}

type OrderRecord = {
  id: string
  number: number
  status: string
  vehicleVin: string | null
  notes: string | null
  currency: string
  createdAt: Date
  placedAt: Date | null
  items: OrderItemRecord[]
  payments: { status: string }[]
  customer: { id: string; name: string; phone: string | null } | null
}

const itemsInclude = {
  items: { orderBy: { createdAt: 'asc' as const } },
  payments: { orderBy: { createdAt: 'desc' as const }, take: 1 },
  customer: { select: { id: true, name: true, phone: true } },
}

/**
 * Область видимости заказа: оператор платформы видит любой, сотрудник
 * автосервиса — только заказы своей организации.
 */
function orderScope(actor: Actor, orderId: string) {
  return actor.role === 'OPERATOR' ? { id: orderId } : { id: orderId, orgId: actor.orgId }
}

/**
 * Корзина и заказы автосервиса. Корзина — единственный черновик (DRAFT)
 * сотрудника; оформленные заказы принадлежат организации и видны всем её
 * сотрудникам. Цена позиции берётся с сервера по offerId провайдера
 * поставщиков, а не из тела запроса, чтобы клиент не мог подменить стоимость.
 * Рядом с закупочной ценой позиция хранит цену для клиента автосервиса
 * (закуп × наценка организации) — основу сметы и отчёта по марже.
 */
export class OrdersService {
  constructor(
    private readonly db: DbClient,
    private readonly suppliers: SupplierProvider,
    private readonly notifications?: NotificationService,
    /** Снимок выдачи для резолва offerId; при промахе — fallback на getOffers. */
    private readonly offerCache?: OfferResolver,
  ) {}

  async getCart(actor: Actor): Promise<CartResponse> {
    const order = await this.loadDraft(actor.userId)
    return { order: order ? toOrderDto(order) : null }
  }

  async getOrder(actor: Actor, orderId: string): Promise<OrderResponse> {
    const order = await this.db.order.findFirst({
      where: orderScope(actor, orderId),
      include: itemsInclude,
    })
    if (!order) {
      throw new AppError(404, 'NOT_FOUND', 'Заказ не найден')
    }
    return { order: toOrderDto(order) }
  }

  /**
   * Привязывает корзину к автомобилю по VIN. Если машина есть в гараже
   * автосервиса и у неё есть владелец — клиент подставляется сам.
   */
  async setCartVehicle(actor: Actor, vin: string): Promise<OrderResponse> {
    const draftId = await this.ensureDraft(actor, 'RUB', vin)
    const garageCar = await this.db.vehicle.findFirst({
      where: { orgId: actor.orgId, vin },
      select: { customerId: true },
    })
    const order = await this.db.order.update({
      where: { id: draftId },
      data: {
        vehicleVin: vin,
        ...(garageCar?.customerId ? { customerId: garageCar.customerId } : {}),
      },
      include: itemsInclude,
    })
    return { order: toOrderDto(order) }
  }

  /** Клиент автосервиса для корзины; null — отвязать. */
  async setCartCustomer(actor: Actor, customerId: string | null): Promise<OrderResponse> {
    if (customerId) await requireOrgCustomer(this.db, actor.orgId, customerId)
    const draftId = await this.ensureDraft(actor, 'RUB')
    const order = await this.db.order.update({
      where: { id: draftId },
      data: { customerId },
      include: itemsInclude,
    })
    return { order: toOrderDto(order) }
  }

  /**
   * Возвращает id корзины сотрудника, создавая её при отсутствии. Гонку двух
   * черновиков исключает unique-констрейнт draftKey: параллельный проигравший
   * запрос ловит P2002 и перечитывает уже созданный черновик. Вынесено из
   * транзакции addItem, чтобы конфликт не отравлял её (в Postgres ошибка в
   * транзакции переводит её в aborted).
   */
  private async ensureDraft(
    actor: Actor,
    currency: string,
    vehicleVin?: string | null,
  ): Promise<string> {
    const existing = await this.db.order.findFirst({
      where: { userId: actor.userId, status: 'DRAFT' },
      select: { id: true },
    })
    if (existing) return existing.id
    try {
      const created = await this.db.order.create({
        data: {
          userId: actor.userId,
          orgId: actor.orgId,
          status: 'DRAFT',
          draftKey: actor.userId,
          currency,
          vehicleVin: vehicleVin ?? null,
        },
        select: { id: true },
      })
      return created.id
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const draft = await this.db.order.findFirstOrThrow({
          where: { userId: actor.userId, status: 'DRAFT' },
          select: { id: true },
        })
        return draft.id
      }
      throw error
    }
  }

  async updateNotes(actor: Actor, orderId: string, notes: string): Promise<OrderResponse> {
    const trimmed = notes.trim()
    const result = await this.db.order.updateMany({
      where: orderScope(actor, orderId),
      data: { notes: trimmed === '' ? null : trimmed },
    })
    if (result.count === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Заказ не найден')
    }
    return this.getOrder(actor, orderId)
  }

  async addItem(actor: Actor, input: AddCartItemRequest): Promise<OrderResponse> {
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

    // Наценка автосервиса на момент добавления — замораживается в позиции,
    // чтобы смета не «плыла» при смене настроек.
    const org = await this.db.organization.findUnique({
      where: { id: actor.orgId },
      select: { defaultMarkupBps: true },
    })
    const markupBps = org?.defaultMarkupBps ?? 0

    // Get-or-create корзины вне транзакции (защита от гонки на draftKey внутри).
    const draftId = await this.ensureDraft(actor, offer.price.currency, input.vehicleVin)

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
        // Повторное добавление обновляет закуп и пересчитывает цену для клиента
        // по наценке позиции — ручная правка цены при этом не сохраняется.
        await tx.orderItem.update({
          where: { id: existing.id },
          data: {
            quantity: Math.min(99, existing.quantity + quantity),
            priceAmount: offer.price.amount,
            saleAmount: applyMarkup(offer.price.amount, existing.markupBps),
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
            saleAmount: applyMarkup(offer.price.amount, markupBps),
            markupBps,
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
    actor: Actor,
    itemId: string,
    quantity: number,
  ): Promise<OrderResponse> {
    const draft = await this.requireDraft(actor.userId)
    const result = await this.db.orderItem.updateMany({
      where: { id: itemId, orderId: draft.id },
      data: { quantity },
    })
    if (result.count === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Позиция не найдена в корзине')
    }
    return { order: toOrderDto(await this.reloadDraft(draft.id)) }
  }

  /**
   * Ручная цена для клиента по позиции. Наценка позиции пересчитывается из
   * фактической пары закуп/продажа, чтобы отчёт по марже не врал.
   */
  async updateItemSalePrice(
    actor: Actor,
    itemId: string,
    saleAmount: number,
  ): Promise<OrderResponse> {
    const draft = await this.requireDraft(actor.userId)
    const item = await this.db.orderItem.findFirst({
      where: { id: itemId, orderId: draft.id },
      select: { priceAmount: true, markupBps: true },
    })
    if (!item) {
      throw new AppError(404, 'NOT_FOUND', 'Позиция не найдена в корзине')
    }
    const markupBps =
      item.priceAmount > 0
        ? Math.round(((saleAmount - item.priceAmount) / item.priceAmount) * 10_000)
        : item.markupBps
    await this.db.orderItem.update({
      where: { id: itemId },
      data: { saleAmount, markupBps },
    })
    return { order: toOrderDto(await this.reloadDraft(draft.id)) }
  }

  async removeItem(actor: Actor, itemId: string): Promise<OrderResponse> {
    const draft = await this.requireDraft(actor.userId)
    const result = await this.db.orderItem.deleteMany({
      where: { id: itemId, orderId: draft.id },
    })
    if (result.count === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Позиция не найдена в корзине')
    }
    return { order: toOrderDto(await this.reloadDraft(draft.id)) }
  }

  async clear(actor: Actor): Promise<void> {
    const draft = await this.db.order.findFirst({
      where: { userId: actor.userId, status: 'DRAFT' },
    })
    if (draft) {
      await this.db.orderItem.deleteMany({ where: { orderId: draft.id } })
    }
  }

  async checkout(actor: Actor): Promise<OrderResponse> {
    const draft = await this.loadDraft(actor.userId)
    if (!draft || draft.items.length === 0) {
      throw new AppError(400, 'BAD_REQUEST', 'Корзина пуста')
    }
    const order = await this.db.order.update({
      where: { id: draft.id },
      // draftKey → null: заказ перестаёт быть корзиной, освобождая место под новую.
      data: { status: 'PLACED', placedAt: new Date(), draftKey: null, orgId: actor.orgId },
      include: itemsInclude,
    })
    return { order: toOrderDto(order) }
  }

  /**
   * Переход статуса заказа с учётом роли. Сотрудник автосервиса может только
   * отменить ещё не оплаченный заказ своей организации; вести заказ по
   * жизненному циклу (PAID → PROCESSING → READY → COMPLETED) может только
   * оператор платформы, причём по любому заказу. Уведомление уходит тому, кто
   * оформил заказ, а не тому, кто меняет статус.
   */
  async updateStatus(actor: Actor, orderId: string, status: OrderStatus): Promise<OrderResponse> {
    const order = await this.db.order.findFirst({
      where: orderScope(actor, orderId),
      select: { id: true, status: true, userId: true },
    })
    if (!order) {
      throw new AppError(404, 'NOT_FOUND', 'Заказ не найден')
    }
    if (!allowedOrderTransitionsFor(actor.role, order.status as OrderStatus).includes(status)) {
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

    // Уведомляем автора заказа (push + Telegram). Не должно ломать ответ.
    await this.notifications?.notifyUser(
      order.userId,
      'Статус заказа изменён',
      `Заказ № ${updated.number}: ${ORDER_STATUS_LABEL_RU[status]}`,
    )

    return { order: toOrderDto(updated) }
  }

  async listOrders(actor: Actor): Promise<OrdersResponse> {
    const orders = await this.db.order.findMany({
      // Оператор платформы видит очередь всех заказов, сотрудник — заказы своего автосервиса.
      where: {
        status: { not: 'DRAFT' },
        ...(actor.role === 'OPERATOR' ? {} : { orgId: actor.orgId }),
      },
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
      salePrice: { amount: item.saleAmount, currency: itemCurrency },
      markupBps: item.markupBps,
      deliveryDays: item.deliveryDays,
      quantity: item.quantity,
      lineTotal: { amount: item.priceAmount * item.quantity, currency: itemCurrency },
      saleLineTotal: { amount: item.saleAmount * item.quantity, currency: itemCurrency },
    }
  })

  const latestPayment = order.payments[0]
  const paymentStatus: OrderPaymentStatus = latestPayment
    ? (latestPayment.status as OrderPaymentStatus)
    : 'NONE'

  const total = items.reduce((sum, item) => sum + item.lineTotal.amount, 0)
  const saleTotal = items.reduce((sum, item) => sum + item.saleLineTotal.amount, 0)

  return {
    id: order.id,
    number: order.number,
    status: order.status as OrderStatus,
    paymentStatus,
    vehicleVin: order.vehicleVin,
    customer: order.customer,
    notes: order.notes,
    items,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    total: { amount: total, currency },
    saleTotal: { amount: saleTotal, currency },
    marginTotal: { amount: saleTotal - total, currency },
    createdAt: order.createdAt.toISOString(),
    placedAt: order.placedAt ? order.placedAt.toISOString() : null,
  }
}
