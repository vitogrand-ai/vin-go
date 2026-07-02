import { Link, Outlet } from '@tanstack/react-router'

import { AuthForm } from '@/components/AuthForm'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { Typography } from '@/components/ui/typography'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/use-auth'

const navLinkClass = cn(
  buttonVariants({ variant: 'ghost', size: 'sm' }),
  'text-muted-foreground data-[status=active]:bg-secondary data-[status=active]:text-secondary-foreground data-[status=active]:hover:bg-secondary/80 data-[status=active]:hover:text-secondary-foreground'
)

export function RootLayout() {
  const auth = useAuth()

  return (
    <main className="min-h-svh bg-background text-foreground">
      <header className="border-b bg-background/95 backdrop-blur print:hidden">
        <div className="mx-auto flex min-h-16 w-full max-w-6xl flex-wrap items-center gap-3 px-5 py-3">
          <Typography asChild variant="h6">
            <Link to="/">VIN GO</Link>
          </Typography>
          <nav className="ml-auto flex flex-wrap items-center gap-2" aria-label="Primary">
            <Typography asChild variant="control" tone="muted">
              <Link to="/search" className={navLinkClass}>
                Поиск
              </Link>
            </Typography>
            {auth.isAuthenticated ? (
              <>
                <Typography asChild variant="control" tone="muted">
                  <Link to="/garage" className={navLinkClass}>
                    Гараж
                  </Link>
                </Typography>
                <Typography asChild variant="control" tone="muted">
                  <Link to="/cart" className={navLinkClass}>
                    Корзина
                  </Link>
                </Typography>
                <Typography asChild variant="control" tone="muted">
                  <Link to="/orders" className={navLinkClass}>
                    Заказы
                  </Link>
                </Typography>
                <Typography asChild variant="control" tone="muted">
                  <Link to="/settings" className={navLinkClass}>
                    Настройки
                  </Link>
                </Typography>
              </>
            ) : (
              <Typography asChild variant="control" tone="muted">
                <Link to="/" className={navLinkClass}>
                  Вход
                </Link>
              </Typography>
            )}
          </nav>
          {auth.isAuthenticated && (
            <Button type="button" variant="outline" size="sm" onClick={() => void auth.logout()}>
              Выйти
            </Button>
          )}
        </div>
      </header>
      <Outlet />
    </main>
  )
}

const TIERS = [
  { name: 'Эконом', desc: 'Дешевле, с приоритетом наличия' },
  { name: 'Оптимальный', desc: 'Баланс цены и качества' },
  { name: 'Оригинал', desc: 'Заводская деталь производителя' },
] as const

const QUICK_ACTIONS = [
  { to: '/search', title: 'Поиск', desc: 'VIN или госномер → запчасти' },
  { to: '/garage', title: 'Гараж', desc: 'Сохранённые автомобили' },
  { to: '/orders', title: 'Заказы', desc: 'История и статусы' },
] as const

export function HomePage() {
  const auth = useAuth()

  if (auth.isBootstrapping) {
    return <LoadingState />
  }

  // Вошедший пользователь: дашборд с быстрыми действиями (заменяет служебный /app).
  if (auth.user) {
    return (
      <section className="mx-auto grid w-full max-w-6xl gap-6 px-5 py-12">
        <div className="grid gap-2">
          <Typography variant="h1">
            Здравствуйте, {auth.user.displayName ?? auth.user.email}
          </Typography>
          <Typography tone="muted">С чего начнём?</Typography>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {QUICK_ACTIONS.map((action) => (
            <Link
              key={action.to}
              to={action.to}
              aria-label={action.title}
              className="rounded-2xl transition-transform hover:-translate-y-0.5 focus-visible:-translate-y-0.5 focus-visible:outline-none"
            >
              <Card className="h-full hover:ring-foreground/25 focus-visible:ring-foreground/25">
                <CardHeader>
                  <CardTitle>{action.title}</CardTitle>
                  <CardDescription>{action.desc}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      </section>
    )
  }

  // Гость: краткий оффер VIN GO + форма входа.
  return (
    <section className="mx-auto grid w-full max-w-6xl gap-10 px-5 py-12 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
      <div className="grid gap-6">
        <Badge variant="outline" className="w-fit">
          Ранний доступ
        </Badge>
        <Typography className="max-w-3xl" variant="h1">
          Автозапчасти по VIN и госномеру
        </Typography>
        <Typography className="max-w-2xl" tone="muted">
          Введите VIN или госномер — определим автомобиль, подберём каталожный номер и покажем
          предложения в трёх тирах. Для небольших автосервисов: гараж, корзина, заказы и оплата.
        </Typography>
        <div className="grid gap-3 sm:grid-cols-3">
          {TIERS.map((tier) => (
            <Card key={tier.name} size="sm">
              <CardHeader>
                <CardTitle>{tier.name}</CardTitle>
                <CardDescription>{tier.desc}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
        <Typography variant="bodyXs" tone="muted">
          Сейчас данные демонстрационные — подключение реальных каталогов и поставщиков в работе.
        </Typography>
      </div>
      <AuthForm />
    </section>
  )
}

function LoadingState() {
  return (
    <section className="mx-auto w-full max-w-6xl px-5 py-16">
      <Card className="w-fit">
        <CardContent className="flex items-center gap-3">
          <Spinner />
          <Typography variant="bodySm" tone="muted">
            Проверяем сессию...
          </Typography>
        </CardContent>
      </Card>
    </section>
  )
}
