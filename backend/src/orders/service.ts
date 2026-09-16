import {
  allowedOrderTransitionsFor,
  applyMarkup,
  type AddCartItemRequest,
  type AddOrderWorkRequest,
  type CartResponse,
  type Currency,
  type OfferTier,
  type OrderDto,
  type OrderPaymentStatus,
  type OrderResponse,
  type OrdersResponse,
  type OrderStatus,
  type OrderVehicleDto,
  type PartQuality,
  type UpdateOrderReceptionPayload,
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

type OrderWorkRecord = {
  id: string
  name: string
  priceAmount: number
  currency: string
  quantity: number
}

type OrderRecord = {
  id: string
  number: number
  status: string
  orgId: string | null
  vehicleVin: string | null
  notes: string | null
  dueAt: Date | null
  complaint: string | null
  conditionNotes: string | null
  plate: string | null
  mileageKm: number | null
  currency: string
  createdAt: Date
  placedAt: Date | null
  items: OrderItemRecord[]
  works: OrderWorkRecord[]
  payments: { status: string }[]
  customer: { id: string; name: string; phone: string | null } | null
  user: { displayName: string | null; email: string }
}

const itemsInclude = {
  items: { orderBy: { createdAt: 'asc' as const } },
  works: { orderBy: { createdAt: 'asc' as const } },
  payments: { orderBy: { createdAt: 'desc' as const }, take: 1 },
  customer: { select: { id: true, name: true, phone: true } },
  // Кто принял заказ — печатается в заказ-наряде (ПП № 780, п. 9(и)).
  user: { select: { displayName: true, email: true } },
}

/** Статусы, в которых заказ-наряд ещё правится: выданный и отменённый — история. */
const EDITABLE_STATUSES = new Set<string>(['DRAFT', 'PLACED', 'PAID', 'PROCESSING', 'READY'])

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
    return { order: order ? await this.toDto(order) : null }
  }

  async getOrder(actor: Actor, orderId: string): Promise<OrderResponse> {
    const order = await this.db.order.findFirst({
      where: orderScope(actor, orderId),
      include: itemsInclude,
    })
    if (!order) {
      throw new AppError(404, 'NOT_FOUND', 'Заказ не найден')
    }
    return { order: await this.toDto(order) }
  }

  /**
   * Привязывает корзину к автомобилю по VIN. Если машина есть в гараже
   * автосервиса — подставляются её владелец, госномер и пробег: это же
   * данные приёма для заказ-наряда, приёмщик их не набирает второй раз.
   */
  async setCartVehicle(actor: Actor, vin: string): Promise<OrderResponse> {
    const draftId = await this.ensureDraft(actor, 'RUB', vin)
    const garageCar = await this.db.vehicle.findFirst({
      where: { orgId: actor.orgId, vin },
      select: { customerId: true, plate: true, mileageKm: true },
    })
    const order = await this.db.order.update({
      where: { id: draftId },
      data: {
        vehicleVin: vin,
        ...(garageCar?.customerId ? { customerId: garageCar.customerId } : {}),
        ...(garageCar?.plate ? { plate: garageCar.plate } : {}),
        ...(garageCar?.mileageKm != null ? { mileageKm: garageCar.mileageKm } : {}),
      },
      include: itemsInclude,
    })
    return { order: await this.toDto(order) }
  }

  /**
   * Работа в заказ-наряд. Правится, пока заказ не выдан и не отменён: после
   * выдачи документ подписан, и менять его состав нельзя.
   */
  async addWork(actor: Actor, input: AddOrderWorkRequest): Promise<OrderResponse> {
    const order = await this.requireEditable(actor, input.orderId)
    await this.db.orderWork.create({
      data: {
        orderId: order.id,
        name: input.name,
        priceAmount: input.amount,
        currency: order.currency,
        quantity: input.quantity ?? 1,
      },
    })
    return this.getOrder(actor, order.id)
  }

  async removeWork(actor: Actor, orderId: string, workId: string): Promise<OrderResponse> {
    const order = await this.requireEditable(actor, orderId)
    const result = await this.db.orderWork.deleteMany({ where: { id: workId, orderId: order.id } })
    if (result.count === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Работа не найдена в заказе')
    }
    return this.getOrder(actor, order.id)
  }

  /** Данные приёма машины: null очищает поле, отсутствие — не трогает. */
  async updateReception(
    actor: Actor,
    input: UpdateOrderReceptionPayload,
  ): Promise<OrderResponse> {
    const order = await this.requireEditable(actor, input.orderId)
    await this.db.order.update({
      where: { id: order.id },
      data: {
        ...(input.dueAt !== undefined ? { dueAt: input.dueAt ? new Date(input.dueAt) : null } : {}),
        ...(input.complaint !== undefined ? { complaint: input.complaint || null } : {}),
        ...(input.conditionNotes !== undefined
          ? { conditionNotes: input.conditionNotes || null }
          : {}),
        ...(input.plate !== undefined ? { plate: input.plate } : {}),
        ...(input.mileageKm !== undefined ? { mileageKm: input.mileageKm } : {}),
      },
    })
    return this.getOrder(actor, order.id)
  }

  private async requireEditable(
    actor: Actor,
    orderId: string,
  ): Promise<{ id: string; status: string; currency: string }> {
    const order = await this.db.order.findFirst({
      where: orderScope(actor, orderId),
      select: { id: true, status: true, currency: true },
    })
    if (!order) throw new AppError(404, 'NOT_FOUND', 'Заказ не найден')
    if (!EDITABLE_STATUSES.has(order.status)) {
      throw new AppError(400, 'BAD_REQUEST', 'Заказ уже закрыт — заказ-наряд не правится')
    }
    return order
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
    return { order: await this.toDto(order) }
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

  /**
   * DTO с машиной из гаража: у заказа есть только VIN, а в заказ-наряде нужны
   * марка, модель и год (ПП № 780, п. 9(д)). Гараж общий для организации,
   * поэтому ищем по паре (orgId, vin); одним запросом на весь список.
   */
  private async toDtos(orders: OrderRecord[]): Promise<OrderDto[]> {
    const pairs = orders
      .filter((order) => order.orgId && order.vehicleVin)
      .map((order) => ({ orgId: order.orgId!, vin: order.vehicleVin! }))
    const vehicles = pairs.length
      ? await this.db.vehicle.findMany({
          where: { OR: pairs },
          select: { orgId: true, vin: true, make: true, model: true, year: true },
        })
      : []
    const byKey = new Map<string, OrderVehicleDto>()
    for (const vehicle of vehicles) {
      byKey.set(`${vehicle.orgId}:${vehicle.vin}`, {
        make: vehicle.make,
        model: vehicle.model,
        year: vehicle.year,
      })
    }
    return orders.map((order) =>
      toOrderDto(order, byKey.get(`${order.orgId}:${order.vehicleVin}`) ?? null),
    )
  }

  private async toDto(order: OrderRecord): Promise<OrderDto> {
    return (await this.toDtos([order]))[0]!
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

    return { order: await this.toDto(order) }
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
    return { order: await this.toDto(await this.reloadDraft(draft.id)) }
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
    return { order: await this.toDto(await this.reloadDraft(draft.id)) }
  }

  async removeItem(actor: Actor, itemId: string): Promise<OrderResponse> {
    const draft = await this.requireDraft(actor.userId)
    const result = await this.db.orderItem.deleteMany({
      where: { id: itemId, orderId: draft.id },
    })
    if (result.count === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Позиция не найдена в корзине')
    }
    return { order: await this.toDto(await this.reloadDraft(draft.id)) }
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
    return { order: await this.toDto(order) }
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

    return { order: await this.toDto(updated) }
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
    return { orders: await this.toDtos(orders) }
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

function toOrderDto(order: OrderRecord, vehicle: OrderVehicleDto | null): OrderDto {
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

  const works = order.works.map((work) => ({
    id: work.id,
    name: work.name,
    price: { amount: work.priceAmount, currency: work.currency as Currency },
    quantity: work.quantity,
    lineTotal: { amount: work.priceAmount * work.quantity, currency: work.currency as Currency },
  }))

  const total = items.reduce((sum, item) => sum + item.lineTotal.amount, 0)
  const saleTotal = items.reduce((sum, item) => sum + item.saleLineTotal.amount, 0)
  const worksTotal = works.reduce((sum, work) => sum + work.lineTotal.amount, 0)

  return {
    id: order.id,
    number: order.number,
    status: order.status as OrderStatus,
    paymentStatus,
    vehicleVin: order.vehicleVin,
    vehicle,
    customer: order.customer,
    notes: order.notes,
    reception: {
      dueAt: order.dueAt ? order.dueAt.toISOString() : null,
      complaint: order.complaint,
      conditionNotes: order.conditionNotes,
      plate: order.plate,
      mileageKm: order.mileageKm,
    },
    acceptedBy: order.user.displayName ?? order.user.email,
    items,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    works,
    total: { amount: total, currency },
    saleTotal: { amount: saleTotal, currency },
    worksTotal: { amount: worksTotal, currency },
    grandTotal: { amount: saleTotal + worksTotal, currency },
    marginTotal: { amount: saleTotal - total, currency },
    createdAt: order.createdAt.toISOString(),
    placedAt: order.placedAt ? order.placedAt.toISOString() : null,
  }
}
