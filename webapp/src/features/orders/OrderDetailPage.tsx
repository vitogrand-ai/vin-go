import { Link, useNavigate, useParams } from '@tanstack/react-router'
import {
  allowedOrderTransitionsFor,
  marginPercent,
  type OrderDto,
  type OrderItemDto,
  type OrderStatus,
  type OrganizationDto,
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
  useOrganization,
  useRefundOrder,
  useReorder,
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
  const organization = useOrganization()
  const status = STATUS_LABEL[order.status]
  // Сотрудник видит только отмену до оплаты; операторские переходы — у оператора платформы.
  const transitions = allowedOrderTransitionsFor(user?.role ?? 'USER', order.status)
  const placed = order.placedAt ?? order.createdAt

  const createPayment = useCreatePayment()
  const updateStatus = useUpdateOrderStatus()
  const refund = useRefundOrder()
  const reorder = useReorder()
  const navigate = useNavigate()
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

  const handleReorder = () =>
    reorder.mutate(order, {
      onSuccess: ({ added, unavailable }) => {
        if (added === 0) {
          toast.error('Не удалось добавить позиции — предложения устарели')
          return
        }
        toast.success(
          `Добавлено в корзину: ${added}` +
            (unavailable.length ? `. Недоступно: ${unavailable.join(', ')}` : ''),
        )
        void navigate({ to: '/cart' })
      },
      onError: (error) => toast.error(describeApiError(error)),
    })

  return (
    <Shell>
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link to="/orders">← К заказам</Link>
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={reorder.isPending || order.items.length === 0}
            onClick={handleReorder}
          >
            {reorder.isPending ? <Spinner /> : null}
            Повторить заказ
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => window.print()}>
            Печать сметы для клиента
          </Button>
        </div>
      </div>

      {/* Рабочая карточка: закуп, цена для клиента и маржа. На печать не идёт. */}
      <Card className="print:hidden">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Заказ № {order.number}</CardTitle>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
          <Typography tone="muted" variant="bodySm">
            от {new Date(placed).toLocaleString('ru-RU')}
            {order.vehicleVin ? ` · VIN ${order.vehicleVin}` : ''}
            {order.customer
              ? ` · ${order.customer.name}${order.customer.phone ? `, ${order.customer.phone}` : ''}`
              : ''}
          </Typography>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="hidden grid-cols-[1fr_auto_auto] gap-x-6 text-right sm:grid">
            <span />
            <Typography variant="bodyXs" tone="muted">
              Закуп
            </Typography>
            <Typography variant="bodyXs" tone="muted">
              Клиенту
            </Typography>
          </div>
          {order.items.map((item) => (
            <OrderItemRow key={item.id} item={item} />
          ))}
          <Separator />
          <div className="grid gap-1 sm:grid-cols-[1fr_auto_auto] sm:gap-x-6 sm:text-right">
            <Typography variant="bodySm" tone="muted">
              Итого ({order.itemCount} шт.)
            </Typography>
            <Typography variant="h5">{formatMoney(order.total)}</Typography>
            <Typography variant="h5">{formatMoney(order.saleTotal)}</Typography>
          </div>
          <Typography variant="bodyXs" tone="muted" className="sm:text-right">
            Маржа автосервиса: {formatMoney(order.marginTotal)} (
            {marginPercent(order.total.amount, order.saleTotal.amount).toLocaleString('ru-RU')} %
            к закупу)
          </Typography>
        </CardContent>
      </Card>

      {/* Смета для клиента: только цены для клиента, без закупа и маржи. */}
      <Estimate order={order} organization={organization.data?.organization ?? null} />

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
              Оплатить {formatMoney(order.total)}
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
      <div className="grid gap-1 sm:grid-cols-[1fr_auto_auto] sm:items-start sm:gap-x-6">
        <div className="min-w-0">
          <Typography variant="bodySmMedium">{item.partName}</Typography>
          <Typography variant="bodyXs" tone="muted">
            {item.brand} · {item.oemNumber} · {item.quantity} шт.
          </Typography>
          <button
            type="button"
            onClick={() => setShowAnalogs((value) => !value)}
            className="text-xs text-primary hover:underline"
          >
            {showAnalogs ? 'Скрыть аналоги' : 'Показать аналоги'}
          </button>
        </div>
        <Typography variant="bodySmMedium" className="shrink-0 sm:text-right">
          {formatMoney(item.lineTotal)}
        </Typography>
        <Typography variant="bodySmMedium" className="shrink-0 sm:text-right">
          {formatMoney(item.saleLineTotal)}
        </Typography>
      </div>
      {showAnalogs ? <AnalogsPanel oemNumber={item.oemNumber} /> : null}
    </div>
  )
}

/**
 * Печатная смета для клиента автосервиса. Показывается только на печати:
 * в ней нет закупочных цен и маржи, зато есть автосервис, клиент и машина.
 */
function Estimate({ order, organization }: { order: OrderDto; organization: OrganizationDto | null }) {
  const placed = order.placedAt ?? order.createdAt
  return (
    <div className="hidden print:block">
      <div className="grid gap-1">
        <Typography variant="h3">{organization?.name ?? 'Автосервис'}</Typography>
        {organization?.phone ? <Typography variant="bodySm">{organization.phone}</Typography> : null}
        <Typography variant="h4" className="pt-3">
          Смета № {order.number} от {new Date(placed).toLocaleDateString('ru-RU')}
        </Typography>
        {order.customer ? (
          <Typography variant="bodySm">
            Клиент: {order.customer.name}
            {order.customer.phone ? `, ${order.customer.phone}` : ''}
          </Typography>
        ) : null}
        {order.vehicleVin ? <Typography variant="bodySm">VIN: {order.vehicleVin}</Typography> : null}
      </div>
      <table className="mt-4 w-full">
        <thead>
          <tr className="border-b text-left">
            <th className="py-1">
              <Typography variant="bodySmMedium">Позиция</Typography>
            </th>
            <th className="py-1 text-right">
              <Typography variant="bodySmMedium">Кол-во</Typography>
            </th>
            <th className="py-1 text-right">
              <Typography variant="bodySmMedium">Цена</Typography>
            </th>
            <th className="py-1 text-right">
              <Typography variant="bodySmMedium">Сумма</Typography>
            </th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((item) => (
            <tr key={item.id} className="border-b">
              <td className="py-1">
                <Typography variant="bodySm">
                  {item.partName} · {item.brand}
                </Typography>
              </td>
              <td className="py-1 text-right">
                <Typography variant="bodySm">{item.quantity}</Typography>
              </td>
              <td className="py-1 text-right">
                <Typography variant="bodySm">{formatMoney(item.salePrice)}</Typography>
              </td>
              <td className="py-1 text-right">
                <Typography variant="bodySm">{formatMoney(item.saleLineTotal)}</Typography>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3} className="py-2 text-right">
              <Typography variant="bodySmMedium">Итого</Typography>
            </td>
            <td className="py-2 text-right">
              <Typography variant="h5">{formatMoney(order.saleTotal)}</Typography>
            </td>
          </tr>
        </tfoot>
      </table>
      {order.notes ? (
        <Typography variant="bodyXs" tone="muted" className="pt-3">
          {order.notes}
        </Typography>
      ) : null}
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
          placeholder="Комментарий: договорённости, особенности… Печатается в смете."
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
