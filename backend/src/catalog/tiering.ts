import type { Offer, PartQuality, TierPick } from '@web-app-demo/contracts'

/**
 * Раскладка предложений по тирам: Эконом / Оптимальный / Оригинал.
 *
 * Это ядро продукта: автосервис должен сразу видеть три осмысленных варианта,
 * а не голый список. Функция чистая и детерминированная — легко тестируется.
 */

const QUALITY_WEIGHT: Record<PartQuality, number> = {
  BUDGET: 1,
  AFTERMARKET: 2,
  PREMIUM: 3,
  OEM: 4,
}

/** Сравнение для «дешевле и быстрее»: цена по возрастанию, при равной — срок. */
function byPriceThenDelivery(a: Offer, b: Offer): number {
  if (a.price.amount !== b.price.amount) return a.price.amount - b.price.amount
  return a.deliveryDays - b.deliveryDays
}

/** Самое дешёвое предложение; при наличии складских — только из них. */
function cheapest(offers: Offer[]): Offer | null {
  if (offers.length === 0) return null
  const inStock = offers.filter((offer) => offer.inStock)
  const pool = inStock.length > 0 ? inStock : offers
  return [...pool].sort(byPriceThenDelivery)[0] ?? null
}

/** Оценка «цена/качество»: вес качества на рубль. Чем выше — тем выгоднее. */
function valueScore(offer: Offer): number {
  const rub = offer.price.amount / 100
  if (rub <= 0) return 0
  return QUALITY_WEIGHT[offer.quality] / rub
}

/**
 * Выбирает по одному предложению на тир. Тиры без кандидатов пропускаются.
 * Порядок результата: ECONOMY, BALANCED, ORIGINAL.
 */
export function selectTiers(offers: Offer[]): TierPick[] {
  const picks: TierPick[] = []

  const original = offers.filter((offer) => offer.isOriginal)
  const aftermarket = offers.filter((offer) => !offer.isOriginal)

  // Эконом — самый доступный неоригинальный вариант.
  const economy = cheapest(aftermarket)
  if (economy) {
    picks.push({
      tier: 'ECONOMY',
      offer: economy,
      reason: 'Самый доступный вариант',
    })
  }

  // Оптимальный — лучшее соотношение цены и качества среди неоригинальных,
  // по возможности отличное от эконом-выбора и в наличии.
  const balancedPool = aftermarket.filter((offer) => offer.inStock)
  const balancedCandidates = (balancedPool.length > 0 ? balancedPool : aftermarket)
    .slice()
    .sort((a, b) => valueScore(b) - valueScore(a))
  const balanced =
    balancedCandidates.find((offer) => offer.id !== economy?.id) ?? balancedCandidates[0] ?? null
  if (balanced) {
    picks.push({
      tier: 'BALANCED',
      offer: balanced,
      reason: 'Оптимальное соотношение цены и качества',
    })
  }

  // Оригинал — деталь производителя автомобиля.
  const originalPick = cheapest(original)
  if (originalPick) {
    picks.push({
      tier: 'ORIGINAL',
      offer: originalPick,
      reason: 'Оригинальная деталь производителя',
    })
  }

  return picks
}
