import {
  partsWithVariants,
  type DataSource,
  type DealerPrice,
  type Money,
  type Offer,
  type OrderDto,
  type Part,
  type SavedVehicle,
  type TierPick,
  type Vehicle,
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

/**
 * Карточка машины. `switched` — в чате уже была другая машина: граница между
 * двумя подборами должна быть видна в ленте, иначе кнопки и схема прошлой
 * машины выглядят продолжением разговора.
 */
export function formatVehicle(vehicle: Vehicle, options?: { switched?: boolean }): string {
  const lines = options?.switched
    ? ['🔄 <b>Другая машина</b> — прежний подбор закрыт.', '']
    : []
  lines.push(
    `🚗 <b>${escapeHtml(vehicle.make)} ${escapeHtml(vehicle.model)}</b>`,
    `VIN: <code>${escapeHtml(vehicle.vin)}</code>`,
  )
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
  options?: { hasScheme?: boolean },
): { text: string; keyboard: InlineKeyboard } {
  // Если искали не тем словом, что прислал мастер, — говорим об этом прямо,
  // иначе выдача по «гранатке» выглядит как ошибка бота.
  const hint = resolvedQuery ? `🔎 Искал как «${escapeHtml(resolvedQuery)}».\n` : ''
  const shown = parts.slice(0, MAX_PART_BUTTONS)
  const overflow =
    parts.length > shown.length
      ? `\nПоказаны первые ${shown.length} — уточните запрос, чтобы сузить список.`
      : ''
  const partButtons = shown.map((part) => [
    {
      text: truncate(`${part.name} (${part.oemNumber})`, 60),
      callback_data: `oem:${part.oemNumber}`,
    },
  ])
  // Схема приходит сжатым фото: номера позиций на ней читаются плохо. Кнопка
  // присылает ту же схему файлом — Telegram документы не пережимает.
  const schemeButton = options?.hasScheme
    ? [[{ text: '🔍 Схема крупнее', callback_data: 'scheme' }]]
    : []
  // Половины деталей узла в списке нет — они не отвечают запросу. Но на схеме
  // они подписаны номерами, и номер работает как выбор детали.
  const byNumber = options?.hasScheme
    ? '\nНужной детали нет в списке? Пришлите её <b>номер со схемы</b> — например <code>9</code>.'
    : ''

  return {
    text: `${hint}Найдено запчастей: ${parts.length}. Выберите нужную:${overflow}${variantLines(shown)}${byNumber}`,
    keyboard: { inline_keyboard: [...partButtons, ...schemeButton] },
  }
}

/**
 * Исполнения одной позиции — с различием прямо в выдаче.
 *
 * Кнопки у них одинаковые («Батарея аккумуляторная» ×5 у Ford Mondeo), и без
 * примечания каталога мастер выбирает вслепую. Выбор тут делается не по VIN,
 * а по тому, что стоит на машине, — поэтому и подсказка, с чем сверять. Номер
 * идёт первым: по нему строка сопоставляется с кнопкой.
 */
function variantLines(parts: Part[]): string {
  const variants = partsWithVariants(parts)
  if (variants.size === 0) return ''

  const lines = parts
    .filter((part) => variants.has(part.oemNumber))
    .map((part) => {
      const about = [part.note, part.appliesPeriod].filter(Boolean).join(' · ')
      const text = about ? truncate(about, MAX_VARIANT_NOTE) : 'каталог не указал, чем отличается'
      return `• <code>${escapeHtml(part.oemNumber)}</code> — ${escapeHtml(text)}`
    })
  return (
    '\n\nОдна позиция в нескольких исполнениях — <b>сверьте с тем, что стоит на машине</b> ' +
    '(маркировка на детали):\n' +
    lines.join('\n') +
    // Отбивка до подсказки про номер со схемы — иначе она читается как ещё одно исполнение.
    '\n'
  )
}

/**
 * Потолок примечания в строке исполнения: 20 строк выдачи должны уложиться в
 * лимит сообщения Telegram (4096 символов) вместе с остальным текстом.
 */
const MAX_VARIANT_NOTE = 150

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
    // Сквозной номер — тот же, что в кабинете и в смете: по нему заказ ищут.
    lines.push(`№ ${order.number} — ${ORDER_STATUS_LABEL[order.status]} — ${formatMoney(order.total)}`)
  }
  return lines.join('\n')
}

/**
 * Что каталог рассказал о детали сверх номера. Приходит из сессии бота, где
 * лежит с момента выдачи поиска.
 */
