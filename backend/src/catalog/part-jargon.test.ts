import { describe, expect, test } from 'bun:test'

import {
  expandPartQuery,
  jargonReplacements,
  normalizePartQuery,
  PART_JARGON,
  partSynonyms,
  stripStopwords,
} from './part-jargon'

describe('normalizePartQuery', () => {
  test('целая строка-жаргонизм превращается в канонический термин', () => {
    expect(normalizePartQuery('гранатка')).toBe('ШРУС')
    expect(normalizePartQuery('воздухан')).toBe('Фильтр воздушный')
    expect(normalizePartQuery('жабка')).toBe('Дроссельная заслонка')
  })

  test('регистр и пробелы по краям не мешают', () => {
    expect(normalizePartQuery('  ГРАНАТКА  ')).toBe('ШРУС')
  })

  test('в составе фразы заменяется только жаргон, остальное остаётся', () => {
    expect(normalizePartQuery('гранатка передняя')).toBe('шрус передняя')
  })

  test('многословный жаргонизм выигрывает у одиночного', () => {
    // «ремень» сам по себе — приводной; «ремень грм» — другая деталь и другая
    // цена. Порядок от длинных к коротким не даёт превратить это в «ремень приводной грм».
    expect(normalizePartQuery('ремень грм')).toBe('Ремень ГРМ')
    expect(normalizePartQuery('нужен ремень грм')).toContain('ремень грм')
    expect(normalizePartQuery('ремень')).toBe('Ремень приводной')
  })

  test('вариант без «ё» понимается наравне с «ё»', () => {
    expect(normalizePartQuery('мосел')).toBe(normalizePartQuery('мосёл'))
    expect(normalizePartQuery('мосел')).toBe('Щётка стеклоочистителя')
  })

  test('незнакомое слово остаётся как есть', () => {
    expect(normalizePartQuery('квазар')).toBe('квазар')
  })

  test('пустой ввод не ломает', () => {
    expect(normalizePartQuery('')).toBe('')
  })
})

describe('stripStopwords', () => {
  test('выкидывает слова-просьбы и служебные', () => {
    expect(stripStopwords('предложи аналоги по сальнику')).toBe('сальнику')
  })

  test('уточнения стороны сохраняются — это часть детали', () => {
    // «передние» отличает переднюю колодку от задней: потерять его = не та деталь.
    expect(stripStopwords('найди передние тормозные колодки пожалуйста')).toBe(
      'передние тормозные колодки',
    )
  })

  test('запрос из одних стоп-слов возвращается нетронутым', () => {
    // Пустой запрос к каталогу хуже мусорного: пусть провайдер сам решит.
    expect(stripStopwords('пожалуйста дай')).toBe('пожалуйста дай')
  })
})

describe('expandPartQuery', () => {
  test('первым идёт самый чистый вариант, дубликаты убраны', () => {
    const variants = expandPartQuery('предложи аналоги по гранатке')
    expect(variants[0]).toBe('гранатке')
    expect(new Set(variants).size).toBe(variants.length)
  })

  test('исходный запрос всегда остаётся в списке как последний шанс', () => {
    const query = 'подшипник ступицы передний'
    expect(expandPartQuery(query)).toContain(query)
  })

  test('пустой ввод даёт пустой список', () => {
    expect(expandPartQuery('   ')).toEqual([])
  })

  test('канон не дублирует слово, которое уже стояло рядом (живой случай с прода)', () => {
    expect(normalizePartQuery('колодки тормозные передние')).toBe('колодки тормозные передние')
    for (const variant of expandPartQuery('колодки тормозные передние')) {
      expect(variant).not.toMatch(/тормозные тормозные/i)
    }
  })
})

describe('jargonReplacements', () => {
  test('показывает, что и во что перевели', () => {
    expect(jargonReplacements('гранатка')).toContainEqual({
      jargon: 'гранатка',
      canonical: 'ШРУС',
    })
  })

  test('на канонический термин не выдаёт дубль', () => {
    const found = jargonReplacements('дворники щётки')
    const canonicals = found.map((item) => item.canonical)
    expect(new Set(canonicals).size).toBe(canonicals.length)
  })
})

