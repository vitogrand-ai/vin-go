import type {
  DataSource,
  Money,
  Offer,
  OrderDto,
  Part,
  SavedVehicle,
  TierPick,
  Vehicle,
} from '@web-app-demo/contracts'

import {
  selectServiceAlerts,
  type IntervalStatus,
} from '../garage/service-intervals'
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
  '   Можно просто <b>сфотографировать шильдик</b> — прочитаю номер сам.\n' +
  '2. Затем — название запчасти (например, «тормозные колодки»).\n' +
  '   Понимаю <b>голосовые</b> и мастерской жаргон: «гранатка», «воздухан», «жабка».\n' +
  '3. Я покажу варианты: эконом, оптимальный и оригинал.\n\n' +
  'Команды: /garage — выбрать машину из гаража, /cart — корзина, /orders — заказы, ' +
  '/checkout — оформить, /то 145000 — что пора менять, /start — помощь.'

export function formatVehicle(vehicle: Vehicle): string {
  const lines = [
    `🚗 <b>${escapeHtml(vehicle.make)} ${escapeHtml(vehicle.model)}</b>`,
    `VIN: <code>${escapeHtml(vehicle.vin)}</code>`,
  ]
  // «Год: 0» выглядит ошибкой продукта — неизвестный год просто не показываем.
  if (vehicle.year) lines.push(`Год: ${vehicle.year}`)
  if (vehicle.engine) lines.push(`Двигатель: ${escapeHtml(vehicle.engine)}`)
  lines.push('', 'Теперь пришлите название запчасти 🔧')
  return lines.join('\n')
}

/**
 * Потолок кнопок в выдаче: простыня из ста кнопок в чате нечитаема, а Telegram
 * и вовсе отклоняет слишком длинную клавиатуру. Уточните запрос — короче список.
 */
export const MAX_PART_BUTTONS = 20

/** Гараж автосервиса кнопками: госномер и модель — то, по чему мастер узнаёт машину. */
export function garageMessage(vehicles: SavedVehicle[]): { text: string; keyboard?: InlineKeyboard } {
  if (vehicles.length === 0) {
    return { text: 'Гараж пуст. Добавьте машины клиентов в личном кабинете на сайте.' }
  }
  const shown = vehicles.slice(0, MAX_PART_BUTTONS)
  const overflow =
    vehicles.length > shown.length ? `\nПоказаны первые ${shown.length} машин.` : ''
  return {
    text: `🚗 <b>Гараж</b> — выберите машину:${overflow}`,
    keyboard: {
      inline_keyboard: shown.map((vehicle) => [
        {
          text: truncate(
            [vehicle.plate, vehicle.nickname ?? `${vehicle.make} ${vehicle.model}`, vehicle.customer?.name]
              .filter(Boolean)
              .join(' · '),
            60,
          ),
          callback_data: `car:${vehicle.vin}`,
        },
      ]),
    },
  }
}

export function partsMessage(
  parts: Part[],
  resolvedQuery?: string,
): { text: string; keyboard: InlineKeyboard } {
  // Если искали не тем словом, что прислал мастер, — говорим об этом прямо,
  // иначе выдача по «гранатке» выглядит как ошибка бота.
  const hint = resolvedQuery ? `🔎 Искал как «${escapeHtml(resolvedQuery)}».\n` : ''
  const shown = parts.slice(0, MAX_PART_BUTTONS)
  const overflow =
    parts.length > shown.length
      ? `\nПоказаны первые ${shown.length} — уточните запрос, чтобы сузить список.`
      : ''
  return {
    text: `${hint}Найдено запчастей: ${parts.length}. Выберите нужную:${overflow}`,
    keyboard: {
      inline_keyboard: shown.map((part) => [
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

export function offersMessage(
  oemNumber: string,
  picks: TierPick[],
  offers: Offer[],
  source?: DataSource,
): string {
  const lines = [`📦 OEM <code>${escapeHtml(oemNumber)}</code>`, '']

  if (picks.length === 0) {
    lines.push('Предложений не найдено.')
    return lines.join('\n')
  }

  // Поставщики не подключены — цены сгенерированы. Мастер не должен звонить
  // клиенту с выдуманной суммой, поэтому предупреждение стоит первым.
  if (source?.demo) {
    lines.push('⚠️ <b>Демо-цены.</b> Поставщики ещё не подключены — цены и сроки условные.', '')
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

/**
 * Сообщение «что пора менять». Показываем просроченное и ближайшее; позиции с
 * большим запасом опускаем — простыня из двенадцати строк не читается в чате.
 * Названия кликабельны как обычный запрос: они канонические, поиск их понимает.
 */
export function serviceIntervalsMessage(mileageKm: number, statuses: IntervalStatus[]): string {
  if (statuses.length === 0) {
    return 'Не смог посчитать регламент по этим данным. Проверьте пробег.'
  }

  const { overdue, soon } = selectServiceAlerts(statuses)
  const lines = [`🔧 <b>Регламент ТО</b> на пробеге ${formatKm(mileageKm)}`, '']

  if (overdue.length > 0) {
    lines.push('<b>Просрочено:</b>')
    for (const status of overdue) {
      lines.push(`• ${escapeHtml(status.title)} — на ${formatKm(-status.kmRemaining)} назад`)
    }
    lines.push('')
  }

  if (soon.length > 0) {
    lines.push('<b>Скоро:</b>')
    for (const status of soon) {
      lines.push(`• ${escapeHtml(status.title)} — через ${formatKm(status.kmRemaining)}`)
    }
    lines.push('')
  }

  if (overdue.length === 0 && soon.length === 0) {
    const nearest = [...statuses].sort((a, b) => a.kmRemaining - b.kmRemaining)[0]!
    lines.push(
      `Ничего срочного. Ближайшее — ${escapeHtml(nearest.title)} через ${formatKm(nearest.kmRemaining)}.`,
      '',
    )
  }

  lines.push('Пришлите название позиции — подберу артикулы под вашу машину.')
  return lines.join('\n')
}

function formatKm(km: number): string {
  return `${Math.round(km).toLocaleString('ru-RU')} км`
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}
