import type { Context, MiddlewareHandler } from 'hono'

import { errorResponse } from './errors'

export type RateLimitResult = { allowed: boolean; retryAfterMs: number }

/**
 * Ограничитель частоты запросов с фиксированным окном, in-memory (на инстанс).
 * Простой и достаточный барьер против brute-force логина/регистрации и всплесков
 * на публичных эндпоинтах. Часы инъектируются ради детерминированных тестов.
 *
 * Замечание про масштаб: при нескольких инстансах лимит считается на каждый
 * отдельно; для распределённого лимита нужен общий стор (Redis) — это осознанно
 * отложено до реальной горизонтальной нагрузки.
 */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Учитывает запрос по ключу и говорит, разрешён ли он. */
  check(key: string): RateLimitResult {
    const t = this.now()
    const bucket = this.buckets.get(key)
    if (!bucket || bucket.resetAt <= t) {
      this.buckets.set(key, { count: 1, resetAt: t + this.windowMs })
      this.sweep(t)
      return { allowed: true, retryAfterMs: 0 }
    }
    if (bucket.count >= this.max) {
      return { allowed: false, retryAfterMs: bucket.resetAt - t }
    }
    bucket.count += 1
    return { allowed: true, retryAfterMs: 0 }
  }

  /** Чистка протухших корзин, чтобы Map не рос без ограничений. */
  private sweep(t: number): void {
    if (this.buckets.size < 5000) return
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= t) this.buckets.delete(key)
    }
  }
}

/**
 * Клиентский IP из заголовков обратного прокси (первый в X-Forwarded-For).
 * Без прокси заголовков нет — тогда ключ общий ('unknown'); для локальной
 * разработки это приемлемо (лимиты щедрые), в проде IP проставляет App Platform.
 */
export function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  if (forwarded) return forwarded
  return c.req.header('x-real-ip')?.trim() || 'unknown'
}

/**
 * Middleware ограничения частоты. Ключ = имя лимитера + IP клиента.
 * При превышении отдаёт 429 с заголовком Retry-After.
 */
export function rateLimit(limiter: FixedWindowRateLimiter, name: string): MiddlewareHandler {
  return async (c, next) => {
    const result = limiter.check(`${name}:${clientIp(c)}`)
    if (!result.allowed) {
      c.header('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)))
      return c.json(
        errorResponse('TOO_MANY_REQUESTS', 'Слишком много запросов, попробуйте позже'),
        429,
      )
    }
    await next()
  }
}
