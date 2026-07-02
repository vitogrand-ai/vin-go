import type { Money, OfferTier } from '@web-app-demo/contracts'

const rubFormatter = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 0,
})

/** Форматирует денежную сумму (в копейках) в строку вида «1 200 ₽». */
export function formatMoney(money: Money): string {
  if (money.currency === 'RUB') {
    return rubFormatter.format(money.amount / 100)
  }
  return `${(money.amount / 100).toLocaleString('ru-RU')} ${money.currency}`
}

export const TIER_META: Record<OfferTier, { label: string; hint: string }> = {
  ECONOMY: { label: 'Эконом', hint: 'Дешевле всего' },
  BALANCED: { label: 'Оптимальный', hint: 'Цена и качество' },
  ORIGINAL: { label: 'Оригинал', hint: 'Деталь производителя' },
}

/** Срок поставки в человекочитаемом виде. */
export function formatDelivery(days: number): string {
  if (days <= 0) return 'Сегодня'
  if (days === 1) return 'Завтра'
  return `${days} дн.`
}
