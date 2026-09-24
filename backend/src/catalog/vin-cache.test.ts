import { describe, expect, test } from 'bun:test'
import type { Vehicle } from '@web-app-demo/contracts'

import { CATALOG_SOURCE_KEY } from './fallback-catalog'
import type { CatalogProvider } from './providers'
import { CachingCatalogProvider, type VinCacheDb } from './vin-cache'

const VEHICLE: Vehicle = {
  vin: 'WVWZZZ1JZ3W386752',
  make: 'Volkswagen',
  model: 'Golf',
  year: 2003,
  engine: '1.6 MPI',
  bodyType: 'Хэтчбек',
  raw: { [CATALOG_SOURCE_KEY]: 'acat', carId: 42 },
}

type Row = {
  vin: string
  vehicle: unknown
  source: string
  hitCount: number
  expiresAt: Date
  decodedAt: Date
}

/** Табличка в памяти с интерфейсом Prisma-делегата — ровно то, что зовёт кэш. */
function fakeDb(rows = new Map<string, Row>()) {
  const vinDecode = {
    findUnique: async ({ where }: { where: { vin: string } }) => rows.get(where.vin) ?? null,
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { vin: string }
      create: Omit<Row, 'hitCount'>
      update: Omit<Row, 'vin'>
    }) => {
      const existing = rows.get(where.vin)
      const row: Row = existing ? { ...existing, ...update } : { ...create, hitCount: 0 }
      rows.set(where.vin, row)
      return row
    },
    update: async ({ where }: { where: { vin: string } }) => {
      const row = rows.get(where.vin)
      if (row) row.hitCount += 1
      return row
    },
  }
  return { db: { vinDecode } as unknown as VinCacheDb, rows }
}

function countingCatalog(answer: Vehicle | null = VEHICLE) {
  const calls: string[] = []
  const provider: CatalogProvider = {
    decodeVin: async (vin) => {
      calls.push(vin)
      return answer
    },
    searchParts: async () => [],
  }
  return { provider, calls }
}

describe('CachingCatalogProvider', () => {
  test('первый декод идёт в каталог и кладёт карточку в БД, второй — из кэша', async () => {
    const { db, rows } = fakeDb()
    const { provider, calls } = countingCatalog()
    const cache = new CachingCatalogProvider(provider, db)

    const first = await cache.decodeVin('wvwzzz1jz3w386752')
    expect(first).toEqual(VEHICLE)
    expect(calls).toEqual(['wvwzzz1jz3w386752'])
    expect(rows.get('WVWZZZ1JZ3W386752')?.source).toBe('acat')

    const second = await cache.decodeVin('WVWZZZ1JZ3W386752')
    expect(second).toEqual(VEHICLE)
    // Каталог не спрашивали повторно, метка источника в raw сохранилась.
    expect(calls).toHaveLength(1)
    expect(second?.raw?.[CATALOG_SOURCE_KEY]).toBe('acat')
    // Счётчик попаданий обновляется асинхронно.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rows.get('WVWZZZ1JZ3W386752')?.hitCount).toBe(1)
  })

  test('«не найдено» не кэшируется', async () => {
    const { db, rows } = fakeDb()
    const { provider, calls } = countingCatalog(null)
    const cache = new CachingCatalogProvider(provider, db)

    expect(await cache.decodeVin('WVWZZZ1JZ3W386752')).toBeNull()
    expect(await cache.decodeVin('WVWZZZ1JZ3W386752')).toBeNull()
    expect(calls).toHaveLength(2)
    expect(rows.size).toBe(0)
  })

  test('просроченная запись — промах, карточка перезаписывается', async () => {
    let now = new Date('2026-09-03T00:00:00Z')
    const { db, rows } = fakeDb()
    const { provider, calls } = countingCatalog()
    const cache = new CachingCatalogProvider(provider, db, 1000, () => now)

    await cache.decodeVin('WVWZZZ1JZ3W386752')
    now = new Date(now.getTime() + 2000)
    await cache.decodeVin('WVWZZZ1JZ3W386752')
    expect(calls).toHaveLength(2)
    expect(rows.get('WVWZZZ1JZ3W386752')?.expiresAt.getTime()).toBe(now.getTime() + 1000)
  })

  test('битая запись в БД считается промахом', async () => {
    const rows = new Map<string, Row>()
    rows.set('WVWZZZ1JZ3W386752', {
      vin: 'WVWZZZ1JZ3W386752',
      vehicle: { make: 'нет остальных полей' },
      source: 'acat',
      hitCount: 0,
      decodedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { db } = fakeDb(rows)
    const { provider, calls } = countingCatalog()
    const cache = new CachingCatalogProvider(provider, db)

    expect(await cache.decodeVin('WVWZZZ1JZ3W386752')).toEqual(VEHICLE)
    expect(calls).toHaveLength(1)
  })

  test('сбой БД не ломает расшифровку', async () => {
    const broken = {
      vinDecode: {
        findUnique: async () => {
          throw new Error('connection refused')
        },
        upsert: async () => {
          throw new Error('connection refused')
        },
        update: async () => undefined,
      },
    } as unknown as VinCacheDb
    const { provider } = countingCatalog()
    const cache = new CachingCatalogProvider(provider, broken)
    expect(await cache.decodeVin('WVWZZZ1JZ3W386752')).toEqual(VEHICLE)
  })
})

describe('CachingCatalogProvider: запрос мастера доходит до каталога', () => {
  // На проде кэш включён всегда: без проброса таблица «деталь → узел» видела
  // только вариант словаря («коленчатый вал» вместо «датчик положения коленвала»).
  test('searchParts пробрасывает исходный запрос мастера', async () => {
    let seen: string | undefined
    const inner: CatalogProvider = {
      decodeVin: async () => VEHICLE,
      searchParts: async (_vehicle, _query, original) => {
        seen = original
        return []
      },
    }
    const { db } = fakeDb()
    await new CachingCatalogProvider(inner, db).searchParts(VEHICLE, 'коленчатый вал', 'датчик положения коленвала')
    expect(seen).toBe('датчик положения коленвала')
  })

  test('дерево узлов и схемы листа идут в каталог как есть', async () => {
    const inner: CatalogProvider = {
      decodeVin: async () => VEHICLE,
      searchParts: async () => [],
      catalogTree: async () => [{ id: '1', name: 'Двигатель', parentId: null, leaf: true }],
      branchSchemes: async (_vehicle, branchId) => [{ schemeId: `s-${branchId}`, name: 'Схема', imageUrl: null }],
    }
    const { db } = fakeDb()
    const cache = new CachingCatalogProvider(inner, db)
    expect(await cache.catalogTree(VEHICLE)).toHaveLength(1)
    expect((await cache.branchSchemes(VEHICLE, '1'))[0]?.schemeId).toBe('s-1')
  })
})
