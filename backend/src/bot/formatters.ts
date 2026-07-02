import type { Money, Offer, OrderDto, Part, TierPick, Vehicle } from '@web-app-demo/contracts'

import type { InlineKeyboard } from './telegram'

const rubFormatter = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 0,
})

export function formatMoney(money: Money): string {
  if (money.currency === 'RUB') return rubFormatter.format(money.amount / 100)
  return `${(money.amount / 100).toLocaleString('ru-RU')} ${money.currency}`
}

function formatDelivery(days: number): string {
  if (days <= 0) return 'сегодня'
  if (days === 1) return 'завтра'
  return `${days} дн.`
}

const TIER_LABEL: Record<TierPick['tier'], string> = {
  ECONOMY: '🟢 Эконом',
  BALANCED: '🔵 Оптимальный',
  ORIGINAL: '🟡 Оригинал',
}

/** Экранирование для HTML parse mode Telegram. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export const WELCOME =
  'Привет! Я помогу подобрать автозапчасти.\n\n' +
  '1. Пришлите <b>VIN</b> (17 символов) или <b>госномер</b> (например, А123ВС777).\n' +
  '2. Затем — название запчасти (например, «тормозные колодки»).\n' +
  '3. Я покажу варианты: эконом, оптимальный и оригинал.\n\n' +
  'Команды: /start — помощь.'

export function formatVehicle(vehicle: Vehicle): string {
  const lines = [
    `🚗 <b>${escapeHtml(vehicle.make)} ${escapeHtml(vehicle.model)}</b>`,
    `VIN: <code>${escapeHtml(vehicle.vin)}</code>`,
    `Год: ${vehicle.year}`,
  ]
  if (vehicle.engine) lines.push(`Двигатель: ${escapeHtml(vehicle.engine)}`)
  lines.push('', 'Теперь пришлите название запчасти 🔧')
  return lines.join('\n')
}

export function partsMessage(parts: Part[]): { text: string; keyboard: InlineKeyboard } {
  return {
    text: `Найдено запчастей: ${parts.length}. Выберите нужную:`,
    keyboard: {
      inline_keyboard: parts.map((part) => [
        {
          text: truncate(`${part.name} (${part.oemNumber})`, 60),
          callback_data: `oem:${part.oemNumber}`,
        },
      ]),
    },
  }
}

/** Клавиатура «в корзину» по тирам (callback add:<TIER>:<OEM>). */
export function tierAddKeyboard(picks: TierPick[], oemNumber: string): InlineKeyboard {
  return {
    inline_keyboard: picks.map((pick) => [
      {
        text: `🛒 ${TIER_LABEL[pick.tier]} — ${formatMoney(pick.offer.price)}`,
        callback_data: `add:${pick.tier}:${oemNumber}`,
      },
    ]),
  }
}

const ORDER_STATUS_LABEL: Record<OrderDto['status'], string> = {
  DRAFT: 'Черновик',
  PLACED: 'Оформлен',
  PAID: 'Оплачен',
  PROCESSING: 'В работе',
  READY: 'Готов к выдаче',
  COMPLETED: 'Выдан',
  CANCELLED: 'Отменён',
  REFUNDED: 'Возврат',
}

export function cartMessage(order: OrderDto | null): string {
  if (!order || order.items.length === 0) {
    return 'Корзина пуста. Найдите запчасть и добавьте её в корзину.'
  }
  const lines = ['🛒 <b>Корзина</b>', '']
  for (const item of order.items) {
    lines.push(
      `• ${escapeHtml(item.partName)} ×${item.quantity} — ${formatMoney(item.lineTotal)}`,
    )
  }
  lines.push('', `Итого: <b>${formatMoney(order.total)}</b>`, 'Оформить: /checkout')
  return lines.join('\n')
}

export function ordersMessage(orders: OrderDto[]): string {
  if (orders.length === 0) return 'Заказов пока нет.'
  const lines = ['📋 <b>Заказы</b>', '']
  for (const order of orders) {
    lines.push(
      `№ ${order.id.slice(0, 8).toUpperCase()} — ${ORDER_STATUS_LABEL[order.status]} — ${formatMoney(order.total)}`,
    )
  }
  return lines.join('\n')
}

export function offersMessage(oemNumber: string, picks: TierPick[], offers: Offer[]): string {
  const lines = [`📦 OEM <code>${escapeHtml(oemNumber)}</code>`, '']

  if (picks.length === 0) {
    lines.push('Предложений не найдено.')
    return lines.join('\n')
  }

  for (const pick of picks) {
    const { offer } = pick
    lines.push(
      `${TIER_LABEL[pick.tier]} — <b>${formatMoney(offer.price)}</b>`,
      `${escapeHtml(offer.brand)} · ${escapeHtml(offer.supplierName)}`,
      `${offer.inStock ? '✅ в наличии' : '⏳ под заказ'} · ${formatDelivery(offer.deliveryDays)}`,
      '',
    )
  }

  lines.push(`Всего предложений: ${offers.length}.`)
  return lines.join('\n')
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}
