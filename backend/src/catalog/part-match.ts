import { partSynonyms } from './part-jargon'
import { englishPartTerms } from './part-terms'

/**
 * Насколько название детали отвечает запросу мастера — одна мера на весь
 * продукт: ею провайдер отбирает детали внутри узла, ранжирует подсказки
 * справочника, а сервис выстраивает итоговую выдачу.
 *
 * Мера нужна потому, что каталоги зовут деталь своими именами и кладут её в
 * узел вместе с соседями: на «крышку ГБЦ» приходят и болты крышки, и её
 * прокладки. Отличить деталь от соседа по одному общему слову нельзя, и без
 * меры мастер получал болт первой строкой.
 */

/**
 * Насколько близко название должно подойти к имени детали, чтобы считаться ею.
 * Подобрано по живой выдаче: «КРЫШКА ГОЛОВКИ ЦИЛИНДРОВ» против «крышка головки
 * цилиндров» из словаря даёт 1.0, а соседи по узлу («ШАЙБА БОЛТА ГОЛОВКИ
 * ЦИЛИНДРОВ», «ПРОБКА ЗАЛИВА МАСЛА») не дотягивают и до половины — у них другое
 * главное слово.
 */
export const NAME_MATCH = 0.6

/**
 * Имена детали из словаря: сам запрос и его синонимический ряд. Ими адаптер
 * отбирает детали внутри узла и ранжирует подсказки справочника.
 */
export function queryNames(query: string): Set<string>[] {
  return toKeySets([query, ...partSynonyms(query)])
}

/**
 * То же плюс английские термины — для сортировки готовой выдачи.
 *
 * Английские нужны там, где каталог отдаёт оригинальные названия: у Lexus,
 * который знает только 17vin, узел приходит как «COVER SUB-ASSY, CYLINDER
 * HEAD», «BOLT(FOR CYLINDER HEAD COVER)», «GASKET, CYLINDER HEAD COVER» —
 * русскому ряду они не отвечают ничем, и сама крышка оказывалась третьей.
 *
 * В выбор УЗЛА эти термины не пускаются намеренно: они широки («pad» ловит и
 * «brake shoe»), и живьём на Jetta сдвигали поиск с дисковых передних колодок
 * на барабанные задние. Порядок готовой выдачи они улучшают, состав — портят.
 */
export function queryNamesForOrder(query: string): Set<string>[] {
  return toKeySets([query, ...partSynonyms(query), ...englishPartTerms(query)])
}

function toKeySets(names: string[]): Set<string>[] {
  return names.map(wordKeys).filter((keys) => keys.size > 0)
}

/** Насколько название подошло к ближайшему имени детали. */
export function closeness(name: string, names: Set<string>[]): number {
  const words = wordList(name)
  const keys = new Set(words)
  let best = 0
  for (const candidate of names) {
    best = Math.max(best, similarity(words[0], keys, candidate))
  }
  return best
}

/**
 * Схожесть названия с одним из имён детали.
 *
 * Каталоги пишут деталь ГЛАВНЫМ СЛОВОМ ВПЕРЁД, а уточнения — после:
 * «Подшипник генератора» — это подшипник, «Генератор озоновый» — генератор,
 * «BOLT(FOR CYLINDER HEAD COVER)» — болт, «COVER SUB-ASSY, CYLINDER HEAD» —
 * крышка. Поэтому совпадение первого слова решает: с ним схожесть лежит в
 * верхней половине шкалы, без него — в нижней, и никакой сосед по узлу не
 * обойдёт саму деталь. Внутри половины порядок задаёт доля общих слов (мера
 * Жаккара): она отделяет «Крышка ГБЦ» от «Крышка расширительного бачка
 * системы охлаждения», у которых главное слово одно.
 *
 * Одной долей общих слов обойтись нельзя: она штрафует название за каждое
 * уточнение, и короткий чужой сосед обгонял точную, но подробную деталь.
 */
function similarity(head: string | undefined, keys: Set<string>, candidate: Set<string>): number {
  let common = 0
  for (const key of candidate) {
    if (keys.has(key)) common += 1
  }
  if (common === 0) return 0
  const jaccard = common / (keys.size + candidate.size - common)
  return head !== undefined && candidate.has(head) ? (1 + jaccard) / 2 : jaccard / 2
}

/**
 * Слова строки по порядку, огрублённые до пятибуквенного начала: так «головки»
 * и «головка» считаются одним словом, и русская морфология не мешает сравнению
 * без настоящего стемминга. Порядок важен — первое слово несёт саму деталь.
 */
function wordList(value: string): string[] {
  return value
    .toLowerCase()
    .replaceAll('ё', 'е')
    .split(/[^a-zа-я0-9]+/)
    .filter(Boolean)
    .map((word) => word.slice(0, 5))
}

export function wordKeys(value: string): Set<string> {
  return new Set(wordList(value))
}
