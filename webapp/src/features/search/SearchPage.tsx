import { useMutation, useQuery } from '@tanstack/react-query'
import { useSearch } from '@tanstack/react-router'
import {
  partsWithVariants,
  vinOrFrameSchema,
  type DealerPrice,
  type Offer,
  type OfferTier,
  type Part,
  type TierPick,
  type Vehicle,
} from '@web-app-demo/contracts'
import { useEffect, useMemo, useRef, useState } from 'react'
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
import {
  useAddCartItem,
  useCatalogStatus,
  useCreateExpertRequest,
} from '@/features/cabinet/queries'
import { CatalogTree } from '@/features/search/CatalogTree'
import { MaintenancePanel } from '@/features/search/MaintenancePanel'
import { SchemeViewer } from '@/features/search/SchemeViewer'
import { ApiRequestError } from '@/lib/api'
import { describeApiError } from '@/lib/errors'
import { formatDelivery, formatMoney, TIER_META } from '@/lib/format'
import { publicApi } from '@/lib/public-api'
import { schemeImageSrc } from '@/lib/scheme-image'
import {
  pushSearchHistory,
  readSearchHistory,
  type SearchHistoryEntry,
} from '@/lib/search-history'
import { useAuth } from '@/lib/use-auth'
import { cn } from '@/lib/utils'

type AddToCart = (offer: Offer, tier?: OfferTier) => void

/** Машины мок-каталога — показываются только пока каталог демонстрационный. */
const DEMO_VINS = ['WVWZZZ1JZ3W386752', 'XTA210990Y2293564', 'LFV3B2FY2N3102396']
const DEMO_PLATES = ['А123ВС777', 'О001АА199', 'У454УС198']

type SearchMode = 'vin' | 'plate'

/**
 * Подбор в два шага, как в боте: сначала машина, потом сколько угодно
 * запросов по ней. Один экран — одна машина: пока она выбрана, всё ниже
 * относится к ней, а «Сменить машину» закрывает подбор целиком. Так не
 * смешиваются выдачи разных клиентов, когда приёмщик работает с несколькими
 * подряд.
 */
export function SearchPage() {
  // Deep-link: /search?vin=... — кнопка «Подобрать запчасти» из гаража.
  const urlSearch = useSearch({ strict: false }) as { vin?: string }
  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [history, setHistory] = useState<SearchHistoryEntry[]>(() => readSearchHistory())

  const startCar = (next: Vehicle) => {
    // Новая машина — новый подбор: прежняя выдача не должна остаться на экране.
    setVehicle((current) => (current?.vin === next.vin ? current : next))
  }

  return (
    <section className="mx-auto grid w-full max-w-6xl gap-6 px-5 py-8 sm:py-10">
      {vehicle ? (
        <CarSearch
          key={vehicle.vin}
          vehicle={vehicle}
          history={history}
          onHistory={setHistory}
          onChangeCar={() => setVehicle(null)}
        />
      ) : (
        <VehicleStep initialVin={urlSearch.vin} history={history} onResolved={startCar} />
      )}
    </section>
  )
}

/** Какое поле формы не прошло проверку — подсвечиваем его и объясняем причину. */
type FormError = { field: 'vehicle' | 'query'; message: string }

/**
 * Шаг 1 — машина. VIN, госномер или недавняя машина из истории.
 */
