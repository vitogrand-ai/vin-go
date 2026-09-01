import { describe, expect, test } from 'bun:test'

import type { DbClient } from '../db'
import { CatalogTranslator, isTranslatable, normalizeSource } from './catalog-translator'
import type { TranslationProvider } from './translation-provider'

type CacheRow = { source: string; ru: string; model: string }

/** Кэш переводов в памяти — повторяет контракт delegate'ов Prisma, которые нужны переводчику. */
function fakeDb(seed: CacheRow[] = []) {
  const rows = [...seed]
  const db = {
    catalogTranslation: {
      findMany: async ({ where }: { where: { source: { in: string[] } } }) =>
        rows.filter((row) => where.source.in.includes(row.source)),
      createMany: async ({ data }: { data: CacheRow[] }) => {
        for (const row of data) {
          if (!rows.some((existing) => existing.source === row.source)) rows.push(row)
        }
        return { count: data.length }
      },
    },
  }
  return { db: db as unknown as DbClient, rows }
}

/** Провайдер-заглушка: переводит «X» в «ру:X» и считает вызовы. */
function fakeProvider(
  translate?: (texts: string[]) => Promise<string[] | null>,
): TranslationProvider & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    model: 'test-model',
    async translate(texts) {
      calls.push(texts)
      if (translate) return translate(texts)
      return texts.map((text) => `ру:${text}`)
    },
  }
}

describe('CatalogTranslator', () => {
  test('переводит новые строки и кладёт их в кэш', async () => {
    const { db, rows } = fakeDb()
    const provider = fakeProvider()
    const translator = new CatalogTranslator(db, provider)

    const result = await translator.translate(['OIL FILTER', 'BRAKE DISC'])

    expect(result.get('OIL FILTER')).toBe('ру:OIL FILTER')
    expect(result.get('BRAKE DISC')).toBe('ру:BRAKE DISC')
    expect(rows).toEqual([
      { source: 'OIL FILTER', ru: 'ру:OIL FILTER', model: 'test-model' },
      { source: 'BRAKE DISC', ru: 'ру:BRAKE DISC', model: 'test-model' },
    ])
  })

  test('готовый перевод берётся из кэша, модель не вызывается', async () => {
    const { db } = fakeDb([{ source: 'OIL FILTER', ru: 'Масляный фильтр', model: 'test-model' }])
    const provider = fakeProvider()
    const translator = new CatalogTranslator(db, provider)

    const result = await translator.translate(['OIL FILTER'])

    expect(result.get('OIL FILTER')).toBe('Масляный фильтр')
    expect(provider.calls).toEqual([])
  })

  test('ручной словарь важнее кэша: правка формулировки действует сразу', async () => {
    const { db } = fakeDb([{ source: 'ENGINE', ru: 'Мотор из кэша', model: 'test-model' }])
    const provider = fakeProvider()
    const translator = new CatalogTranslator(db, provider)

    const result = await translator.translate(['ENGINE'])

    expect(result.get('ENGINE')).toBe('Двигатель')
    expect(provider.calls).toEqual([])
  })

  test('одинаковые строки переводятся один раз', async () => {
    const { db } = fakeDb()
    const provider = fakeProvider()
    const translator = new CatalogTranslator(db, provider)

    await translator.translate(['OIL FILTER', 'OIL FILTER', ' OIL FILTER '])

    expect(provider.calls).toEqual([['OIL FILTER']])
  })

  test('отказ модели не ломает выдачу: строка просто остаётся без перевода', async () => {
    const { db, rows } = fakeDb()
    const provider = fakeProvider(async () => null)
    const translator = new CatalogTranslator(db, provider)

    const result = await translator.translate(['OIL FILTER'])

    expect(result.size).toBe(0)
    expect(rows).toEqual([])
  })

  test('сбой кэша не ломает перевод', async () => {
    const db = {
      catalogTranslation: {
        findMany: async () => {
          throw new Error('БД недоступна')
        },
        createMany: async () => {
          throw new Error('БД недоступна')
        },
      },
    } as unknown as DbClient
    const translator = new CatalogTranslator(db, fakeProvider())

    const result = await translator.translate(['OIL FILTER'])

    expect(result.get('OIL FILTER')).toBe('ру:OIL FILTER')
  })

  test('русские, пустые и слишком длинные строки не отправляются в модель', async () => {
    const { db } = fakeDb()
    const provider = fakeProvider()
    const translator = new CatalogTranslator(db, provider)

    const result = await translator.translate([
      'Крышка маслозаливной горловины',
      '   ',
      '12345',
      'X'.repeat(201),
    ])

    expect(provider.calls).toEqual([])
    expect(result.size).toBe(0)
  })

  test('большая выдача режется на пакеты', async () => {
    const { db } = fakeDb()
    const provider = fakeProvider()
    const translator = new CatalogTranslator(db, provider)
    const sources = Array.from({ length: 45 }, (_, index) => `PART ${index}`)

    await translator.translate(sources)

    expect(provider.calls.length).toBe(2)
    expect(provider.calls[0]!.length).toBe(40)
    expect(provider.calls[1]!.length).toBe(5)
  })

  test('пустой перевод в ответе не затирает оригинал', async () => {
    const { db, rows } = fakeDb()
    const provider = fakeProvider(async (texts) => texts.map(() => '  '))
    const translator = new CatalogTranslator(db, provider)

    const result = await translator.translate(['OIL FILTER'])

    expect(result.size).toBe(0)
    expect(rows).toEqual([])
  })
})

describe('isTranslatable / normalizeSource', () => {
  test('строку с иероглифами переводим', () => {
    expect(isTranslatable('机油滤清器')).toBe(true)
  })

  test('строку без букв не переводим', () => {
    expect(isTranslatable('06K103495AM')).toBe(false)
  })

  test('ключ словаря не зависит от регистра и лишних пробелов', () => {
    expect(normalizeSource('  cap  assy ')).toBe('CAP ASSY')
  })
})
