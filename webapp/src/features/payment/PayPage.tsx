import { Link, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { Typography } from '@/components/ui/typography'
import { RequireAuth } from '@/features/cabinet/RequireAuth'
import { useConfirmMockPayment } from '@/features/cabinet/queries'
import { describeApiError } from '@/lib/errors'
import { formatMoney } from '@/lib/format'

export function PayPage() {
  return (
    <RequireAuth>
      <Pay />
    </RequireAuth>
  )
}

function Pay() {
  const navigate = useNavigate()
  const confirm = useConfirmMockPayment()
  const paymentId =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('paymentId')
      : null

  if (!paymentId) {
    return (
      <PayShell>
        <Typography tone="destructive">Не указан идентификатор платежа.</Typography>
        <Button asChild className="w-fit">
          <Link to="/orders">К заказам</Link>
        </Button>
      </PayShell>
    )
  }

  const handleConfirm = () => {
    confirm.mutate(paymentId, {
      onSuccess: (data) => {
        toast.success(`Оплата ${formatMoney(data.payment.amount)} прошла успешно`)
        void navigate({ to: '/orders' })
      },
      onError: (error) => toast.error(describeApiError(error)),
    })
  }

  return (
    <PayShell>
      <Card className="max-w-md">
        <CardHeader>
          <Badge variant="secondary" className="w-fit">
            Тестовая оплата
          </Badge>
          <CardTitle className="pt-2">Подтверждение оплаты</CardTitle>
          <CardDescription>
            Это демонстрационная платёжная форма. В боевом режиме здесь будет страница ЮKassa.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Button type="button" size="lg" disabled={confirm.isPending} onClick={handleConfirm}>
            {confirm.isPending ? <Spinner /> : null}
            Оплатить (тест)
          </Button>
          <Button asChild variant="outline">
            <Link to="/orders">Отмена</Link>
          </Button>
        </CardContent>
      </Card>
    </PayShell>
  )
}

function PayShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="mx-auto grid w-full max-w-6xl gap-6 px-5 py-10">
      <Typography variant="h1">Оплата</Typography>
      {children}
    </section>
  )
}
