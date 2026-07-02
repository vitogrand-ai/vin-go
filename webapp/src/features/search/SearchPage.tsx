import { useMutation, useQuery } from '@tanstack/react-query'
import { useSearch } from '@tanstack/react-router'
import type { Offer, OfferTier, Part, TierPick, Vehicle } from '@web-app-demo/contracts'
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
import { useAddCartItem } from '@/features/cabinet/queries'
import { ApiRequestError } from '@/lib/api'
import { describeApiError } from '@/lib/errors'
import { formatDelivery, formatMoney, TIER_META } from '@/lib/format'
import { publicApi } from '@/lib/public-api'
import {
  pushSearchHistory,
  readSearchHistory,
  type SearchHistoryEntry,
} from '@/lib/search-history'
import { useAuth } from '@/lib/use-auth'
import { cn } from '@/lib/utils'

type AddToCart = (offer: Offer, tier?: OfferTier) => void

const DEMO_VINS = ['WVWZZZ1JZ3W386752', 'XTA210990Y2293564', 'JTDBR32E430123456']
const DEMO_PLATES = ['А123ВС777', 'О001АА199', 'Е777КХ797']

type SearchMode = 'vin' | 'plate'

export function SearchPage() {
  // Deep-link: /search?vin=... прификлит VIN (кнопка «Подобрать запчасти» из гаража).
  const urlSearch = useSearch({ strict: false }) as { vin?: string }
  const [mode, setMode] = useState<SearchMode>('vin')
  const [vin, setVin] = useState(() => (urlSearch.vin ?? '').toUpperCase())
  const [plate, setPlate] = useState('')
  const [query, setQuery] = useState('')
  const [selectedPart, setSelectedPart] = useState<Part | null>(null)
  const [history, setHistory] = useState<SearchHistoryEntry[]>(() => readSearchHistory())

  const search = useMutation({
    mutationFn: (resolvedVin: string) => publicApi.searchParts({ vin: resolvedVin, query }),
    onSuccess: () => setSelectedPart(null),
  })

  // Госномер → VIN, затем сразу поиск по найденному VIN.
  const plateLookup = useMutation({
    mutationFn: () => publicApi.resolvePlate({ plate }),
    onSuccess: (data) => {
      setVin(data.vehicle.vin)
      toast.success(`Авто определено: ${data.vehicle.make} ${data.vehicle.model}`)
      search.mutate(data.vehicle.vin)
      setHistory(pushSearchHistory({ mode: 'plate', value: plate, query }))
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const isBusy = search.isPending || plateLookup.isPending

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!query.trim()) return
    if (mode === 'vin') {
      if (vin.trim()) {
        search.mutate(vin, {
          onSuccess: () => setHistory(pushSearchHistory({ mode: 'vin', value: vin, query })),
        })
      }
    } else if (plate.trim()) {
      plateLookup.mutate()
    }
  }

  // Клик по записи истории — прификл формы (пользователь жмёт «Найти»).
  const applyHistory = (entry: SearchHistoryEntry) => {
    setMode(entry.mode)
    if (entry.mode === 'vin') setVin(entry.value)
    else setPlate(entry.value)
    setQuery(entry.query)
  }

  const vehicle = search.data?.vehicle ?? null
  const parts = search.data?.parts ?? []

  return (
    <section className="mx-auto grid w-full max-w-6xl gap-8 px-5 py-10">
      <div className="grid gap-3">
        <Badge variant="outline" className="w-fit">
          Подбор по VIN
        </Badge>
        <Typography variant="h1" className="max-w-3xl">
          Найдите запчасть и сравните три варианта цены
        </Typography>
        <Typography tone="muted" className="max-w-2xl">
          Введите VIN автомобиля и название запчасти. Система покажет каталожный номер и
          предложения поставщиков в формате «эконом / оптимальный / оригинал».
        </Typography>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="mb-4 inline-flex rounded-lg border p-0.5">
            {(['vin', 'plate'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={cn(
                  'rounded-md px-3 py-1 text-sm font-medium transition-colors',
                  mode === value
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {value === 'vin' ? 'По VIN' : 'По госномеру'}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto]">
            {mode === 'vin' ? (
              <div className="grid gap-1.5">
                <Typography variant="label" tone="muted">
                  VIN
                </Typography>
                <Input
                  value={vin}
                  onChange={(event) => setVin(event.target.value.toUpperCase())}
                  placeholder="WVWZZZ1JZ3W386752"
                  maxLength={17}
                  autoCapitalize="characters"
                  spellCheck={false}
                  className="font-mono"
                />
              </div>
            ) : (
              <div className="grid gap-1.5">
                <Typography variant="label" tone="muted">
                  Госномер
                </Typography>
                <Input
                  value={plate}
                  onChange={(event) => setPlate(event.target.value.toUpperCase())}
                  placeholder="А123ВС777"
                  maxLength={9}
                  autoCapitalize="characters"
                  spellCheck={false}
                  className="font-mono"
                />
              </div>
            )}
            <div className="grid gap-1.5">
              <Typography variant="label" tone="muted">
                Запчасть
              </Typography>
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="тормозные колодки"
              />
            </div>
            <div className="grid gap-1.5">
              <Typography variant="label" tone="muted" className="sm:opacity-0">
                &nbsp;
              </Typography>
              <Button
                type="submit"
                disabled={isBusy || !query.trim() || (mode === 'vin' ? !vin.trim() : !plate.trim())}
              >
                {isBusy ? <Spinner /> : null}
                Найти
              </Button>
            </div>
          </form>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Typography variant="bodyXs" tone="muted">
              {mode === 'vin' ? 'Демо-VIN:' : 'Демо-номера:'}
            </Typography>
            {(mode === 'vin' ? DEMO_VINS : DEMO_PLATES).map((demo) => (
              <button
                key={demo}
                type="button"
                onClick={() => (mode === 'vin' ? setVin(demo) : setPlate(demo))}
                className="rounded-md border px-2 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-secondary-foreground"
              >
                {demo}
              </button>
            ))}
          </div>

          {history.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Typography variant="bodyXs" tone="muted">
                Недавние:
              </Typography>
              {history.map((entry) => (
                <button
                  key={`${entry.mode}:${entry.value}:${entry.query}`}
                  type="button"
                  onClick={() => applyHistory(entry)}
                  className="rounded-md border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-secondary-foreground"
                >
                  <span className="font-mono">{entry.value}</span> · {entry.query}
                </button>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {search.isError ? (
        <Typography tone="destructive">{describeError(search.error)}</Typography>
      ) : null}

      {vehicle ? <VehicleCard vehicle={vehicle} /> : null}

      {search.isSuccess ? (
        <PartsList parts={parts} selectedPart={selectedPart} onSelect={setSelectedPart} />
      ) : null}

      {selectedPart ? (
        <OffersPanel part={selectedPart} vehicleVin={vehicle?.vin} />
      ) : null}
    </section>
  )
}

function VehicleCard({ vehicle }: { vehicle: Vehicle }) {
  const facts: Array<[string, string]> = [
    ['Марка', vehicle.make],
    ['Модель', vehicle.model],
    ['Год', String(vehicle.year)],
    ['Двигатель', vehicle.engine ?? '—'],
    ['Кузов', vehicle.bodyType ?? '—'],
  ]

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          {vehicle.make} {vehicle.model}
        </CardTitle>
        <CardDescription className="font-mono">{vehicle.vin}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
          {facts.map(([label, value]) => (
            <div key={label} className="grid gap-0.5">
              <Typography as="dt" variant="bodyXs" tone="muted">
                {label}
              </Typography>
              <Typography as="dd" variant="bodySmMedium">
                {value}
              </Typography>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  )
}

function PartsList({
  parts,
  selectedPart,
  onSelect,
}: {
  parts: Part[]
  selectedPart: Part | null
  onSelect: (part: Part) => void
}) {
  if (parts.length === 0) {
    return (
      <Card size="sm">
        <CardContent className="pt-6">
          <Typography tone="muted">
            По этому запросу ничего не найдено. Попробуйте другое название запчасти.
          </Typography>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="grid gap-3">
      <Typography variant="h4">Найденные запчасти</Typography>
      <div className="grid gap-2">
        {parts.map((part) => {
          const isActive = selectedPart?.oemNumber === part.oemNumber
          return (
            <button
              key={part.oemNumber}
              type="button"
              onClick={() => onSelect(part)}
              className={cn(
                'grid gap-1 rounded-lg border bg-card p-4 text-left transition-colors',
                'hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isActive && 'border-primary bg-secondary',
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Typography variant="bodySmMedium">{part.name}</Typography>
                <Typography variant="code" tone="muted">
                  {part.oemNumber}
                </Typography>
              </div>
              <Typography variant="bodyXs" tone="muted">
                {part.category}
              </Typography>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function OffersPanel({ part, vehicleVin }: { part: Part; vehicleVin?: string }) {
  const auth = useAuth()
  const addCartItem = useAddCartItem()
  const offersQuery = useQuery({
    queryKey: ['offers', part.oemNumber],
    queryFn: () => publicApi.offers({ oemNumber: part.oemNumber }),
  })

  const handleAdd: AddToCart = (offer, tier) => {
    if (!auth.isAuthenticated) {
      toast.info('Войдите в аккаунт, чтобы добавлять запчасти в корзину')
      return
    }
    addCartItem.mutate(
      {
        oemNumber: part.oemNumber,
        offerId: offer.id,
        partName: part.name,
        tier,
        vehicleVin: vehicleVin && /^[A-HJ-NPR-Z0-9]{17}$/.test(vehicleVin) ? vehicleVin : undefined,
      },
      {
        onSuccess: () => toast.success(`«${part.name}» добавлено в корзину`),
        onError: (error) => toast.error(describeApiError(error)),
      },
    )
  }

  if (offersQuery.isPending) {
    return (
      <Card size="sm">
        <CardContent className="flex items-center gap-3 pt-6">
          <Spinner />
          <Typography tone="muted">Загружаем предложения поставщиков…</Typography>
        </CardContent>
      </Card>
    )
  }

  if (offersQuery.isError) {
    return <Typography tone="destructive">{describeError(offersQuery.error)}</Typography>
  }

  const { picks, offers } = offersQuery.data

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <Typography variant="h4">{part.name}</Typography>
        <Typography variant="code" tone="muted">
          OEM {part.oemNumber}
        </Typography>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {picks.map((pick) => (
          <TierCard
            key={pick.tier}
            pick={pick}
            onAdd={handleAdd}
            isAdding={addCartItem.isPending}
          />
        ))}
      </div>

      <Separator />

      <OffersTable offers={offers} onAdd={handleAdd} />
    </div>
  )
}

type OfferSort = 'price' | 'delivery' | 'brand'

function OffersTable({ offers, onAdd }: { offers: Offer[]; onAdd: AddToCart }) {
  const [sort, setSort] = useState<OfferSort>('price')
  const [inStockOnly, setInStockOnly] = useState(false)
  const [originalOnly, setOriginalOnly] = useState(false)

  const visible = useMemo(() => {
    const filtered = offers.filter(
      (offer) => (!inStockOnly || offer.inStock) && (!originalOnly || offer.isOriginal),
    )
    return [...filtered].sort((a, b) => {
      if (sort === 'price') return a.price.amount - b.price.amount
      if (sort === 'delivery') return a.deliveryDays - b.deliveryDays
      return a.brand.localeCompare(b.brand, 'ru')
    })
  }, [offers, sort, inStockOnly, originalOnly])

  return (
    <details className="group" open>
      <summary className="cursor-pointer list-none">
        <Typography variant="control" tone="muted" className="hover:text-foreground">
          Все предложения ({visible.length} из {offers.length}) ▾
        </Typography>
      </summary>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-1.5 text-muted-foreground">
          Сортировка
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as OfferSort)}
            className="rounded-md border bg-background px-2 py-1 text-foreground"
          >
            <option value="price">по цене</option>
            <option value="delivery">по сроку</option>
            <option value="brand">по бренду</option>
          </select>
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-muted-foreground hover:text-foreground">
          <input
            type="checkbox"
            checked={inStockOnly}
            onChange={(event) => setInStockOnly(event.target.checked)}
          />
          В наличии
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-muted-foreground hover:text-foreground">
          <input
            type="checkbox"
            checked={originalOnly}
            onChange={(event) => setOriginalOnly(event.target.checked)}
          />
          Только оригинал
        </label>
      </div>

      <div className="mt-3 overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">Бренд</th>
              <th className="p-3 font-medium">Поставщик</th>
              <th className="p-3 font-medium">Наличие</th>
              <th className="p-3 font-medium">Срок</th>
              <th className="p-3 text-right font-medium">Цена</th>
              <th className="p-3" aria-label="Действие" />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-4 text-center text-muted-foreground">
                  Под фильтры ничего не подходит.
                </td>
              </tr>
            ) : (
              visible.map((offer) => <OfferRow key={offer.id} offer={offer} onAdd={onAdd} />)
            )}
          </tbody>
        </table>
      </div>
    </details>
  )
}

const TIER_ACCENT: Record<TierPick['tier'], string> = {
  ECONOMY: 'border-emerald-500/40',
  BALANCED: 'border-primary',
  ORIGINAL: 'border-amber-500/40',
}

function TierCard({
  pick,
  onAdd,
  isAdding,
}: {
  pick: TierPick
  onAdd: AddToCart
  isAdding: boolean
}) {
  const meta = TIER_META[pick.tier]
  const { offer } = pick

  return (
    <Card className={cn('border-2', TIER_ACCENT[pick.tier])}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <Badge variant={pick.tier === 'BALANCED' ? 'default' : 'secondary'}>{meta.label}</Badge>
          <Typography variant="bodyXs" tone="muted">
            {meta.hint}
          </Typography>
        </div>
        <CardTitle className="pt-2">{formatMoney(offer.price)}</CardTitle>
        <CardDescription>
          {offer.brand} · {offer.supplierName}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <div className="flex items-center justify-between">
          <Typography variant="bodyXs" tone="muted">
            Наличие
          </Typography>
          <Typography variant="bodyXs" tone={offer.inStock ? 'primary' : 'muted'}>
            {offer.inStock ? `В наличии (${offer.quantityAvailable})` : 'Под заказ'}
          </Typography>
        </div>
        <div className="flex items-center justify-between">
          <Typography variant="bodyXs" tone="muted">
            Срок
          </Typography>
          <Typography variant="bodyXs">{formatDelivery(offer.deliveryDays)}</Typography>
        </div>
        <Typography variant="caption" tone="muted">
          {pick.reason}
        </Typography>
        <Button
          type="button"
          size="sm"
          className="mt-1"
          variant={pick.tier === 'BALANCED' ? 'default' : 'outline'}
          disabled={isAdding}
          onClick={() => onAdd(offer, pick.tier)}
        >
          В корзину
        </Button>
      </CardContent>
    </Card>
  )
}

function OfferRow({ offer, onAdd }: { offer: Offer; onAdd: AddToCart }) {
  return (
    <tr className="border-t">
      <td className="p-3">
        <div className="flex items-center gap-2">
          <Typography variant="bodySmMedium">{offer.brand}</Typography>
          {offer.isOriginal ? (
            <Badge variant="outline" className="text-amber-600">
              Оригинал
            </Badge>
          ) : null}
        </div>
        <Typography variant="bodyXs" tone="muted">
          {offer.articleNumber}
        </Typography>
      </td>
      <td className="p-3 text-muted-foreground">{offer.supplierName}</td>
      <td className="p-3">
        {offer.inStock ? (
          <span className="text-emerald-600">{offer.quantityAvailable} шт.</span>
        ) : (
          <span className="text-muted-foreground">Под заказ</span>
        )}
      </td>
      <td className="p-3 text-muted-foreground">{formatDelivery(offer.deliveryDays)}</td>
      <td className="p-3 text-right font-medium">{formatMoney(offer.price)}</td>
      <td className="p-3 text-right">
        <Button type="button" size="xs" variant="ghost" onClick={() => onAdd(offer)}>
          + В корзину
        </Button>
      </td>
    </tr>
  )
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    // Сообщения сервера для 404 контекстны (VIN или госномер).
    if (error.status === 404) return error.message
    if (error.status === 400) return 'Проверьте введённые данные (VIN, госномер или запрос).'
    return error.message
  }
  return 'Не удалось выполнить запрос. Попробуйте ещё раз.'
}
