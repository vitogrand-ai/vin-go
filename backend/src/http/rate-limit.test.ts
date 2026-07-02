import { describe, expect, test } from 'bun:test'

import { createApp } from '../app'
import type { DbClient } from '../db'
import { loadEnv } from '../env'
import { FixedWindowRateLimiter } from './rate-limit'

describe('FixedWindowRateLimiter', () => {
  test('пропускает до лимита, затем отдаёт запрет с Retry-After', () => {
    let now = 1000
    const limiter = new FixedWindowRateLimiter(3, 60_000, () => now)
    expect(limiter.check('ip').allowed).toBe(true)
    expect(limiter.check('ip').allowed).toBe(true)
    expect(limiter.check('ip').allowed).toBe(true)
    const blocked = limiter.check('ip')
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterMs).toBeGreaterThan(0)
  })

  test('после окна счётчик сбрасывается', () => {
    let now = 0
    const limiter = new FixedWindowRateLimiter(1, 1000, () => now)
    expect(limiter.check('ip').allowed).toBe(true)
    expect(limiter.check('ip').allowed).toBe(false)
    now = 1001
    expect(limiter.check('ip').allowed).toBe(true)
  })

  test('разные ключи (IP) считаются независимо', () => {
    const limiter = new FixedWindowRateLimiter(1, 1000, () => 0)
    expect(limiter.check('a').allowed).toBe(true)
    expect(limiter.check('b').allowed).toBe(true)
    expect(limiter.check('a').allowed).toBe(false)
  })
})

describe('rate limit — подключение к приложению', () => {
  // Публичный каталог не ходит в БД, поэтому проверяем wiring без Postgres.
  const env = loadEnv({
    DATABASE_URL: 'postgresql://unused',
    JWT_SECRET: '12345678901234567890123456789012',
    RATE_LIMIT_PUBLIC_MAX: '2',
  })
  const app = createApp({ env, prisma: {} as unknown as DbClient })

  const decode = () =>
    app.request('/api/catalog/decode-vin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vin: 'WVWZZZ1JZXW000001' }),
    })

  test('N+1-й публичный запрос сверх лимита получает 429', async () => {
    expect((await decode()).status).not.toBe(429)
    expect((await decode()).status).not.toBe(429)
    const blocked = await decode()
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).not.toBeNull()
  })
})
