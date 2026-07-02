import { Link } from '@tanstack/react-router'
import { allowedOrderTransitions, type OrderDto, type OrderStatus } from '@web-app-demo/contracts'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { Typography } from '@/components/ui/typography'
import { RequireAuth } from '@/features/cabinet/RequireAuth'
import { useCreatePayment, useOrders, useUpdateOrderStatus } from '@/features/cabinet/queries'
import { describeApiError } from '@/lib/errors'
import { formatMoney } from '@/lib/format'
import { STATUS_LABEL, TRANSITION_LABEL } from './status'

const FILTERABLE_STATUSES: OrderStatus[] = [
  'PLACED',
  'PAID',
  'PROCESSING',
  'READY',
  'COMPLETED',
  'CANCELLED',
]

export function OrdersPage() {
  return (
    <RequireAuth>
      <Orders />
    </RequireAuth>
  )
}

function Orders() {
  const orders = useOrders()
  const [statusFilter, setStatusFilter] = useState<OrderStatus | 'ALL'>('ALL')
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const list = orders.data?.orders ?? []
    return list.filter(
      (order) =>
        (statusFilter === 'ALL' || order.status === statusFilter) && matchesSearch(order, search),
    )
  }, [orders.data?.orders, statusFilter, search])

  return (
    <section className="mx-auto grid w-full max-w-6xl gap-6 px-5 py-10">
      <div className="grid gap-3">
        <Badge variant="outline" className="w-fit">
          Заказы
        </Badge>
        <Typography variant="h1">История заказов</Typography>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as OrderStatus | 'ALL')}
          className="h-9 rounded-md border bg-input/30 px-3 text-sm"
        >
          <option value="ALL">Все статусы</option>
          {FILTERABLE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABEL[status].label}
            </option>
          ))}
        </select>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Поиск: VIN, запчасть, № заказа"
          className="max-w-xs"
        />
      </div>

      {orders.isPending ? (
        <div className="flex items-center gap-3">
          <Spinner />
          <Typography tone="muted">Загружаем заказы…</Typography>
        </div>
      ) : (orders.data?.orders.length ?? 0) === 0 ? (
        <Typography tone="muted">Заказов пока нет.</Typography>
      ) : filtered.length === 0 ? (
        <Typography tone="muted">Под фильтры ничего не подходит.</Typography>
      ) : (
        <div className="grid gap-4">
          {filtered.map((order) => (
            <OrderCard key={order.id} order={order} />
          ))}
        </div>
      )}
    </section>
  )
}

function matchesSearch(order: OrderDto, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (order.id.toLowerCase().includes(q)) return true
  if (order.vehicleVin?.toLowerCase().includes(q)) return true
  return order.items.some(
    (item) =>
      item.partName.toLowerCase().includes(q) ||
      item.brand.toLowerCase().includes(q) ||
      item.oemNumber.toLowerCase().includes(q),
  )
}

function OrderCard({ order }: { order: OrderDto }) {
  const status = STATUS_LABEL[order.status]
  const placed = order.placedAt ?? order.createdAt
  const createPayment = useCreatePayment()
  const updateStatus = useUpdateOrderStatus()

  const canPay = order.status === 'PLACED' && order.paymentStatus !== 'SUCCEEDED'
  const transitions = allowedOrderTransitions(order.status)

  const handleStatus = (target: OrderStatus) => {
    updateStatus.mutate(
      { orderId: order.id, status: target },
      {
        onSuccess: () => toast.success(`Статус: ${STATUS_LABEL[target].label}`),
        onError: (error) => toast.error(describeApiError(error)),
      },
    )
  }

  const handlePay = () => {
    createPayment.mutate(
      { orderId: order.id },
      {
      onSuccess: (data) => {
        const url = data.payment.confirmationUrl
        if (url) {
          window.location.href = url
        } else {
          toast.error('Провайдер не вернул ссылку на оплату')
        }
      },
      onError: (error) => toast.error(describeApiError(error)),
    })
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>
            <Link
              to="/orders/$id"
              params={{ id: order.id }}
              className="hover:underline"
            >
              Заказ № {order.id.slice(0, 8).toUpperCase()}
            </Link>
          </CardTitle>
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>
        <CardDescription>
          {new Date(placed).toLocaleDateString('ru-RU')} · {order.itemCount} шт. ·{' '}
          {order.vehicleVin ? `VIN ${order.vehicleVin}` : 'без авто'}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Separator />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid gap-0.5">
            <Typography variant="bodyXs" tone="muted">
              Итого
            </Typography>
            <Typography variant="h5">{formatMoney(order.total)}</Typography>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline">
              <Link to="/orders/$id" params={{ id: order.id }}>
                Открыть
              </Link>
            </Button>
            {canPay ? (
              <Button type="button" disabled={createPayment.isPending} onClick={handlePay}>
                {createPayment.isPending ? <Spinner /> : null}
                Оплатить
              </Button>
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
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
