import { Link, useParams } from '@tanstack/react-router'
import {
  allowedOrderTransitionsFor,
  type OrderDto,
  type OrderItemDto,
  type OrderStatus,
  type PaymentMethod,
} from '@web-app-demo/contracts'
import { useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { Typography } from '@/components/ui/typography'
import { AnalogsPanel } from '@/features/catalog/AnalogsPanel'
import { RequireAuth } from '@/features/cabinet/RequireAuth'
import {
  useCreatePayment,
  useOrder,
  useRefundOrder,
  useUpdateOrderNotes,
  useUpdateOrderStatus,
} from '@/features/cabinet/queries'
import { useAuth } from '@/lib/use-auth'
import { describeApiError } from '@/lib/errors'
import { formatMoney } from '@/lib/format'
import { STATUS_LABEL, TRANSITION_LABEL } from './status'

export function OrderDetailPage() {
  return (
    <RequireAuth>
      <OrderDetail />
    </RequireAuth>
  )
}

function OrderDetail() {
  const params = useParams({ strict: false }) as { id?: string }
  const id = params.id ?? ''
  const order = useOrder(id)

  if (order.isPending) {
    return (
      <Shell>
        <div className="flex items-center gap-3">
          <Spinner />
          <Typography tone="muted">Загружаем заказ…</Typography>
        </div>
      </Shell>
    )
  }

  if (order.isError) {
    return (
      <Shell>
        <Typography tone="destructive">{describeApiError(order.error)}</Typography>
        <Button asChild variant="outline" className="w-fit">
          <Link to="/orders">К заказам</Link>
        </Button>
      </Shell>
    )
  }

  return <Loaded order={order.data.order} />
}

function Loaded({ order }: { order: OrderDto }) {
  const { user } = useAuth()
  const status = STATUS_LABEL[order.status]
  // Клиент видит только отмену до оплаты; операторские переходы — у оператора.
  const transitions = allowedOrderTransitionsFor(user?.role ?? 'USER', order.status)
  const placed = order.placedAt ?? order.createdAt

  const createPayment = useCreatePayment()
  const updateStatus = useUpdateOrderStatus()
  const refund = useRefundOrder()
  const [method, setMethod] = useState<PaymentMethod>('card')

  const canPay = order.status === 'PLACED' && order.paymentStatus !== 'SUCCEEDED'
  const canRefund = order.paymentStatus === 'SUCCEEDED' && order.status !== 'REFUNDED'

  const handlePay = () =>
    createPayment.mutate(
      { orderId: order.id, method },
      {
        onSuccess: (data) => {
          if (data.payment.confirmationUrl) window.location.href = data.payment.confirmationUrl
          else toast.error('Провайдер не вернул ссылку на оплату')
        },
        onError: (error) => toast.error(describeApiError(error)),
      },
    )

  const handleRefund = () => {
    if (!window.confirm('Вернуть средства по этому заказу?')) return
    refund.mutate(order.id, {
      onSuccess: () => toast.success('Возврат выполнен'),
      onError: (error) => toast.error(describeApiError(error)),
    })
  }

  const handleStatus = (target: OrderStatus) =>
    updateStatus.mutate(
      { orderId: order.id, status: target },
      {
        onSuccess: () => toast.success(`Статус: ${STATUS_LABEL[target].label}`),
        onError: (error) => toast.error(describeApiError(error)),
      },
    )

  return (
    <Shell>
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link to="/orders">← К заказам</Link>
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => window.print()}>
          Печать накладной
        </Button>
      </div>

      {/* Накладная */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Заказ № {order.id.slice(0, 8).toUpperCase()}</CardTitle>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
          <Typography tone="muted" variant="bodySm">
            от {new Date(placed).toLocaleString('ru-RU')}
            {order.vehicleVin ? ` · VIN ${order.vehicleVin}` : ''}
          </Typography>
        </CardHeader>
        <CardContent className="grid gap-3">
          {order.items.map((item) => (
            <OrderItemRow key={item.id} item={item} />
          ))}
          <Separator />
          <div className="flex items-center justify-between">
            <Typography variant="bodySm" tone="muted">
              Итого ({order.itemCount} шт.)
            </Typography>
            <Typography variant="h4">{formatMoney(order.total)}</Typography>
          </div>
        </CardContent>
      </Card>

      {/* Действия */}
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        {canPay ? (
          <>
            <div className="inline-flex rounded-lg border p-0.5">
              {(['card', 'sbp'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMethod(value)}
                  className={
                    'rounded-md px-3 py-1 text-sm font-medium transition-colors ' +
                    (method === value
                      ? 'bg-secondary text-secondary-foreground'
                      : 'text-muted-foreground hover:text-foreground')
                  }
                >
                  {value === 'card' ? 'Карта' : 'СБП'}
                </button>
              ))}
            </div>
            <Button type="button" disabled={createPayment.isPending} onClick={handlePay}>
              {createPayment.isPending ? <Spinner /> : null}
              Оплатить
            </Button>
          </>
        ) : null}
        {transitions.map((target) => (
          <Button
            key={target}
            type="button"
            variant={target === 'CANCELLED' ? 'outline' : 'default'}
            disabled={updateStatus.isPending}
            onClick={() => handleStatus(target)}
          >
            {TRANSITION_LABEL[target]}
          </Button>
        ))}
        {canRefund ? (
          <Button
            type="button"
            variant="destructive"
            disabled={refund.isPending}
            onClick={handleRefund}
          >
            {refund.isPending ? <Spinner /> : null}
            Вернуть деньги
          </Button>
        ) : null}
      </div>

      <NotesEditor orderId={order.id} initial={order.notes} />
    </Shell>
  )
}

function OrderItemRow({ item }: { item: OrderItemDto }) {
  const [showAnalogs, setShowAnalogs] = useState(false)

  return (
    <div className="grid gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Typography variant="bodySmMedium">{item.partName}</Typography>
          <Typography variant="bodyXs" tone="muted">
            {item.brand} · {item.oemNumber} · {item.quantity} шт.
          </Typography>
          <button
            type="button"
            onClick={() => setShowAnalogs((value) => !value)}
            className="text-xs text-primary hover:underline print:hidden"
          >
            {showAnalogs ? 'Скрыть аналоги' : 'Показать аналоги'}
          </button>
        </div>
        <Typography variant="bodySmMedium" className="shrink-0">
          {formatMoney(item.lineTotal)}
        </Typography>
      </div>
      {showAnalogs ? <AnalogsPanel oemNumber={item.oemNumber} /> : null}
    </div>
  )
}

function NotesEditor({ orderId, initial }: { orderId: string; initial: string | null }) {
  const [notes, setNotes] = useState(initial ?? '')
  const updateNotes = useUpdateOrderNotes()
  const dirty = notes !== (initial ?? '')

  return (
    <Card className="print:hidden">
      <CardHeader>
        <CardTitle>Заметка к заказу</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Комментарий: контакт клиента, договорённости, особенности…"
          maxLength={2000}
          rows={3}
        />
        <Button
          type="button"
          className="w-fit"
          disabled={!dirty || updateNotes.isPending}
          onClick={() =>
            updateNotes.mutate(
              { orderId, notes },
              {
                onSuccess: () => toast.success('Заметка сохранена'),
                onError: (error) => toast.error(describeApiError(error)),
              },
            )
          }
        >
          {updateNotes.isPending ? <Spinner /> : null}
          Сохранить заметку
        </Button>
      </CardContent>
    </Card>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <section className="mx-auto grid w-full max-w-3xl gap-5 px-5 py-10">{children}</section>
}