function VehicleStep({
  initialVin,
  history,
  onResolved,
}: {
  initialVin?: string
  history: SearchHistoryEntry[]
  onResolved: (vehicle: Vehicle) => void
}) {
  const [mode, setMode] = useState<SearchMode>('vin')
  const [vin, setVin] = useState(() => (initialVin ?? '').toUpperCase())
  const [plate, setPlate] = useState('')
  const [formError, setFormError] = useState<FormError | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const status = useCatalogStatus()

  const decode = useMutation({
    mutationFn: (value: string) => publicApi.decodeVin({ vin: value }),
    onSuccess: (data) => onResolved(data.vehicle),
  })
  const plateLookup = useMutation({
    mutationFn: (value: string) => publicApi.resolvePlate({ plate: value }),
    onSuccess: (data) => {
      toast.success(`Авто определено: ${data.vehicle.make} ${data.vehicle.model}`)
      onResolved(data.vehicle)
    },
  })
  const isBusy = decode.isPending || plateLookup.isPending
  const error = decode.error ?? plateLookup.error

  // Пришли по ссылке с VIN — определяем машину сразу, без лишнего нажатия.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (autoStarted.current || !initialVin) return
    autoStarted.current = true
    if (vinOrFrameSchema.safeParse(initialVin).success) decode.mutate(initialVin.toUpperCase())
    // eslint-disable-next-line react-hooks/exhaustive-deps -- один раз при открытии страницы
  }, [initialVin])

  // Кнопка всегда активна: молча заблокированная не объясняет, чего не хватает.
  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const value = (mode === 'vin' ? vin : plate).trim()
    if (!value) {
      setFormError({
        field: 'vehicle',
        message: mode === 'vin' ? 'Введите VIN автомобиля' : 'Введите госномер автомобиля',
      })
      inputRef.current?.focus()
      return
    }
    setFormError(null)
    if (mode === 'vin') decode.mutate(value)
    else plateLookup.mutate(value)
  }

  // Недавние машины — по одной кнопке на VIN, самые свежие первыми.
  const recentCars = useMemo(() => {
    const seen = new Set<string>()
    return history.filter((entry) => {
      if (entry.mode !== 'vin' || seen.has(entry.value)) return false
      seen.add(entry.value)
      return true
    })
  }, [history])

  return (
    <>
      <div className="grid gap-2">
        <Typography variant="h1" className="max-w-3xl">
          Какая машина?
        </Typography>
        <Typography tone="muted" className="max-w-2xl">
          Определим автомобиль по VIN или госномеру, затем подберём запчасти: каталожный номер,
          схема узла и предложения поставщиков в трёх вариантах цены.
        </Typography>
      </div>

      <Card>
        <CardContent className="grid gap-4 pt-6">
          <div className="inline-flex w-fit rounded-lg border p-0.5">
            {(['vin', 'plate'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setMode(value)
                  setFormError(null)
                }}
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

          <form onSubmit={handleSubmit} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-start">
            <div className="grid gap-1.5">
              <Typography variant="label" tone="muted">
                {mode === 'vin' ? 'VIN или номер кузова' : 'Госномер'}
              </Typography>
              {mode === 'vin' ? (
                <Input
                  ref={inputRef}
                  value={vin}
                  onChange={(event) => {
                    setVin(event.target.value.toUpperCase())
                    setFormError(null)
                  }}
                  placeholder="WVWZZZ1JZ3W386752"
                  maxLength={17}
                  autoCapitalize="characters"
                  spellCheck={false}
                  aria-invalid={formError?.field === 'vehicle'}
                  className="font-mono text-base"
                  autoFocus
                />
              ) : (
                <Input
                  ref={inputRef}
                  value={plate}
                  onChange={(event) => {
                    setPlate(event.target.value.toUpperCase())
                    setFormError(null)
                  }}
                  placeholder="А123ВС777"
                  maxLength={9}
                  autoCapitalize="characters"
                  spellCheck={false}
                  aria-invalid={formError?.field === 'vehicle'}
                  className="font-mono text-base"
                  autoFocus
                />
              )}
              <FieldError error={formError} field="vehicle" />
            </div>
            <Button type="submit" size="lg" disabled={isBusy} className="sm:mt-6">
              {isBusy ? <Spinner /> : null}
              Определить машину
            </Button>
          </form>

          {error ? <Typography tone="destructive">{describeError(error)}</Typography> : null}

          {status.data?.catalog.demo ? (
            <ChipRow label={mode === 'vin' ? 'Демо-VIN:' : 'Демо-номера:'}>
              {(mode === 'vin' ? DEMO_VINS : DEMO_PLATES).map((demo) => (
                <Chip
                  key={demo}
                  mono
                  onClick={() => {
                    if (mode === 'vin') setVin(demo)
                    else setPlate(demo)
                    setFormError(null)
                  }}
                >
                  {demo}
                </Chip>
              ))}
            </ChipRow>
          ) : null}

          {recentCars.length > 0 ? (
            <ChipRow label="Недавние машины:">
              {recentCars.map((entry) => (
                <Chip key={entry.value} mono onClick={() => decode.mutate(entry.value)}>
                  {entry.value}
                </Chip>
              ))}
            </ChipRow>
          ) : null}
        </CardContent>
      </Card>
    </>
  )
}

