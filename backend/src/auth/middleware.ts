import type { Context, MiddlewareHandler } from 'hono'

import type { Actor } from './actor'
import type { AuthService } from './service'

/**
 * Middleware авторизации: проверяет Bearer-токен и активную сессию, затем
 * кладёт в контекст `actor` (пользователь + автосервис + роли) и отдельные
 * поля `userId`/`role`/`orgId` для роутов, которым нужен только один из них.
 */
export function requireAuth(): MiddlewareHandler {
  return async (c, next) => {
    const authService = c.get('authService') as AuthService
    const { userId, role, orgId, orgRole } = await authService.authenticate(bearerToken(c))
    const actor: Actor = { userId, orgId, role, orgRole }
    c.set('actor', actor)
    c.set('userId', userId)
    c.set('role', role)
    c.set('orgId', orgId)
    await next()
  }
}

function bearerToken(c: Context): string | undefined {
  const authorization = c.req.header('authorization')
  if (!authorization?.startsWith('Bearer ')) return undefined
  return authorization.slice('Bearer '.length)
}
