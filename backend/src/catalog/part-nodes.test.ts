import { describe, expect, test } from 'bun:test'

import { PART_NODES, isNodePart, partNodeFor } from './part-nodes'

/** Код справочника, в который уходит запрос; null — запроса нет в таблице. */
function idsFor(query: string): string[] | null {
  return partNodeFor(query)?.ids ?? null
}

describe('partNodeFor: формулировки мастера → деталь каталога', () => {
  // Замер 23.09.2026: одна деталь находилась или нет в зависимости от слов.
  test('синонимы одной детали ведут в один код', () => {
    expect(idsFor('помпа')).toEqual(['130'])
    expect(idsFor('насос водяной')).toEqual(['130'])
    expect(idsFor('гранатка')).toEqual(idsFor('шрус наружный'))
    expect(idsFor('воздухан')).toEqual(idsFor('воздушный фильтр'))
    expect(idsFor('масло фильтр')).toEqual(['87'])
  })

  test('уточнённая деталь не уходит в общую («датчик коленвала» — не коленвал)', () => {
    expect(idsFor('датчик положения коленвала')).toEqual(['1074'])
    expect(idsFor('коленвал')).toEqual(['73'])
    expect(idsFor('пыльник шруса')).toEqual(['565', '5406'])
    expect(idsFor('форсунка омывателя')).toEqual(['1051', '7665'])
    expect(idsFor('форсунка')).toEqual(['1050'])
    expect(idsFor('опора амортизатора')).toEqual(['504', '642'])
    expect(idsFor('амортизатор задний')).toEqual(['23'])
    expect(idsFor('стойка стабилизатора')).toEqual(['1044'])
    expect(idsFor('моторчик стеклоочистителя')).toEqual(['1177'])
    expect(idsFor('дворники')).toEqual(['1012', '2216'])
  })

  // Живьём 23.09.2026: словарь превращал «вкладыши» во «вкладыши коренные
  // коленвала», и строка «коленвал» отдавала коленвал на восьми машинах.
  test('деталь — первое слово запроса; хвост «…коленвала» деталь не подменяет', () => {
    expect(idsFor('вкладыши коренные коленвала')).toEqual(['81', '2008'])
    expect(idsFor('шкив коленвала')).toBeNull()
    expect(idsFor('реле стартера')).toBeNull()
    expect(idsFor('подшипник генератора')).toBeNull()
    expect(idsFor('омыватель фар')).toBeNull()
    // прилагательные перед деталью не мешают
    expect(idsFor('передняя стойка')).toEqual(['23'])
    expect(idsFor('рулевой наконечник')).toEqual(['451'])
    expect(idsFor('главный цилиндр сцепления')).toEqual(['754'])
    // деталь, названная вторым словом, но строкой учтённая
    expect(idsFor('насос гур')).toEqual(['1182'])
    expect(idsFor('клапан егр')).toEqual(['1155'])
  })

  // Живьём 23.09.2026 Tucson на «колодки передние» получал барабанные — задние.
  test('передние колодки — только дисковые; просто колодки — дисковые раньше барабанных', () => {
    expect(idsFor('колодки передние')).toEqual(['289', '1109'])
    expect(idsFor('передние колодки')).toEqual(['289', '1109'])
    expect(idsFor('колодки задние')).toEqual(['289', '290', '6798', '1109'])
  })

  test('радиатор не перехватывает решётку, вентилятор и патрубок радиатора', () => {
    expect(idsFor('радиатор охлаждения')).toEqual(['1075'])
    expect(idsFor('решетка радиатора')).toEqual(['745'])
    expect(idsFor('вентилятор радиатора')).toEqual(['117'])
    expect(idsFor('патрубок радиатора')).toEqual(['1203'])
    expect(idsFor('радиатор печки')).toEqual(['1079'])
  })

  test('бачки различаются: расширительный, омывателя, тормозной', () => {
    expect(idsFor('расширительный бачок')).toEqual(['778'])
    expect(idsFor('бачок омывателя')).toEqual(['50'])
    expect(idsFor('бачок тормозной жидкости')).toEqual(['51'])
    expect(idsFor('крышка расширительного бачка')).toEqual(['407'])
  })

  test('короткие кириллические слова ловятся целиком («гур», «акб», «птф»)', () => {
    expect(idsFor('насос гур')).toEqual(['1182'])
    expect(idsFor('акб')).toEqual(['20'])
    expect(idsFor('птф')).toEqual(['187'])
    expect(idsFor('фара')).toEqual(['170'])
    // «фар» внутри другого слова — не фара
    expect(idsFor('фаркоп')).toBeNull()
  })

  test('лампа по месту: ближний свет — в фаре, стоп — в заднем фонаре', () => {
    const head = partNodeFor('лампа ближнего света')!
    expect(head.ids).toEqual(['1384'])
    expect(head.leaves[0]).toContain('> фара')
    expect(partNodeFor('ближний свет')).toBe(head)
    expect(partNodeFor('лампа h7')).toBe(head)
    expect(partNodeFor('лампа стоп сигнала')!.leaves[0]).toContain('фонарь задний')
    // Голая «лампа» неоднозначна — таблица молчит, работает прежний поиск.
    expect(partNodeFor('лампа')).toBeNull()
  })

  test('у каждой строки есть код или запасной шаблон, и хоть один лист', () => {
    for (const node of PART_NODES) {
      expect(node.ids.length > 0 || node.other !== undefined).toBe(true)
      expect(node.leaves.length).toBeGreaterThan(0)
    }
  })
})

describe('isNodePart: та ли это деталь', () => {
  const pump = partNodeFor('помпа')!

  test('деталь с кодом — только по коду: чужой код не проходит при любом названии', () => {
    expect(isNodePart(pump, { name: 'Насос - помпа системы охлаждения ДВС', nameId: '130' })).toBe(true)
    expect(isNodePart(pump, { name: 'Прокладка помпы системы охлаждения', nameId: '704' })).toBe(false)
    expect(isNodePart(pump, { name: 'WATER PUMP', nameId: '704' })).toBe(false)
  })

  test('деталь без кода — по запасному шаблону, соседи по узлу отсекаются', () => {
    expect(isNodePart(pump, { name: 'PUMP ASSY-WATER', nameId: null })).toBe(false)
    expect(isNodePart(pump, { name: 'WATER PUMP ASSY', nameId: null })).toBe(true)
    expect(isNodePart(pump, { name: 'GASKET-WATER PUMP', nameId: null })).toBe(false)
  })

  // Живьём Hyundai Tucson: в узле фары без кода лежат «ЧАШКА ЛАМПЫ» и
  // «ДЕРЖАТЕЛЬ В СБОРЕ-ЛАМПА ПЕРЕДН. УКАЗАТЕЛЯ ПОВОРОТА» — это не лампы.
  test('лампа без кода — сама лампа, а не патрон или держатель', () => {
    const lamp = partNodeFor('лампа ближнего света')!
    expect(isNodePart(lamp, { name: 'ЧАШКА ЛАМПЫ', nameId: null })).toBe(false)
    expect(isNodePart(lamp, { name: 'ДЕРЖАТЕЛЬ В СБОРЕ-ЛАМПА ПЕРЕДН. УКАЗАТЕЛЯ ПОВОРОТА', nameId: null })).toBe(false)
    expect(isNodePart(lamp, { name: 'BULB-HEAD LAMP', nameId: null })).toBe(true)
    expect(isNodePart(lamp, { name: 'Лампа', nameId: '1384' })).toBe(true)
  })
})