/**
 * Шаг 2 — подбор по выбранной машине. Карточка машины закреплена сверху и
 * остаётся на экране при прокрутке: всё под ней относится к этой машине.
 */
function CarSearch({
  vehicle,
  history,
  onHistory,
  onChangeCar,
}: {
  vehicle: Vehicle
  history: SearchHistoryEntry[]
  onHistory: (next: SearchHistoryEntry[]) => void
  onChangeCar: () => void
}) {
  const [query, setQuery] = useState('')
  const [selectedPart, setSelectedPart] = useState<Part | null>(null)
  const [formError, setFormError] = useState<FormError | null>(null)
  // Дерево узлов по кнопке; после пустой выдачи оно раскрывается само.
  const [treeOpen, setTreeOpen] = useState(false)
  const [maintenanceOpen, setMaintenanceOpen] = useState(false)
  const queryInputRef = useRef<HTMLInputElement>(null)

  const search = useMutation({
    mutationFn: (value: string) => publicApi.searchParts({ vin: vehicle.vin, query: value }),
    onSuccess: (_data, value) => {
      setSelectedPart(null)
      onHistory(pushSearchHistory({ mode: 'vin', value: vehicle.vin, query: value }))
    },
  })

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const value = query.trim()
    if (!value) {
      setFormError({ field: 'query', message: 'Укажите, что ищем — например, «тормозные колодки»' })
      queryInputRef.current?.focus()
      return
    }
    setFormError(null)
    search.mutate(value)
  }

  const runQuery = (value: string) => {
    setQuery(value)
    setFormError(null)
    search.mutate(value)
  }

  // Что уже искали по этой машине — повтор одним нажатием.
  const carQueries = useMemo(() => {
    const seen = new Set<string>()
    return history
      .filter((entry) => entry.value === vehicle.vin && !seen.has(entry.query) && seen.add(entry.query))
      .map((entry) => entry.query)
  }, [history, vehicle.vin])

  const parts = search.data?.parts ?? []

  return (
    <>
      <CurrentCar vehicle={vehicle} onChange={onChangeCar} />

      <Card>
        <CardContent className="grid gap-3 pt-6">
          <form onSubmit={handleSubmit} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-start">
            <div className="grid gap-1.5">
              <Typography variant="label" tone="muted">
                Какая запчасть?
              </Typography>
              <Input
                ref={queryInputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setFormError(null)
                }}
                placeholder="тормозные колодки передние"
                aria-invalid={formError?.field === 'query'}
                className="text-base"
                autoFocus
              />
              <FieldError error={formError} field="query" />
            </div>
            <Button type="submit" size="lg" disabled={search.isPending} className="sm:mt-6">
              {search.isPending ? <Spinner /> : null}
              Найти
            </Button>
          </form>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={maintenanceOpen}
              onClick={() => setMaintenanceOpen((open) => !open)}
            >
              {maintenanceOpen ? 'Скрыть детали ТО' : 'Детали ТО'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={treeOpen}
              onClick={() => setTreeOpen((open) => !open)}
            >
              {treeOpen ? 'Скрыть узлы каталога' : 'Узлы каталога — найти деталь на схеме'}
            </Button>
          </div>
          {carQueries.length > 0 ? (
            <ChipRow label="По этой машине искали:">
              {carQueries.map((value) => (
                <Chip key={value} onClick={() => runQuery(value)}>
                  {value}
                </Chip>
              ))}
            </ChipRow>
          ) : null}
        </CardContent>
      </Card>

      {search.isPending ? (
        <div className="flex items-center gap-3" role="status">
          <Spinner />
          <Typography tone="muted">Ищем в каталогах — до 20 секунд на сложных запросах…</Typography>
        </div>
      ) : null}

      {search.isError ? (
        <Typography tone="destructive">{describeError(search.error)}</Typography>
      ) : null}

      {search.isSuccess ? (
        <PartsList
          parts={parts}
          query={search.variables ?? ''}
          resolvedQuery={search.data.resolvedQuery}
          demo={search.data.source?.demo ?? false}
          selectedPart={selectedPart}
          onSelect={setSelectedPart}
        />
      ) : null}

      {maintenanceOpen ? (
        <MaintenancePanel
          key={vehicle.vin}
          vin={vehicle.vin}
          onPick={setSelectedPart}
          onShowAll={runQuery}
        />
      ) : null}

      {treeOpen || (search.isSuccess && parts.length === 0) ? (
        <CatalogTree
          key={vehicle.vin}
          vin={vehicle.vin}
          onPick={setSelectedPart}
          afterEmptySearch={!treeOpen}
        />
      ) : null}

      {search.isSuccess && parts.length === 0 ? (
        <AskExpert vin={vehicle.vin} query={search.variables ?? query} />
      ) : null}

      {selectedPart ? (
        <OffersPanel part={selectedPart} vehicleVin={vehicle.vin} onPickPart={setSelectedPart} />
      ) : null}
    </>
  )
}

