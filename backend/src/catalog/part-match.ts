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
 * Насколько близко название УЗЛА должно подойти к запросу, чтобы по нему
 * вообще искали деталь. Ниже порога — узел не о том, что спрашивали.
 *
 * Живьём на Chery подсказка справочника на «тормозные» отдавала «Насос
 * вакуумный тормозной системы» (0.083), и мастер получал насос вместо честного
 * «не найдено». Порог стоит с запасом ниже нужных узлов: «Головка блока
 * цилиндров» по запросу «блок цилиндров» — 0.333, «Фара головного света» по
 * «фара» — 0.667, а чужие «Реле противотуманной фары» (0.167) и сам насос
 * остаются снаружи.
 */
export const NODE_MATCH = 0.2

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
  const head = catalogHeadWord(name) ?? headWord(words)
  let best = 0
  for (const candidate of names) {
    best = Math.max(best, similarity(head, keys, candidate))
  }
  return best
}

/**
 * Служебные слова, с которых каталог начинает название, не назвав саму деталь:
 * «1 set of brake pads for disk brake» (VW/Audi), «KIT, DISC BRAKE» (Toyota),
 * «Комплект тормозных колодок». Деталь здесь — не «1» и не «комплект».
 */
const HEAD_SKIP = new Set([
  'set', 'of', 'for', 'and', 'the', 'with', 'kit', 'sub', 'assy', 'assem', 'компл', 'набор', 'пара',
])

/**
 * Главное слово английского названия в формате каталога «ИМЯ УТОЧНЕНИЕ,
 * ПОДРОБНОСТИ» — «PAD KIT-FRONT DISK BRAKE» (Subaru), «PAD KIT, DISC BRAKE,
 * FRONT» (Toyota), «COVER SUB-ASSY, CYLINDER HEAD» (Lexus). Название детали
 * стоит до первого разделителя, и в нём, по английской грамматике, главное
 * слово ПОСЛЕДНЕЕ: «PAD CLIP» — клипса колодки, а не колодка.
 *
 * Живьём 22.09.2026 на Subaru первой строкой по «колодки передние» шла «PAD
 * CLIP-FRONT BRAKE»: главным словом бралось первое, «pad», и короткая клипса
 * обгоняла сам комплект по доле общих слов.
 *
 * Русские названия и названия без разделителя («1 set of brake pads for disk
 * brake») сюда не идут — у них главным остаётся первое значащее слово.
 * undefined — правило к названию неприменимо.
 */
function catalogHeadWord(name: string): string | undefined {
  if (/[а-яё]/i.test(name)) return undefined
  const cut = name.search(/[,(]|(?<=[a-z0-9])-(?=[a-z0-9])/i)
  if (cut <= 0) return undefined
  const words = wordList(name.slice(0, cut))
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const word = words[i]!
    if (/^[0-9]+$/.test(word) || HEAD_SKIP.has(word)) continue
    return word
  }
  return undefined
}

/**
 * Главное слово названия — первое значащее. Живьём на переднем тормозе Audi
 * колодки приходят как «1 set of brake pads for disk brake»: главным словом
 * оказывалась цифра «1», совпадения не было ни с чем, и мастер получал первой
 * строкой «caliper without brake pads» — суппорт, у которого колодки только
 * упомянуты.
 */
function headWord(words: string[]): string | undefined {
  for (const word of words) {
    if (/^[0-9]+$/.test(word) || HEAD_SKIP.has(word)) continue
    return word
  }
  return words[0]
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
 *
 * Главное слово выбирает headWord: служебное начало («1 set of…», «KIT,…»)
 * деталь не называет.
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
 * Слова строки по порядку, огрублённые до общего вида: сперва снимается
 * падежное окончание, затем остаётся пятибуквенное начало. Порядок важен —
 * первое слово несёт саму деталь.
 */
function wordList(value: string): string[] {
  return value
    .toLowerCase()
    .replaceAll('ё', 'е')
    .split(/[^a-zа-я0-9]+/)
    .filter(Boolean)
    .map(normalizeWord)
}

/**
 * Падежные и родовые окончания русского слова. Порядок — от длинных к
 * коротким: у «цилиндров» снимается «ов», а не «в».
 */
const RU_ENDINGS = [
  'ами', 'ями', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими',
  'ах', 'ях', 'ам', 'ям', 'ов', 'ев', 'ей', 'ой', 'ый', 'ий', 'ая', 'яя',
  'ое', 'ее', 'ые', 'ие', 'ым', 'им', 'ом', 'ем', 'ых', 'их', 'ую', 'юю',
  'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'ь',
]

/** Сколько букв должно остаться от слова: «на» и «ось» не обрезаются. */
const MIN_STEM = 3

/**
 * Слово к виду, в котором его можно сравнивать.
 *
 * Обрезки до пяти букв не хватало в обе стороны. По-русски она разводила
 * короткое слово с его же падежом: «блок» и «блока» оставались разными, и
 * нужный узел «Головка блока цилиндров» весил не больше случайного соседа —
 * развести чужой узел и нужный порогом было нечем. По-латински она, наоборот,
 * не убирала множественное число: «pads» и «pad» не сходились, и колодки не
 * узнавались по английскому ряду.
 *
 * Поэтому сперва снимается окончание, и лишь затем остаётся пятибуквенное
 * начало: «тормозной» и «тормозные» сходятся на «тормо», «колесо» и «колено»
 * остаются разными.
 */
function normalizeWord(word: string): string {
  return trimEnding(word).slice(0, 5)
}

function trimEnding(word: string): string {
  if (/^[a-z]+$/.test(word)) {
    return word.length >= 4 && word.endsWith('s') ? word.slice(0, -1) : word
  }
  for (const ending of RU_ENDINGS) {
    if (word.length - ending.length >= MIN_STEM && word.endsWith(ending)) {
      return word.slice(0, -ending.length)
    }
  }
  return word
}

export function wordKeys(value: string): Set<string> {
  return new Set(wordList(value))
}
