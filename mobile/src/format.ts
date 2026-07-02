import type { Money, OfferTier } from './contracts'

/** Форматирует сумму (в копейках) в «1 200 ₽». Группировка вручную — надёжнее Intl в Hermes. */
export function formatMoney(money: Money): string {
  const rub = Math.round(money.amount / 100)
  const grouped = rub.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return money.currency === 'RUB' ? `${grouped} ₽` : `${grouped} ${money.currency}`
}

export function formatDelivery(days: number): string {
  if (days <= 0) return 'Сегодня'
  if (days === 1) return 'Завтра'
  return `${days} дн.`
}

export const TIER_META: Record<OfferTier, { label: string; hint: string; color: string }> = {
  ECONOMY: { label: 'Эконом', hint: 'Дешевле всего', color: '#10b981' },
  BALANCED: { label: 'Оптимальный', hint: 'Цена и качество', color: '#2563eb' },
  ORIGINAL: { label: 'Оригинал', hint: 'Деталь производителя', color: '#f59e0b' },
}