describe('partSynonyms', () => {
  test('одна деталь — один ряд, как её ни назови', () => {
    const canonical = partSynonyms('клапанная крышка')
    expect(canonical).toContain('крышка гбц')
    expect(canonical).toContain('клапанная крышка')
    expect(canonical).toContain('крышка головки блока цилиндров')
    // Любое имя ряда открывает тот же ряд — каталогу можно предъявить любое.
    for (const name of ['крышка клапанов', 'крышка гбц', 'крышка двигателя']) {
      expect(partSynonyms(name)).toEqual(canonical)
    }
  })

  test('канон идёт первым, многословные формы — раньше односложных', () => {
    const [first, ...rest] = partSynonyms('гранатка')
    expect(first).toBe('шрус')
    expect(rest).toContain('гранатка')
  })

  test('деталь опознаётся внутри фразы, а не только целиком', () => {
    expect(partSynonyms('колодки тормозные передние').length).toBeGreaterThan(1)
  })

  test('деталь названа первой, уточнение — следом', () => {
    // «Сальник коленвала» — это сальник. Раньше побеждал самый длинный
    // жаргонизм фразы, и ряд уезжал к коленчатому валу.
    expect(partSynonyms('сальник коленвала')[0]).toBe('сальник')
    // У «пыльника шруса» канон свой и более точный — но это всё равно пыльник,
    // а не ШРУС: уточнение не перетягивает ряд на себя.
    expect(partSynonyms('пыльник шруса')[0]).toStartWith('пыльник')
  })

  test('незнакомая деталь → пустой ряд', () => {
    expect(partSynonyms('квазар')).toEqual([])
    expect(partSynonyms('')).toEqual([])
  })
})

describe('крышка ГБЦ', () => {
  // Живой баг (Citroen C4, сент 2026): канон «Крышка клапанная» справочнику
  // parts-catalogs неизвестен, и поиск сваливался на общее слово «крышка» —
  // мастеру уходила схема расширительного бачка. Канон совпадает с названием
  // детали в каталоге: «Крышка ГБЦ».
  test.each([
    'клапанная крышка',
    'крышка клапанов',
    'крышка гбц',
    'крышка головки блока',
    'крышка головки блока цилиндров',
  ])('«%s» → Крышка ГБЦ', (query) => {
    expect(normalizePartQuery(query)).toBe('Крышка ГБЦ')
  })

  test('«крышка гбц» не разворачивается в «головку блока цилиндров»', () => {
    // Одиночный токен «гбц» — это головка блока; в паре с крышкой он значит
    // другую деталь, и пословная замена ломала запрос.
    expect(normalizePartQuery('гбц')).toBe('Головка блока цилиндров')
    expect(normalizePartQuery('крышка гбц').toLowerCase()).not.toContain('головка')
  })

  test('канон многословного жаргонизма не переписывается пословным проходом', () => {
    // «клапанная крышка» → «крышка гбц», и пословный проход не имеет права
    // развернуть подставленное «гбц» обратно в «головку блока цилиндров».
    expect(normalizePartQuery('нужна клапанная крышка пожалуйста')).toContain('крышка гбц')
    expect(normalizePartQuery('нужна клапанная крышка пожалуйста')).not.toContain('головка')
  })

  test('«головка блока цилиндров» не разрастается дублем канона', () => {
    expect(normalizePartQuery('головка блока цилиндров')).toBe('Головка блока цилиндров')
  })

  test('прокладка клапанной крышки зовётся так же, как в каталоге', () => {
    expect(normalizePartQuery('прокладка клапанной крышки')).toBe('Прокладка крышки ГБЦ')
  })
})

describe('словарь', () => {
  test('перенесён целиком и ключи в нижнем регистре', () => {
    // Защита от потери словаря при рефакторинге: 1015 форм из прототипа.
    expect(Object.keys(PART_JARGON).length).toBeGreaterThanOrEqual(1015)
    for (const key of Object.keys(PART_JARGON)) {
      expect(key).toBe(key.toLowerCase())
    }
  })

  test('канонические термины не пустые', () => {
    for (const [key, value] of Object.entries(PART_JARGON)) {
      expect(value.trim().length, `пустой канон у «${key}»`).toBeGreaterThan(0)
    }
  })
})
