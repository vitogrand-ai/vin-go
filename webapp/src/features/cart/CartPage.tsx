import { Link, useNavigate } from '@tanstack/react-router'
import { marginPercent, type OrderDto, type OrderItemDto } from '@web-app-demo/contracts'
import { useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { Typography } from '@/components/ui/typography'
import { AnalogsPanel } from '@/features/catalog/AnalogsPanel'
import { RequireAuth } from '@/features/cabinet/RequireAuth'
import {
  useCart,
  useCheckout,
  useClearCart,
  useCustomers,
  useGarage,
  useRemoveCartItem,
  useSetCartCustomer,
  useSetCartVehicle,
  useUpdateCartItem,
  useUpdateCartItemSalePrice,
} from '@/features/cabinet/queries'
import { describeApiError } from '@/lib/errors'
import { formatDelivery, formatMarkup, formatMoney, parseRubInput, TIER_META } from '@/lib/format'

export function CartPage() {
  return (
    <RequireAuth>
      <Cart />
    </RequireAuth>
  )
}

function Cart() {
  const navigate = useNavigate()
  const cart = useCart()
  const checkout = useCheckout()
  const clearCart = useClearCart()

  if (cart.isPending) {
    return (
      <CartShell>
        <div className="flex items-center gap-3">
          <Spinner />
          <Typography tone="muted">Загружаем корзину…</Typography>
        </div>
      </CartShell>
    )
  }

  const order = cart.data?.order ?? null

  if (!order || order.items.length === 0) {
    return (
      <CartShell>
        <Typography tone="muted">Корзина пуста.</Typography>
        <Button asChild size="lg" className="w-fit">
          <Link to="/search">Перейти к поиску</Link>
        </Button>
      </CartShell>
    )
  }

  return (
    <CartShell>
      <div className="grid gap-3 sm:grid-cols-2">
        <VehicleSelector currentVin={order.vehicleVin} />
        <CustomerSelector currentCustomerId={order.customer?.id ?? null} />
      </div>

      <div className="grid gap-3">
        {order.items.map((item) => (
          <CartRow key={item.id} item={item} />
        ))}
      </div>

      <Separator />

      <Totals order={order} />

      {/* Работы и данные приёма живут в карточке заказа: корзина — это тот же черновик. */}
      <Typography variant="bodySm" tone="muted">
        Работы, причина обращения и срок —{' '}
        <Link to="/orders/$id" params={{ id: order.id }} className="text-primary hover:underline">
          в заказ-наряде
        </Link>
        {order.works.length > 0
          ? ` (работ: ${order.works.length}, ${formatMoney(order.worksTotal)})`
          : ''}
        .
      </Typography>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={clearCart.isPending}
          onClick={() =>
            clearCart.mutate(undefined, {
              onError: (error) => toast.error(describeApiError(error)),
            })
          }
        >
          Очистить
        </Button>
        <Button
          type="button"
          size="lg"
          disabled={checkout.isPending}
          onClick={() =>
            checkout.mutate(undefined, {
              onSuccess: (data) => {
                toast.success(`Заказ № ${data.order.number} оформлен на ${formatMoney(data.order.total)}`)
                void navigate({ to: '/orders' })
              },
              onError: (error) => toast.error(describeApiError(error)),
            })
          }
        >
          {checkout.isPending ? <Spinner /> : null}
          Оформить заказ
        </Button>
      </div>
    </CartShell>
  )
}

/**
 * Три суммы, которые нужны приёмщику: сколько платим поставщику, сколько
 * называем клиенту и что остаётся автосервису.
 */
function Totals({ order }: { order: OrderDto }) {
  const percent = marginPercent(order.total.amount, order.saleTotal.amount)
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="grid gap-0.5 rounded-lg border p-4">
        <Typography variant="bodyXs" tone="muted">
          Закуп ({order.itemCount} шт.)
        </Typography>
        <Typography variant="h4">{formatMoney(order.total)}</Typography>
      </div>
      <div className="grid gap-0.5 rounded-lg border border-primary p-4">
        <Typography variant="bodyXs" tone="muted">
          Клиенту
        </Typography>
        <Typography variant="h4">{formatMoney(order.saleTotal)}</Typography>
      </div>
      <div className="grid gap-0.5 rounded-lg border p-4">
        <Typography variant="bodyXs" tone="muted">
          Маржа автосервиса
        </Typography>
        <Typography variant="h4" tone={order.marginTotal.amount < 0 ? 'destructive' : undefined}>
          {formatMoney(order.marginTotal)}
        </Typography>
        <Typography variant="bodyXs" tone="muted">
          {percent.toLocaleString('ru-RU')} % к закупу
        </Typography>
      </div>
    </div>
  )
}