/**
 * Закреплённая карточка выбранной машины. Всё, что ниже, относится к ней;
 * «Сменить машину» закрывает подбор целиком.
 */
function CurrentCar({ vehicle, onChange }: { vehicle: Vehicle; onChange: () => void }) {
  const facts = [vehicle.year ? String(vehicle.year) : null, vehicle.engine, vehicle.bodyType].filter(
    Boolean,
  )
  return (
    <div className="sticky top-0 z-10 -mx-5 border-b bg-background/95 px-5 py-3 backdrop-blur sm:mx-0 sm:rounded-2xl sm:border sm:px-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="grid min-w-0 flex-1 gap-0.5">
          <Typography variant="h5" className="truncate">
            🚗 {vehicle.make} {vehicle.model}
            {facts.length > 0 ? (
              <span className="font-normal text-muted-foreground"> · {facts.join(' · ')}</span>
            ) : null}
          </Typography>
          <Typography variant="code" tone="muted" className="truncate">
            {vehicle.vin}
          </Typography>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onChange}>
          Сменить машину
        </Button>
      </div>
    </div>
  )
}

function ChipRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Typography variant="bodyXs" tone="muted">
        {label}
      </Typography>
      {children}
    </div>
  )
}

function Chip({
  mono,
  onClick,
  children,
}: {
  mono?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md border px-2 py-0.5 text-xs text-muted-foreground transition-colors',
        'hover:bg-secondary hover:text-secondary-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        mono && 'font-mono',
      )}
    >
      {children}
    </button>
  )
}

/**
 * Тупик «ничего не найдено» превращается в заявку живому подборщику: каталоги
 * не покрывают всё, и это честный запасной путь вместо «попробуйте другое слово».
 */
