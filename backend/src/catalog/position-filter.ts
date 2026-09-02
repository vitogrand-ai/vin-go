import type { Part } from '@web-app-demo/contracts'

/**
 * Фильтр выдачи по позиции детали: «колодки передние» не должны приносить
 * «Brake-pad sensor, rear». Каталоги теряют уточнение позиции при нечётком
 * поиске (а RU→ZH-словарь 17vin переводит только сам термин), поэтому
 * уточнение применяется к УЖЕ полученной выдаче: детали, явно помеченные
 * противоположной позицией, отбрасываются; непомеченные остаются — у части
 * деталей позиция в названии не указана, и выкидывать их нельзя.
 *
 * Слой живёт в CatalogService (после провайдеров): работает одинаково для
 * веба, бота и мобильного и для любого источника — названия могут быть
 * русскими (после перевода), английскими (17vin/TecDoc) или китайскими.
 */

type Axis = {
  /** Позиция распознаётся в запросе пользователя по токенам. */
  sides: [SideMatcher, SideMatcher]
}

type SideMatcher = {
  /** Токен запроса/названия целиком: «передние», «front». */
  token: RegExp
  /** Иероглифы позиции — ищутся подстрокой (китайские названия без пробелов). */
  zh: RegExp | null
}

// «перед(н…)»/«зад(н…)» — но не «передача» и не «задача»: после корня либо
// конец слова, либо «н» (передний/задний во всех формах). `\w` не годится —
// в JS это только ASCII, кириллические окончания им не матчатся.
const FRONT: SideMatcher = { token: /^(перед(н\p{L}*)?|front)$/u, zh: /前/ }
const REAR: SideMatcher = { token: /^(зад(н\p{L}*)?|rear)$/u, zh: /后|後/ }
const LEFT: SideMatcher = { token: /^(лев\p{L}*|left)$/u, zh: /左/ }
const RIGHT: SideMatcher = { token: /^(прав\p{L}*|right)$/u, zh: /右/ }

const AXES: Axis[] = [
  { sides: [FRONT, REAR] },
  { sides: [LEFT, RIGHT] },
]

const TOKEN_RE = /[\p{L}\p{N}_-]+/gu

function mentions(text: string, side: SideMatcher): boolean {
  const lowered = text.toLowerCase()
  if (side.zh && side.zh.test(lowered)) return true
  for (const token of lowered.match(TOKEN_RE) ?? []) {
    if (side.token.test(token)) return true
  }
  return false
}

/**
 * Оставляет детали, не противоречащие позиции из запроса. Для каждой оси
 * (перед/зад, лево/право), где запрос называет ровно одну сторону, деталь
 * отбрасывается, только если её название/категория упоминает противоположную
 * сторону и не упоминает нужную (комплект «front and rear» остаётся).
 */
export function filterByPosition(parts: Part[], query: string): Part[] {
  let result = parts
  for (const axis of AXES) {
    const [a, b] = axis.sides
    const wantsA = mentions(query, a)
    const wantsB = mentions(query, b)
    if (wantsA === wantsB) continue // позиция не указана или указаны обе

    const wanted = wantsA ? a : b
    const opposite = wantsA ? b : a
    result = result.filter((part) => {
      const text = `${part.name} ${part.category}`
      return !mentions(text, opposite) || mentions(text, wanted)
    })
  }
  return result
}