function VehicleSelector({ currentVin }: { currentVin: string | null }) {
  const garage = useGarage()
  const setVehicle = useSetCartVehicle()
  const vehicles = garage.data?.vehicles ?? []

  if (vehicles.length === 0) {
    return (
      <Card size="sm">
        <CardContent className="pt-6">
          <Typography variant="bodySm" tone="muted">
            Добавьте автомобиль в{' '}
            <Link to="/garage" className="text-primary hover:underline">
              гараже
            </Link>
            , чтобы привязать его к заказу.
          </Typography>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card size="sm">
      <CardContent className="grid gap-2 pt-6">
        <Typography variant="label" tone="muted">
          Автомобиль заказа
        </Typography>
        <select
          value={currentVin ?? ''}
          onChange={(event) =>
            event.target.value &&
            setVehicle.mutate(event.target.value, {
              onError: (error) => toast.error(describeApiError(error)),
            })
          }
          className="h-9 rounded-md border bg-input/30 px-3 text-sm"
        >
          <option value="" disabled>
            Выберите авто из гаража
          </option>
          {vehicles.map((vehicle) => (
            <option key={vehicle.id} value={vehicle.vin}>
              {(vehicle.plate ? `${vehicle.plate} · ` : '') +
                (vehicle.nickname ?? `${vehicle.make} ${vehicle.model}`) +
                ` — ${vehicle.vin}`}
            </option>
          ))}
        </select>
      </CardContent>
    </Card>
  )
}

/** Клиент автосервиса для сметы. Подставляется сам, если авто из гаража привязано к клиенту. */
function CustomerSelector({ currentCustomerId }: { currentCustomerId: string | null }) {
  const customers = useCustomers()
  const setCustomer = useSetCartCustomer()
  const list = customers.data?.customers ?? []

  return (
    <Card size="sm">
      <CardContent className="grid gap-2 pt-6">
        <Typography variant="label" tone="muted">
          Клиент (для сметы)
        </Typography>
        {list.length === 0 ? (
          <Typography variant="bodySm" tone="muted">
            Заведите клиента в разделе{' '}
            <Link to="/customers" className="text-primary hover:underline">
              «Клиенты»
            </Link>
            , чтобы смета была на его имя.
          </Typography>
        ) : (
          <select
            value={currentCustomerId ?? ''}
            onChange={(event) =>
              setCustomer.mutate(event.target.value === '' ? null : event.target.value, {
                onError: (error) => toast.error(describeApiError(error)),
              })
            }
            className="h-9 rounded-md border bg-input/30 px-3 text-sm"
          >
            <option value="">Без клиента</option>
            {list.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
                {customer.phone ? ` · ${customer.phone}` : ''}
              </option>
            ))}
          </select>
        )}
      </CardContent>
    </Card>
  )
}

function CartRow({ item }: { item: OrderItemDto }) {
  const updateItem = useUpdateCartItem()
  const removeItem = useRemoveCartItem()
  const [showAnalogs, setShowAnalogs] = useState(false)

  const setQuantity = (quantity: number) => {
    if (quantity < 1 || quantity > 99) return
    updateItem.mutate(
      { itemId: item.id, quantity },
      { onError: (error) => toast.error(describeApiError(error)) },
    )
  }

  return (
    <Card size="sm">
      <CardContent className="flex flex-wrap items-center gap-4 pt-6">
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <Typography variant="bodySmMedium">{item.partName}</Typography>
            {item.tier ? (
              <Badge variant="secondary">{TIER_META[item.tier].label}</Badge>
            ) : null}
          </div>
          <Typography variant="bodyXs" tone="muted">
            {item.brand} · {item.supplierName} · {formatDelivery(item.deliveryDays)}
          </Typography>
          <Typography variant="code" tone="muted">
            {item.oemNumber}
          </Typography>
          <button
            type="button"
            onClick={() => setShowAnalogs((value) => !value)}
            className="w-fit text-xs text-primary hover:underline"
          >
            {showAnalogs ? 'Скрыть аналоги' : 'Показать аналоги'}
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={updateItem.isPending || item.quantity <= 1}
            onClick={() => setQuantity(item.quantity - 1)}
            aria-label="Меньше"
          >
            −
          </Button>
          <Typography variant="bodySmMedium" className="w-6 text-center">
            {item.quantity}
          </Typography>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={updateItem.isPending || item.quantity >= 99}
            onClick={() => setQuantity(item.quantity + 1)}
            aria-label="Больше"
          >
            +
          </Button>
        </div>

        <div className="grid w-28 gap-0.5 text-right">
          <Typography variant="bodyXs" tone="muted">
            Закуп
          </Typography>
          <Typography variant="bodySmMedium">{formatMoney(item.lineTotal)}</Typography>
          <Typography variant="bodyXs" tone="muted">
            {formatMoney(item.price)} / шт.
          </Typography>
        </div>

        <SalePriceEditor item={item} />

        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={removeItem.isPending}
          onClick={() =>
            removeItem.mutate(item.id, {
              onError: (error) => toast.error(describeApiError(error)),
            })
          }
          aria-label="Удалить позицию"
        >
          ✕
        </Button>

        {showAnalogs ? (
          <div className="w-full">
            <AnalogsPanel oemNumber={item.oemNumber} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

/**
 * Цена для клиента за штуку: по умолчанию закуп × наценка автосервиса, но
 * приёмщик часто округляет или уступает — правится прямо в строке.
 */
function SalePriceEditor({ item }: { item: OrderItemDto }) {
  const updateSalePrice = useUpdateCartItemSalePrice()
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? (item.salePrice.amount / 100).toString()

  const commit = () => {
    if (draft === null) return
    const kopecks = parseRubInput(draft)
    setDraft(null)
    if (kopecks === null || kopecks === item.salePrice.amount) return
    updateSalePrice.mutate(
      { itemId: item.id, saleAmount: kopecks },
      { onError: (error) => toast.error(describeApiError(error)) },
    )
  }

  return (
    <div className="grid w-36 gap-0.5">
      <Typography variant="bodyXs" tone="muted">
        Клиенту, ₽ / шт.
      </Typography>
      <Input
        value={value}
        inputMode="decimal"
        aria-label="Цена для клиента за штуку"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
        }}
        className="h-8 text-right"
      />
      <Typography variant="bodyXs" tone="muted">
        {formatMoney(item.saleLineTotal)} · наценка {formatMarkup(item.markupBps)}
      </Typography>
    </div>
  )
}

function CartShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="mx-auto grid w-full max-w-6xl gap-6 px-5 py-10">
      <div className="grid gap-3">
        <Badge variant="outline" className="w-fit">
          Корзина
        </Badge>
        <Typography variant="h1">Корзина</Typography>
      </div>
      {children}
    </section>
  )
}
