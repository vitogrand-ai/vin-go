import { z } from 'zod'

/**
 * Наценка автосервиса на закупочную цену запчасти.
 *
 * Хранится в базисных пунктах (10000 = 100%, 2050 = 20,5%) целым числом — как и
 * деньги в копейках — чтобы бэкенд, веб и бот считали одинаково и без дробей.
 * Потолок 1000% (100 000 bps): выше — почти наверняка опечатка в форме.
 */
export const markupBpsSchema = z.number().int().min(0).max(100_000)

/** Закупочная цена × наценка → цена для клиента. Копейки, округление до копейки. */
export function applyMarkup(amount: number, markupBps: number): number {
  return Math.round((amount * (10_000 + markupBps)) / 10_000)
}

/** Проценты из формы → базисные пункты (20.5 → 2050). */
export function percentToBps(percent: number): number {
  return Math.round(percent * 100)
}

/** Базисные пункты → проценты для отображения (2050 → 20.5). */
export function bpsToPercent(bps: number): number {
  return bps / 100
}

/** Фактическая наценка по паре закуп/продажа в процентах (для сводки по марже). */
export function marginPercent(purchase: number, sale: number): number {
  if (purchase <= 0) return 0
  return Math.round(((sale - purchase) / purchase) * 1000) / 10
}
