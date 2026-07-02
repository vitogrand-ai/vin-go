import { Link, useNavigate } from '@tanstack/react-router'
import type { OrderItemDto } from '@web-app-demo/contracts'
import { useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { Typography } from '@/components/ui/typography'
import { AnalogsPanel } from '@/features/catalog/AnalogsPanel'
import { RequireAuth } from '@/features/cabinet/RequireAuth'
import {
  useCart,
  useCheckout,
  useClearCart,
  useGarage,
  useRemoveCartItem,
  useSetCartVehicle,
  useUpdateCartItem,
} from '@/features/cabinet/queries'
import { describeApiError } from '@/lib/errors'
import { formatDelivery, formatMoney, TIER_META } from '@/lib/format'

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
      <VehicleSelector currentVin={order.vehicleVin} />

      <div className="grid gap-3">
        {order.items.map((item) => (
          <CartRow key={item.id} item={item} />
        ))}
      </div>

      <Separator />

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="grid gap-0.5">
          <Typography variant="bodyXs" tone="muted">
            Итого ({order.itemCount} шт.)
          </Typography>
          <Typography variant="h3">{formatMoney(order.total)}</Typography>
        </div>
        <div className="flex items-center gap-2">
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
                  toast.success(`Заказ оформлен на ${formatMoney(data.order.total)}`)
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
      </div>
    </CartShell>
  )
}

function VehicleSelector({ currentVin }: { currentVin: string | null }) {
  const garage = useGarage()
  const setVehicle = useSetCartVehicle()
  const vehicles = garage.data?.vehicles ?? []

  if (vehicles.length === 0) {
    return (
      <Typography variant="bodySm" tone="muted">
        Добавьте автомобиль в{' '}
        <Link to="/garage" className="text-primary hover:underline">
          гараже
        </Link>
        , чтобы привязать его к заказу.
      </Typography>
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
              {(vehicle.nickname ?? `${vehicle.make} ${vehicle.model}`) + ` — ${vehicle.vin}`}
            </option>
          ))}
        </select>
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

        <div className="w-24 text-right">
          <Typography variant="bodySmMedium">{formatMoney(item.lineTotal)}</Typography>
          <Typography variant="bodyXs" tone="muted">
            {formatMoney(item.price)} / шт.
          </Typography>
        </div>

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
