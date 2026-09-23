import { describe, expect, test } from 'bun:test'
import type { OffersResponse, SearchPartsResponse } from '@web-app-demo/contracts'

import { createApp } from '../app'
import type { DbClient } from '../db'
import type { AppEnv } from '../env'

// Эндпоинты каталога не обращаются к БД, поэтому prisma можно подменить заглушкой.
const env: AppEnv = {
  PORT: 3000,
  DATABASE_URL: 'postgresql://unused',
  JWT_SECRET: '12345678901234567890123456789012',
  CORS_ORIGINS: ['http://localhost:5173'],
  ACCESS_TOKEN_TTL_SECONDS: 60,
  REFRESH_TOKEN_TTL_DAYS: 30,
  COOKIE_SECURE: false,
  YOOKASSA_WEBHOOK_IP_ALLOWLIST: false,
  SPACES_UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
  SPACES_UPLOAD_URL_TTL_SECONDS: 900,
  SPACES_DOWNLOAD_URL_TTL_SECONDS: 300,
  SPACES_PUBLIC_CACHE_CONTROL: 'public, max-age=31536000, immutable',
}

const app = createApp({ env, prisma: {} as unknown as DbClient })

function post(path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('catalog API', () => {
  test('расшифровывает известный VIN', async () => {
    const res = await post('/api/catalog/decode-vin', { vin: 'WVWZZZ1JZ3W386752' })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { vehicle: { make: string } }
    expect(data.vehicle.make).toBe('Volkswagen')
  })

  test('расшифровывает VIN китайской сборки (Audi Q5L)', async () => {
    const res = await post('/api/catalog/decode-vin', { vin: 'LFV3B2FY2N3102396' })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { vehicle: { make: string; year: number } }
    expect(data.vehicle.make).toBe('Audi')
    expect(data.vehicle.year).toBe(2022)
  })

  test('для неизвестного VIN берёт марку из WMI и год из 10-го символа', async () => {
    // WAU → Audi, 10-й символ 'L' → модельный год 2020.
    const res = await post('/api/catalog/decode-vin', { vin: 'WAUZZZ8R5LA123456' })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { vehicle: { make: string; year: number } }
    expect(data.vehicle.make).toBe('Audi')
    expect(data.vehicle.year).toBe(2020)
  })

  test('отвергает некорректный VIN с кодом 400', async () => {
    const res = await post('/api/catalog/decode-vin', { vin: 'SHORT' })
    expect(res.status).toBe(400)
  })

  test('определяет авто по госномеру (в т.ч. латиницей)', async () => {
    const res = await post('/api/catalog/resolve-plate', { plate: 'А123ВС777' })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { vehicle: { make: string; vin: string } }
    expect(data.vehicle.make).toBe('Volkswagen')
    expect(data.vehicle.vin).toBe('WVWZZZ1JZ3W386752')

    // Тот же номер латиницей нормализуется и даёт тот же результат.
    const latin = await post('/api/catalog/resolve-plate', { plate: 'A123BC777' })
    expect(latin.status).toBe(200)
  })

  test('возвращает 404 для неизвестного госномера', async () => {
    const res = await post('/api/catalog/resolve-plate', { plate: 'Х999ХХ999' })
    expect(res.status).toBe(404)
  })

  test('возвращает 400 для некорректного госномера', async () => {
    const res = await post('/api/catalog/resolve-plate', { plate: '123' })
    expect(res.status).toBe(400)
  })

  test('ищет запчасти по запросу', async () => {
    const res = await post('/api/catalog/search', {
      vin: 'WVWZZZ1JZ3W386752',
      query: 'колодки',
    })
    expect(res.status).toBe(200)
    const data = (await res.json()) as SearchPartsResponse
    expect(data.parts.length).toBeGreaterThan(0)
    expect(data.parts[0]?.category).toBe('Тормозная система')
  })

  test('находит маслоотделитель без ложных совпадений по «масло»', async () => {
    const res = await post('/api/catalog/search', {
      vin: 'LFV3B2FY2N3102396',
      query: 'маслоотделитель',
    })
    expect(res.status).toBe(200)
    const data = (await res.json()) as SearchPartsResponse
    const names = data.parts.map((p) => p.name)
    expect(names).toContain('Маслоотделитель (сепаратор картерных газов)')
    // Короткое слово «масло» не должно цепляться к длинному запросу.
    expect(names).not.toContain('Масло моторное 5W-40, 1 л')
    expect(names).not.toContain('Фильтр масляный')
  })

  test('открывает узел схемы: демо-каталог схем не знает — пусто, но не ошибка', async () => {
    const res = await post('/api/catalog/scheme', { vin: 'WVWZZZ1JZ3W386752', schemeId: 'G1' })
    expect(res.status).toBe(200)
    const data = (await res.json()) as SearchPartsResponse
    expect(data.vehicle.make).toBe('Volkswagen')
    expect(data.parts).toEqual([])
  })

  test('узел без идентификатора — 400', async () => {
    const res = await post('/api/catalog/scheme', { vin: 'WVWZZZ1JZ3W386752', schemeId: ' ' })
    expect(res.status).toBe(400)
  })

  test('возвращает предложения с тремя тирами', async () => {
    const res = await post('/api/catalog/offers', { oemNumber: '1J0698151' })
    expect(res.status).toBe(200)
    const data = (await res.json()) as OffersResponse
    expect(data.offers.length).toBeGreaterThan(0)
    const tiers = data.picks.map((p) => p.tier)
    expect(tiers).toContain('ECONOMY')
    expect(tiers).toContain('BALANCED')
    expect(tiers).toContain('ORIGINAL')

    // Предложения отсортированы по возрастанию цены.
    const prices = data.offers.map((o) => o.price.amount)
    expect([...prices].sort((a, b) => a - b)).toEqual(prices)

    // Оригинал в тире ORIGINAL действительно помечен как оригинал.
    const original = data.picks.find((p) => p.tier === 'ORIGINAL')
    expect(original?.offer.isOriginal).toBe(true)
  })
})
