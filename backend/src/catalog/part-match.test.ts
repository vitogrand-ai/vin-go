/**
 * Мера близости названия к запросу — общая для выбора детали в узле,
 * ранжирования подсказок и порядка выдачи. Названия в тестах живые: так их
 * пишут каталоги на машинах пилота.
 */
import { describe, expect, it } from 'bun:test'

import { closeness, queryNames, queryNamesForOrder, NAME_MATCH } from './part-match'

/** Какое из названий продукт поставит первым по запросу мастера. */
function first(query: string, names: string[]): string {
  const order = queryNamesForOrder(query)
  return [...names].sort((a, b) => closeness(b, order) - closeness(a, order))[0]!
}

describe('порядок выдачи', () => {
  it('колодки идут вперёд суппорта, у которого они лишь упомянуты', () => {
    // Живьём (17vin, VW/Audi китайской сборки): узел переднего тормоза отдаёт
    // и сам суппорт, и колодки. Мастер жмёт первую кнопку.
    expect(
      first('колодки тормозные передние', [
        'caliper without brake pads',
        'sender wire (pad wear indicator)',
        '1 set of brake pads for disk brake',
      ]),
    ).toBe('1 set of brake pads for disk brake')
  })

  it('множественное число латиницей не меняет узнавания детали', () => {
    // Обрезка до пяти букв огрубляет русскую морфологию, латинскую — нет:
    // «pads» и «pad» должны весить одинаково, иначе колодки теряются.
    const order = queryNamesForOrder('колодки передние')
    expect(closeness('brake pads', order)).toBe(closeness('brake pad', order))
    expect(closeness('1 set of brake pads for disk brake', order)).toBeGreaterThan(
      closeness('caliper without brake pads', order),
    )
  })

  it('крышка идёт вперёд своего болта (Lexus, оригинальные названия)', () => {
    expect(
      first('крышка гбц', [
        'BOLT(FOR CYLINDER HEAD COVER)',
        'COVER SUB-ASSY, CYLINDER HEAD',
        'GASKET, CYLINDER HEAD COVER',
      ]),
    ).toBe('COVER SUB-ASSY, CYLINDER HEAD')
  })

  it('крышка идёт вперёд соседей по узлу (Citroen, русские названия)', () => {
    expect(
      first('клапанная крышка', [
        'ШАЙБА БОЛТА ГОЛОВКИ ЦИЛИНДРОВ',
        'КРЫШКА ГОЛОВКИ ЦИЛИНДРОВ',
        'ПРОБКА ЗАЛИВА МАСЛА',
      ]),
    ).toBe('КРЫШКА ГОЛОВКИ ЦИЛИНДРОВ')
  })

  it('уточнение в названии не отдаёт первое место короткому чужому соседу', () => {
    const order = queryNamesForOrder('генератор')
    expect(closeness('Генератор', order)).toBeGreaterThan(closeness('Подшипник генератора', order))
  })
})

describe('отбор детали в узле', () => {
  it('сама деталь проходит порог, сосед по узлу — нет', () => {
    const names = queryNames('клапанная крышка')
    expect(closeness('КРЫШКА ГОЛОВКИ ЦИЛИНДРОВ', names)).toBeGreaterThanOrEqual(NAME_MATCH)
    expect(closeness('ШАЙБА БОЛТА ГОЛОВКИ ЦИЛИНДРОВ', names)).toBeLessThan(NAME_MATCH)
    expect(closeness('ПРОКЛАДКА КРЫШКИ ГОЛОВКИ ЦИЛИНДРОВ', names)).toBeLessThan(NAME_MATCH)
  })

  it('комплект колодок — это колодки, а не отдельная сущность', () => {
    // Subaru зовёт передние колодки «Колодки тормозные (ремкомплект)»,
    // Toyota — «PAD KIT, DISC BRAKE».
    const names = queryNames('колодки передние')
    expect(closeness('Колодки тормозные (ремкомплект)', names)).toBeGreaterThanOrEqual(NAME_MATCH)
  })
})
