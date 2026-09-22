/**
 * Мера близости названия к запросу — общая для выбора детали в узле,
 * ранжирования подсказок и порядка выдачи. Названия в тестах живые: так их
 * пишут каталоги на машинах пилота.
 */
import { describe, expect, it } from 'bun:test'

import { closeness, queryNames, queryNamesForOrder, NAME_MATCH, NODE_MATCH } from './part-match'

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

  it('падежи русского названия не мешают узнать деталь', () => {
    // Живьём: подсказка на «блок цилиндров» отдаёт «Головка блока цилиндров»,
    // и слово «блока» должно считаться тем же «блоком», иначе нужный узел
    // весит не больше случайного соседа.
    const names = queryNames('блок цилиндров')
    expect(closeness('Головка блока цилиндров', names)).toBeGreaterThan(
      closeness('Прокладка передней крышки блока цилиндров', names),
    )
    expect(closeness('Блок цилиндров', names)).toBeGreaterThan(closeness('Головка блока цилиндров', names))
  })

  it('порог узла отделяет чужой узел от нужного', () => {
    // «Насос вакуумный тормозной системы» приходил мастеру на «колодки
    // передние» вместо честного «не найдено». Развести их можно только
    // порогом, а порог держится, лишь когда между ними есть зазор: раньше у
    // насоса было 0.083, у нужной «Головки блока цилиндров» — 0.125.
    expect(closeness('Насос вакуумный тормозной системы', queryNames('колодки передние'))).toBeLessThan(
      NODE_MATCH,
    )
    expect(closeness('Реле противотуманной фары', queryNames('фара'))).toBeLessThan(NODE_MATCH)

    // Узлы, которые обязаны пережить порог: по ним живьём находят деталь.
    expect(closeness('Головка блока цилиндров', queryNames('блок цилиндров'))).toBeGreaterThanOrEqual(
      NODE_MATCH,
    )
    expect(closeness('Колодки тормозные дисковые', queryNames('колодки передние'))).toBeGreaterThanOrEqual(
      NODE_MATCH,
    )
    expect(closeness('Фара головного света', queryNames('фара'))).toBeGreaterThanOrEqual(NODE_MATCH)
    // Справочник бывает и английским — там узел узнаётся по терминам запроса.
    expect(
      closeness('COVER SUB-ASSY, CYLINDER HEAD', queryNamesForOrder('крышка гбц')),
    ).toBeGreaterThanOrEqual(NODE_MATCH)
  })

  it('комплект колодок идёт вперёд их клипсы (Subaru, «ИМЯ УТОЧНЕНИЕ-ПОДРОБНОСТИ»)', () => {
    // Живьём 22.09.2026: на «колодки передние» первой строкой шла «PAD
    // CLIP-FRONT BRAKE». Главным словом бралось первое — «pad», и короткая
    // клипса обгоняла комплект по доле общих слов. В английском главное слово
    // последнее: «PAD CLIP» — клипса, «PAD KIT» — колодки (kit — служебное).
    expect(
      first('колодки передние', ['PAD CLIP-FRONT BRAKE', 'PAD KIT-FRONT DISK BRAKE']),
    ).toBe('PAD KIT-FRONT DISK BRAKE')
    // Тот же формат у Toyota — через запятую.
    expect(
      first('колодки передние', ['CLIP, PAD SUPPORT PLATE', 'PAD KIT, DISC BRAKE, FRONT']),
    ).toBe('PAD KIT, DISC BRAKE, FRONT')
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
