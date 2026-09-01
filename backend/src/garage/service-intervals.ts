/**
 * Регламент ТО: что подходит к замене на текущем пробеге.
 *
 * Зачем продукту: мастер спрашивает не только «дай колодки», но и «что вообще
 * пора менять на 145 тысячах». Ответ на это — готовая корзина расходников,
 * то есть заказ, которого иначе не было бы. В прототипе VINGO
 * (`bot/services/service_intervals.py`) это была одна из причин возвращаться в бота.
 *
 * Регламент намеренно усреднённый: точные интервалы зависят от модели, мотора
 * и условий эксплуатации, а таких данных у нас пока нет. Он подсказывает, а не
 * предписывает — поэтому названия совпадают с каноническими терминами каталога
 * (см. `part-jargon.ts`), и по ним сразу можно искать деталь.
 */

export type ServiceItem = {
  /** Периодичность замены, км. */
  intervalKm: number
  /** Название — каноническое, чтобы по нему сразу искался артикул. */
  title: string
  category: ServiceCategory
}

export type ServiceCategory = 'fluids' | 'filters' | 'ignition' | 'belts'

/** Усреднённый регламент для легкового автомобиля. */
export const SERVICE_REGULATIONS: readonly ServiceItem[] = [
  { intervalKm: 10_000, title: 'Моторное масло', category: 'fluids' },
  { intervalKm: 10_000, title: 'Фильтр масляный', category: 'filters' },
  { intervalKm: 30_000, title: 'Фильтр воздушный', category: 'filters' },
  { intervalKm: 30_000, title: 'Фильтр салонный', category: 'filters' },
  { intervalKm: 30_000, title: 'Фильтр топливный', category: 'filters' },
  { intervalKm: 60_000, title: 'Свечи зажигания', category: 'ignition' },
  { intervalKm: 60_000, title: 'Тормозная жидкость', category: 'fluids' },
  { intervalKm: 60_000, title: 'Жидкость ГУР', category: 'fluids' },
  { intervalKm: 90_000, title: 'Антифриз', category: 'fluids' },
  { intervalKm: 90_000, title: 'Ремень приводной', category: 'belts' },
  { intervalKm: 120_000, title: 'Ремень ГРМ', category: 'belts' },
  { intervalKm: 120_000, title: 'Масло коробки', category: 'fluids' },
]

export type IntervalStatus = {
  title: string
  category: ServiceCategory
  intervalKm: number
  /** Пробег, на котором положена следующая замена. */
  dueAtKm: number
  /** Сколько осталось; отрицательное — просрочено. */
  kmRemaining: number
  isOverdue: boolean
  isSoon: boolean
}

/**
 * «Скоро» — не ближе чем за 1500 км и не больше 15% интервала. Для масла
 * (10 000 км) это 1500 км, для ремня ГРМ (120 000) — тоже 1500, а не 18 000:
 * предупреждать за 18 тысяч бессмысленно, мастер забудет.
 */
function soonThresholdKm(intervalKm: number): number {
  return Math.min(1500, Math.trunc(intervalKm * 0.15))
}

/**
 * Ближайшие точки ТО для текущего пробега.
 *
 * @param mileageKm текущий пробег
 * @param lastServiceKm пробег, на котором делали последнее ТО, если известен
 *
 * Считается по-разному, и это принципиально:
 *
 * • Пробег последнего ТО ИЗВЕСТЕН — следующая замена положена через интервал
 *   после него, и если этот рубеж уже позади, позиция просрочена. Только так
 *   слово «просрочено» означает то, что означает.
 *
 * • НЕИЗВЕСТЕН — берётся ближайшая точка регламентной сетки (кратная интервалу),
 *   и ничего не объявляется просроченным: мы не знаем, что и когда меняли,
 *   а пугать мастера выдуманной просрочкой нельзя.
 *
 * (В прототипе VINGO был только второй режим, из-за чего признак просрочки
 * никогда не срабатывал: следующая точка сетки всегда впереди пробега.)
 *
 * Возвращает пустой список, если данных недостаточно для честного ответа:
 * отрицательный пробег или «последнее ТО» больше текущего пробега (скрученный
 * одометр либо опечатка). Промолчать здесь лучше, чем выдумать.
 */
export function computeServiceIntervals(
  mileageKm: number,
  lastServiceKm?: number,
): IntervalStatus[] {
  if (!Number.isFinite(mileageKm) || mileageKm < 0) return []
  if (lastServiceKm !== undefined) {
    if (!Number.isFinite(lastServiceKm) || lastServiceKm < 0 || lastServiceKm > mileageKm) {
      return []
    }
  }

  return SERVICE_REGULATIONS.map((item) => {
    const dueAtKm =
      lastServiceKm === undefined
        ? (Math.floor(mileageKm / item.intervalKm) + 1) * item.intervalKm
        : lastServiceKm + item.intervalKm
    const kmRemaining = dueAtKm - mileageKm

    return {
      title: item.title,
      category: item.category,
      intervalKm: item.intervalKm,
      dueAtKm,
      kmRemaining,
      isOverdue: lastServiceKm !== undefined && kmRemaining <= 0,
      isSoon: kmRemaining > 0 && kmRemaining <= soonThresholdKm(item.intervalKm),
    }
  })
}

/**
 * Что показать пользователю: просроченное и то, что подходит. Позиции с большим
 * запасом отбрасываем — сообщение «всё в порядке, приходите через 8000 км»
 * пользы не несёт, а список превращает в простыню.
 */
export function selectServiceAlerts(statuses: IntervalStatus[]): {
  overdue: IntervalStatus[]
  soon: IntervalStatus[]
} {
  return {
    overdue: statuses.filter((status) => status.isOverdue),
    soon: statuses.filter((status) => status.isSoon),
  }
}
