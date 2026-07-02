import type { Context, MiddlewareHandler } from 'hono'

import type { AuthService } from './service'

/**
 * Middleware авторизации: проверяет Bearer-токен и активную сессию,
 * затем кладёт `userId` в контекст. Используется на защищённых роутах
 * (гараж, корзина, заказы).
 */
export function requireAuth(): MiddlewareHandler {
  return async (c, next) => {
    const authService = c.get('authService') as AuthService
    const { userId } = await authService.authenticate(bearerToken(c))
    c.set('userId', userId)
    await next()
  }
}

function bearerToken(c: Context): string | undefined {
  const authorization = c.req.header('authorization')
  if (!authorization?.startsWith('Bearer ')) return undefined
  return authorization.slice('Bearer '.length)
}