export type PartDetails = {
  name: string
  quantity?: number | null
  replacedBy?: string | null
  note?: string | null
  appliesPeriod?: string | null
}

/**
 * Шапка карточки детали: название и то, что мастеру нужно знать ДО заказа.
 *
 * Замена номера идёт первой строкой и с предупреждением: заказ по старому
 * номеру у поставщиков просто не найдётся. Количество важно не меньше —
 * прокладок на узле две, болтов четыре, а мастер закажет одну штуку.
 */
function partDetailLines(part?: PartDetails): string[] {
  if (!part) return []

  const lines = [`<b>${escapeHtml(part.name)}</b>`]
  if (part.replacedBy) {
    lines.push(`🔁 Заменён на <code>${escapeHtml(part.replacedBy)}</code> — заказывать новый номер.`)
  }
  if (part.quantity && part.quantity > 1) lines.push(`🔢 На машине: ${part.quantity} шт.`)
  if (part.note) lines.push(`📝 ${escapeHtml(part.note)}`)
  if (part.appliesPeriod) lines.push(`📅 Ставилась: ${escapeHtml(part.appliesPeriod)}`)
  return lines
}

/**
 * Цена оригинала у дилеров — ориентир, а не предложение. Рынок называется
 * прямо: цена китайских дилеров, в юанях; приёмщик в РФ не должен принять её
 * за цену, по которой можно купить.
 */
function dealerPriceLine(price?: DealerPrice | null): string[] {
  if (!price) return []
  const range =
    price.min === price.max
      ? formatYuan(price.min)
      : `${formatYuan(price.min)}–${formatYuan(price.max)}`
  return [`🏷 Оригинал у дилеров в Китае: ${range} ¥ — ориентир, не цена покупки.`]
}

/** Фэни → юани: «438», «345,82». */
function formatYuan(fen: number): string {
  const yuan = fen / 100
  return Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2).replace('.', ',')
}

export function offersMessage(
  oemNumber: string,
  picks: TierPick[],
  offers: Offer[],
  source?: DataSource,
  part?: PartDetails,
  dealerPrice?: DealerPrice | null,
): string {
  const lines = [`📦 OEM <code>${escapeHtml(oemNumber)}</code>`, ...partDetailLines(part), '']

  if (picks.length === 0) {
    // Поставщики молчат — ориентир по цене оригинала тем ценнее.
    lines.push('Предложений не найдено.', ...dealerPriceLine(dealerPrice))
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

  lines.push(...dealerPriceLine(dealerPrice))
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

/**
 * Шаг по дереву узлов каталога. Путь показан целиком: после трёх нажатий
 * мастер должен видеть, где он, — «Двигатель › Привод ремённый навесных агрегатов».
 */
export function treeMessage(path: string | null): string {
  return path
    ? `📂 <b>${escapeHtml(path)}</b>\nВыберите узел:`
    : '📂 <b>Узлы каталога</b>\nВыберите, где стоит деталь, — дойдём до схемы, и по ней назовёте номер детали.'
}

/** Узлы дерева кнопками по одной в строке (длинные названия каталога в две колонки не влезают). */
export function treeKeyboard(names: string[], canGoUp: boolean): InlineKeyboard {
  return {
    inline_keyboard: [
      ...names.map((name, index) => [{ text: name, callback_data: `tree:${index}` }]),
      ...(canGoUp ? [[{ text: '⬅️ Назад', callback_data: 'tree:up' }]] : []),
    ],
  }
}

export function branchSchemesMessage(leafName: string): string {
  return `📂 <b>${escapeHtml(leafName)}</b>\nВыберите схему:`
}

export function branchSchemesKeyboard(names: string[]): InlineKeyboard {
  return {
    inline_keyboard: [
      ...names.map((name, index) => [{ text: name || `Схема ${index + 1}`, callback_data: `sch:${index}` }]),
      [{ text: '⬅️ Назад', callback_data: 'tree:here' }],
    ],
  }
}

/** Подпись к схеме из дерева: дальше мастер присылает номер выноски. */
export function branchSchemeMessage(
  schemeName: string,
  hasImage: boolean,
): { text: string; keyboard: InlineKeyboard } {
  return {
    text:
      `🔧 <b>${escapeHtml(schemeName)}</b>\n` +
      'Пришлите номер детали с картинки — покажу её каталожный номер и цены.',
    keyboard: {
      inline_keyboard: [
        ...(hasImage ? [[{ text: '🔍 Схема крупнее', callback_data: 'scheme' }]] : []),
        [{ text: '⬅️ К узлам', callback_data: 'tree:here' }],
      ],
    },
  }
}
