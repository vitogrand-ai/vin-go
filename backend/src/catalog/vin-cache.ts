import { vehicleSchema, type Part, type Vehicle } from '@web-app-demo/contracts'

import type { DbClient } from '../db'
import type { Prisma } from '../generated/prisma/client'
import { CATALOG_SOURCE_KEY } from './fallback-catalog'
import type { CatalogProvider } from './providers'

/** Минимум Prisma-клиента, который нужен кэшу (упрощает тесты без БД). */
export type VinCacheDb = Pick<DbClient, 'vinDecode'>

/** По умолчанию карточка авто живёт 60 дней: VIN не меняется, меняются каталоги. */
export const VIN_CACHE_TTL_MS = 60 * 24 * 60 * 60 * 1000

/**
 * Кэш расшифровки VIN в PostgreSQL поверх любого каталога.
 *
 * Зачем: каждый поиск начинается с decodeVin, а у боевых источников он платный
 * (17vin — $0.15 за VIN, parts-catalogs — квота на тест-ключе) и медленный
 * (внешний HTTP). Мастер за день спрашивает одну машину много раз, а API и бот
 * — разные процессы: in-memory кэш здесь не помогает. Карточка кладётся в БД
 * целиком, включая `raw` с меткой источника, поэтому searchParts по машине из
 * кэша идёт в тот же каталог, что и при живой расшифровке.
 *
 * Не кэшируются: «не найдено» (VIN может появиться в каталоге позже) и сбои.
 * Запись — upsert, потому что API и бот могут расшифровать один VIN одновременно.
 */
export class CachingCatalogProvider implements CatalogProvider {
  constructor(
    private readonly inner: CatalogProvider,
    private readonly db: VinCacheDb,
    private readonly ttlMs = VIN_CACHE_TTL_MS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async decodeVin(vin: string): Promise<Vehicle | null> {
    const key = vin.trim().toUpperCase()
    const cached = await this.read(key)
    if (cached) return cached

    const vehicle = await this.inner.decodeVin(vin)
    if (vehicle) await this.write(key, vehicle)
    return vehicle
  }

  searchParts(vehicle: Vehicle, query: string): Promise<Part[]> {
    return this.inner.searchParts(vehicle, query)
  }

  /** Кэшируется только расшифровка VIN — узел по схеме идёт в каталог как есть. */
  schemeParts(vehicle: Vehicle, schemeId: string): Promise<Part[]> {
    return this.inner.schemeParts?.(vehicle, schemeId) ?? Promise.resolve([])
  }

  private async read(vin: string): Promise<Vehicle | null> {
    let record: { vehicle: unknown; expiresAt: Date } | null
    try {
      record = await this.db.vinDecode.findUnique({ where: { vin } })
    } catch (error) {
      // Проблема с БД не должна ломать поиск: идём в живой каталог.
      console.warn('[vin-cache] чтение кэша упало, идём в каталог', error)
      return null
    }
    if (!record || record.expiresAt <= this.now()) return null

    // Схема контракта могла измениться с момента записи — битую карточку
    // считаем промахом, а не отдаём наружу.
    const parsed = vehicleSchema.safeParse(record.vehicle)
    if (!parsed.success) return null

    // Счётчик попаданий — чтобы видеть, окупается ли кэш. Не ждём ответа.
    void this.db.vinDecode
      .update({ where: { vin }, data: { hitCount: { increment: 1 } } })
      .catch(() => undefined)

    return parsed.data
  }

  private async write(vin: string, vehicle: Vehicle): Promise<void> {
    const source = readSource(vehicle)
    const decodedAt = this.now()
    const expiresAt = new Date(decodedAt.getTime() + this.ttlMs)
    // Json-поле принимает любой сериализуемый объект; Vehicle им является.
    const payload = JSON.parse(JSON.stringify(vehicle)) as Prisma.InputJsonObject
    try {
      await this.db.vinDecode.upsert({
        where: { vin },
        create: { vin, vehicle: payload, source, decodedAt, expiresAt },
        update: { vehicle: payload, source, decodedAt, expiresAt, hitCount: 0 },
      })
    } catch (error) {
      console.warn('[vin-cache] запись кэша упала, результат отдан без кэша', error)
    }
  }
}

function readSource(vehicle: Vehicle): string {
  const value = vehicle.raw?.[CATALOG_SOURCE_KEY]
  return typeof value === 'string' ? value : 'unknown'
}
