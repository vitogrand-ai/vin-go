import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { Typography } from '@/components/ui/typography'
import { useAuth } from '@/lib/use-auth'

/** Показывает контент только авторизованным; иначе — приглашение войти. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const auth = useAuth()

  if (auth.isBootstrapping) {
    return (
      <section className="mx-auto w-full max-w-6xl px-5 py-16">
        <Card className="w-fit">
          <CardContent className="flex items-center gap-3">
            <Spinner />
            <Typography variant="bodySm" tone="muted">
              Проверяем сессию…
            </Typography>
          </CardContent>
        </Card>
      </section>
    )
  }

  if (!auth.user) {
    return (
      <section className="mx-auto grid w-full max-w-6xl gap-6 px-5 py-16">
        <Badge variant="outline" className="w-fit">
          Личный кабинет
        </Badge>
        <Typography variant="h1">Нужен вход</Typography>
        <Typography tone="muted" className="max-w-2xl">
          Войдите в аккаунт, чтобы пользоваться гаражом, корзиной и историей заказов.
        </Typography>
        <Button asChild size="lg" className="w-fit">
          <Link to="/">Войти</Link>
        </Button>
      </section>
    )
  }

  return <>{children}</>
}