function AskExpert({ vin, query }: { vin: string; query: string }) {
  const auth = useAuth()
  const create = useCreateExpertRequest()
  const [comment, setComment] = useState('')
  const [sentNumber, setSentNumber] = useState<number | null>(null)

  if (sentNumber !== null) {
    return (
      <Card size="sm">
        <CardContent className="grid gap-2 pt-6">
          <Typography variant="bodySmMedium">Заявка № {sentNumber} отправлена эксперту</Typography>
          <Typography variant="bodySm" tone="muted">
            Ответ с каталожными номерами придёт уведомлением и появится в разделе «Эксперт».
          </Typography>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Спросить эксперта</CardTitle>
        <CardDescription>
          Живой подборщик найдёт каталожный номер по VIN {vin} для запроса «{query}» и пришлёт
          ответ в кабинет и в Telegram.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {auth.isAuthenticated ? (
          <>
            <Input
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Уточнение: сторона, двигатель, что уже пробовали (необязательно)"
              maxLength={1000}
            />
            <Button
              type="button"
              className="w-fit"
              disabled={create.isPending}
              onClick={() =>
                create.mutate(
                  { vin, query, comment: comment.trim() || undefined },
                  {
                    onSuccess: (data) => setSentNumber(data.request.number),
                    onError: (error) => toast.error(describeApiError(error)),
                  },
                )
              }
            >
              {create.isPending ? <Spinner /> : null}
              Отправить эксперту
            </Button>
          </>
        ) : (
          <Typography variant="bodySm" tone="muted">
            Войдите в кабинет, чтобы отправить запрос эксперту.
          </Typography>
        )}
      </CardContent>
    </Card>
  )
}

function FieldError({ error, field }: { error: FormError | null; field: FormError['field'] }) {
  if (error?.field !== field) return null

  return (
    <Typography variant="bodyXs" tone="destructive" role="alert">
      {error.message}
    </Typography>
  )
}

function PartsList({
  parts,
  query,
  resolvedQuery,
  demo,
  selectedPart,
  onSelect,
}: {
  parts: Part[]
  query: string
  resolvedQuery?: string
  demo: boolean
  selectedPart: Part | null
  onSelect: (part: Part) => void
}) {
  // Исполнения одной позиции (пять АКБ под одной выноской) названием не
  // различаются: выбор по тому, что стоит на машине, — различие и подсказка видны в списке.
  const variants = useMemo(() => partsWithVariants(parts), [parts])

  if (parts.length === 0) {
    return (
      <Card size="sm">
        <CardContent className="pt-6">
          <Typography tone="muted">
            По запросу «{query}» ничего не найдено. Попробуйте другое название запчасти или
            уточните узел — например, «колодки передние».
          </Typography>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Typography variant="h4">Найдено: {parts.length}</Typography>
        <Typography variant="bodySm" tone="muted">
          по запросу «{query}»
          {/* Искали другим словом — говорим прямо, иначе выдача по «гранатке» выглядит случайной. */}
          {resolvedQuery ? ` — искали как «${resolvedQuery}»` : ''}
        </Typography>
        {demo ? (
          <Badge variant="outline" className="border-amber-500/60 text-amber-700">
            Демо-каталог
          </Badge>
        ) : null}
      </div>
      {variants.size > 0 ? (
        <Typography variant="bodySm" tone="muted">
          Одна позиция в нескольких исполнениях — сверьте примечание с тем, что стоит на машине
          (маркировка на детали).
        </Typography>
      ) : null}
      <div className="grid gap-2">
        {parts.map((part) => {
          const isActive = selectedPart?.oemNumber === part.oemNumber
          return (
            <button
              key={part.oemNumber}
              type="button"
              onClick={() => onSelect(part)}
              aria-pressed={isActive}
              className={cn(
                'flex items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors sm:p-4',
                'hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isActive && 'border-primary bg-secondary',
              )}
            >
              {part.imageUrl ? (
                <img
                  src={schemeImageSrc(part.imageUrl)}
                  alt=""
                  loading="lazy"
                  className="h-14 w-14 shrink-0 rounded border bg-white object-contain"
                />
              ) : null}
              <div className="grid min-w-0 flex-1 gap-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Typography variant="bodySmMedium">{part.name}</Typography>
                  <Typography variant="code" tone="muted">
                    {part.oemNumber}
                  </Typography>
                </div>
                <Typography variant="bodyXs" tone="muted">
                  {[
                    part.category,
                    part.position ? `позиция ${part.position} на схеме` : null,
                    part.quantity && part.quantity > 1 ? `${part.quantity} шт. на машину` : null,
                    part.note ??
                      (variants.has(part.oemNumber) ? 'каталог не указал, чем отличается' : null),
                    part.appliesPeriod,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Typography>
                {/* Заказ по заменённому номеру у поставщиков не найдётся —
                    предупреждение видно в списке, до выбора детали. */}
                {part.replacedBy ? (
                  <Typography variant="bodyXs" tone="destructive">
                    Заменён на {part.replacedBy} — заказывать новый номер
                  </Typography>
                ) : null}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function OffersPanel({
  part,
  vehicleVin,
  onPickPart,
}: {
  part: Part
  vehicleVin?: string
  /** Мастер выбрал на схеме другую деталь того же узла. */
  onPickPart: (part: Part) => void
}) {
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
        vehicleVin:
          vehicleVin && vinOrFrameSchema.safeParse(vehicleVin).success ? vehicleVin : undefined,
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

  const { picks, offers, source, dealerPrice } = offersQuery.data

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <Typography variant="h4">{part.name}</Typography>
        <Typography variant="code" tone="muted">
          OEM {part.oemNumber}
        </Typography>
        {dealerPrice ? <DealerPriceNote price={dealerPrice} /> : null}
      </div>

      {source?.demo ? <DemoPricesNotice /> : null}

      {part.imageUrl ? (
        <SchemeViewer
          imageUrl={part.imageUrl}
          partName={part.name}
          position={part.position}
          hotspot={part.schemeHotspot}
          node={part.schemeId && vehicleVin ? { vin: vehicleVin, schemeId: part.schemeId } : null}
          onPick={onPickPart}
        />
      ) : null}

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

/**
 * Цена оригинала у дилеров — ориентир, а не предложение: купить по ней нельзя.
 * Рынок и валюта названы прямо, чтобы приёмщик не назвал клиенту юани рублями.
 */
function DealerPriceNote({ price }: { price: DealerPrice }) {
  const yuan = (fen: number) =>
    (fen / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
  const range = price.min === price.max ? yuan(price.min) : `${yuan(price.min)}–${yuan(price.max)}`

  return (
    <Typography variant="bodySm" tone="muted">
      Оригинал у дилеров в Китае: <span className="font-medium text-foreground">{range} ¥</span>{' '}
      — ориентир, не цена покупки
    </Typography>
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

/**
 * Поставщики не подключены — цены сгенерированы. Предупреждение стоит над
 * тирами, а не в подвале: приёмщик не должен называть клиенту выдуманную сумму.
 */
function DemoPricesNotice() {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2"
    >
      <Badge variant="outline" className="border-amber-500/60 text-amber-700">
        Демо-цены
      </Badge>
      <Typography variant="bodySm">
        Поставщики ещё не подключены — цены, сроки и наличие ниже условные. Каталожные номера
        настоящие: их можно отправить своему поставщику.
      </Typography>
    </div>
  )
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    // Сообщения сервера для 404 контекстны (VIN или госномер).
    if (error.status === 404) return error.message
    if (error.status === 400) return 'Проверьте введённые данные (VIN, госномер или запрос).'
    if (error.status === 502) return 'Каталог сейчас недоступен. Попробуйте ещё раз через пару минут.'
    return error.message
  }
  return 'Не удалось выполнить запрос. Попробуйте ещё раз.'
}
