import { useQuery } from '@tanstack/react-query'
import type { Part } from '@web-app-demo/contracts'
import { useMemo, useState, type CSSProperties } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { Typography } from '@/components/ui/typography'
import { publicApi } from '@/lib/public-api'
import { schemeImageSrc } from '@/lib/scheme-image'
import { cn } from '@/lib/utils'

type SchemeHotspot = { x: number; y: number }

type SchemeViewerProps = {
  /** Адрес схемы узла — уже оригинал, каталог отдаёт около 800×1100. */
  imageUrl: string
  /** Название детали: идёт в alt и в заголовок окна просмотра. */
  partName: string
  /** Номер выноски детали на схеме — для подписи обводки. */
  position?: string | null
  /** Где выноска стоит на схеме, в долях картинки: по ней деталь обводится. */
  hotspot?: SchemeHotspot | null
  /** Машина и узел каталога: по ним открывается весь узел. Без них схема — только картинка. */
  node?: { vin: string; schemeId: string } | null
  /** Мастер выбрал другую деталь узла — нажатием на выноску или строкой списка. */
  onPick?: (part: Part) => void
}

/** Одна выноска узла: номер на картинке и детали под ним (исполнений бывает несколько). */
type Callout = { position: string; hotspot: SchemeHotspot | null; parts: Part[] }

/** Детали узла → выноски по порядку номеров («2» раньше «10»). Детали без номера со схемы не выбрать. */
function groupByPosition(parts: Part[]): Callout[] {
  const byPosition = new Map<string, Callout>()
  for (const part of parts) {
    const position = part.position?.trim()
    if (!position) continue
    const callout = byPosition.get(position) ?? { position, hotspot: null, parts: [] }
    callout.hotspot ??= part.schemeHotspot ?? null
    callout.parts.push(part)
    byPosition.set(position, callout)
  }
  return [...byPosition.values()].sort((a, b) =>
    a.position.localeCompare(b.position, 'ru', { numeric: true }),
  )
}

/**
 * Рамка вокруг подписи выноски. Каталог даёт левый верхний угол подписи, а сама
 * подпись («15643A») уходит от него вправо и вниз: рамка начинается чуть левее
 * и выше угла и накрывает подпись с запасом. Размер — в долях картинки, как и
 * координата: схемы каталога одного масштаба (~760 px в ширину), подпись ~60–80 px.
 */
function calloutFrame(hotspot: SchemeHotspot): CSSProperties {
  return {
    left: `${Math.max(hotspot.x * 100 - 1.2, 0)}%`,
    top: `${Math.max(hotspot.y * 100 - 1, 0)}%`,
    width: '12%',
    height: '4%',
  }
}

/**
 * Обводка выноски детали на схеме (геометрия — `calloutFrame`).
 *
 * Лежит поверх картинки внутри обёртки ровно её размера, поэтому проценты
 * совпадают с картинкой и при вписывании в окно, и в натуральную величину.
 */
function SchemeMarker({ hotspot }: { hotspot: SchemeHotspot }) {
  return (
    <span
      aria-hidden
      className={cn(
        // Акцент продукта — тёплый янтарь, как у пометок в выдаче. Чёрная рамка
        // сливается с линиями чертежа, а янтарная — единственное цветное пятно.
        'pointer-events-none absolute rounded-full border-[3px] border-amber-500 bg-amber-400/20',
        // Белое кольцо снаружи отделяет рамку от соседних линий схемы.
        'shadow-[0_0_0_2px_rgb(255_255_255/0.9),0_2px_10px_rgb(180_83_9/0.35)]',
      )}
      style={calloutFrame(hotspot)}
    />
  )
}

/**
 * Выноска, на которую можно нажать: выбор детали номером с картинки — то же,
 * что в боте делается цифрой в чате. Тонкая рамка видна всегда: на телефоне
 * наведения нет, и без неё не догадаться, что номера на схеме нажимаются.
 */
function CalloutButton({ callout, onClick }: { callout: Callout; onClick: () => void }) {
  if (!callout.hotspot) return null
  const names = [...new Set(callout.parts.map((part) => part.name))].join(', ')
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${callout.position} — ${names}`}
      aria-label={`Позиция ${callout.position}: ${names}`}
      className={cn(
        'absolute rounded-full border border-amber-500/50 transition-colors duration-150 ease-out',
        'hover:border-amber-500 hover:bg-amber-400/25 active:bg-amber-400/40',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
      style={calloutFrame(callout.hotspot)}
    />
  )
}

/**
 * Схема узла с увеличением.
 *
 * На схеме подписаны номера позиций — мастер по ним сверяет, ту ли деталь берёт,
 * а во врезке страницы они нечитаемы. Поэтому врезка кликабельна и открывает
 * окно просмотра, где схема показывается целиком, а вторым нажатием —
 * в натуральную величину с прокруткой. Ссылка «Открыть файл» оставляет выход на
 * исходный PNG: дальше масштабом управляет сам браузер, без пережатия.
 *
 * Если известен узел каталога (`node`), окно открывает его целиком: выноски на
 * схеме нажимаются, рядом — список деталей узла. Так мастер берёт соседнюю
 * деталь («жгут под цифрой 9»), названия которой он словами и не спросил бы.
 */
export function SchemeViewer({
  imageUrl,
  partName,
  position,
  hotspot,
  node,
  onPick,
}: SchemeViewerProps) {
  const [open, setOpen] = useState(false)
  // Выноска с несколькими исполнениями: список сужается до неё, выбор — строкой.
  const [activePosition, setActivePosition] = useState<string | null>(null)
  const showNode = Boolean(node && onPick)
  // Узел грузится, только когда окно открыто: врезка на странице запросов не стоит.
  const nodeQuery = useQuery({
    queryKey: ['scheme-node', node?.vin, node?.schemeId],
    queryFn: () => publicApi.schemeParts({ vin: node!.vin, schemeId: node!.schemeId }),
    enabled: open && showNode,
    staleTime: 10 * 60_000,
  })
  const callouts = useMemo(() => groupByPosition(nodeQuery.data?.parts ?? []), [nodeQuery.data])
  const listed = activePosition
    ? callouts.filter((callout) => callout.position === activePosition)
    : callouts

  const pick = (part: Part) => {
    setOpen(false)
    onPick?.(part)
  }
  const pressCallout = (callout: Callout) => {
    // Одна деталь под номером — номер и есть выбор; несколько исполнений —
    // показываем их с примечаниями, выбирает мастер.
    if (callout.parts.length === 1) pick(callout.parts[0]!)
    else setActivePosition(callout.position)
  }

  // Внутри окна: false — схема вписана в экран, true — натуральный размер.
  const [actualSize, setActualSize] = useState(false)
  // HTTP-схемы (17vin) идут через прокси бэкенда — иначе HTTPS-страница их не покажет.
  const src = schemeImageSrc(imageUrl)
  const alt = hotspot && position
    ? `Схема узла: ${partName}, деталь обведена — позиция ${position}`
    : `Схема узла: ${partName}`

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setActualSize(false)
          setActivePosition(null)
          setOpen(true)
        }}
        aria-label={`Увеличить схему узла: ${partName}`}
        className={cn(
          'group relative block w-full overflow-hidden rounded-lg border bg-white',
          'transition-[box-shadow,border-color] duration-200 ease-out',
          'hover:border-primary/50 hover:shadow-md',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <span
          className={cn(
            'flex justify-center p-2',
            'transition-transform duration-200 ease-out group-hover:scale-[1.02]',
          )}
        >
          {/* Обёртка ровно размера картинки — иначе обводка съедет на поля. */}
          <span className="relative inline-block">
            <img src={src} alt={alt} loading="lazy" className="block max-h-96 max-w-full" />
            {hotspot ? <SchemeMarker hotspot={hotspot} /> : null}
          </span>
        </span>
        {/* Подсказка видна всегда: на телефоне наведения нет, а без неё не
            догадаться, что схему можно открыть крупнее. */}
        <span
          className={cn(
            'pointer-events-none absolute right-2 bottom-2 rounded-md bg-foreground/70 px-2 py-1',
            'text-xs text-background opacity-80 transition-opacity duration-200 ease-out',
            'group-hover:opacity-100 group-focus-visible:opacity-100',
          )}
        >
          Нажмите, чтобы увеличить
        </span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[94vh] max-w-[min(96vw,1100px)] gap-4 overflow-y-auto sm:max-w-[min(96vw,1100px)]">
          <DialogHeader>
            <DialogTitle>Схема узла</DialogTitle>
            <DialogDescription>
              {partName}
              {hotspot && position ? ` — обведена позиция ${position}` : ''}
            </DialogDescription>
          </DialogHeader>

          <div className={cn('grid gap-4', showNode && 'lg:grid-cols-[minmax(0,1fr)_20rem]')}>
            <div
              className={cn(
                'rounded-lg border bg-white',
                // В натуральную величину схема шире окна — прокручиваем её, а не сжимаем.
                actualSize ? 'overflow-auto' : 'overflow-hidden',
                showNode ? 'max-h-[42vh] lg:max-h-[72vh]' : 'max-h-[72vh]',
              )}
            >
              <div className={actualSize ? 'inline-block' : 'flex justify-center'}>
                {/* Обёртка ровно размера картинки: кнопка масштаба и выноски — соседи,
                    а не вложенные друг в друга кнопки. */}
                <div className="relative inline-block">
                  <button
                    type="button"
                    onClick={() => setActualSize((value) => !value)}
                    aria-label={
                      actualSize ? 'Вписать схему в окно' : 'Показать схему в натуральную величину'
                    }
                    className={cn(
                      'block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      actualSize ? 'cursor-zoom-out' : 'cursor-zoom-in',
                    )}
                  >
                    <img
                      src={src}
                      alt={alt}
                      className={cn(
                        'block',
                        actualSize
                          ? 'max-w-none'
                          : showNode
                            ? 'max-h-[42vh] max-w-full lg:max-h-[72vh]'
                            : 'max-h-[72vh] max-w-full',
                      )}
                    />
                  </button>
                  {hotspot ? <SchemeMarker hotspot={hotspot} /> : null}
                  {callouts.map((callout) => (
                    <CalloutButton
                      key={callout.position}
                      callout={callout}
                      onClick={() => pressCallout(callout)}
                    />
                  ))}
                </div>
              </div>
            </div>

            {showNode ? (
              <NodeParts
                isPending={nodeQuery.isPending}
                isError={nodeQuery.isError}
                callouts={listed}
                activePosition={activePosition}
                currentPosition={position ?? null}
                onShowAll={() => setActivePosition(null)}
                onPick={pick}
              />
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Typography variant="bodySm" tone="muted">
              {actualSize
                ? 'Натуральная величина — схему можно прокручивать'
                : 'Нажмите на схему, чтобы рассмотреть номера позиций'}
            </Typography>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <a href={src} target="_blank" rel="noreferrer">
                  Открыть файл
                </a>
              </Button>
              <DialogClose asChild>
                <Button size="sm">Закрыть</Button>
              </DialogClose>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * Список деталей узла рядом со схемой. Нужен и там, где каталог не отдал
 * координат выносок (на схеме тогда нажимать не во что), и для исполнений одной
 * позиции: под одним номером пять АКБ, различие — в примечании.
 */
function NodeParts({
  isPending,
  isError,
  callouts,
  activePosition,
  currentPosition,
  onShowAll,
  onPick,
}: {
  isPending: boolean
  isError: boolean
  callouts: Callout[]
  activePosition: string | null
  currentPosition: string | null
  onShowAll: () => void
  onPick: (part: Part) => void
}) {
  if (isPending) {
    return (
      <div className="flex items-center gap-3">
        <Spinner />
        <Typography variant="bodySm" tone="muted">
          Открываем узел целиком…
        </Typography>
      </div>
    )
  }
  if (isError) {
    return (
      <Typography variant="bodySm" tone="destructive">
        Состав узла не загрузился — каталог не ответил. Закройте окно и откройте схему ещё раз;
        найденная деталь и цены остаются на странице.
      </Typography>
    )
  }
  if (callouts.length === 0) {
    return (
      <Typography variant="bodySm" tone="muted">
        Каталог не отдал состав этого узла. Другую деталь можно найти по названию.
      </Typography>
    )
  }

  return (
    <div className="grid content-start gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Typography variant="bodySmMedium">
          {activePosition ? `Позиция ${activePosition}: исполнения` : 'Детали узла'}
        </Typography>
        {activePosition ? (
          <Button variant="link" size="sm" className="h-auto p-0" onClick={onShowAll}>
            Весь узел
          </Button>
        ) : null}
      </div>
      <Typography variant="bodyXs" tone="muted">
        {activePosition
          ? 'Сверьте примечание с тем, что стоит на машине.'
          : 'Нажмите номер на схеме или строку в списке — покажем цены на эту деталь.'}
      </Typography>
      <ul className="grid max-h-56 gap-1 overflow-auto lg:max-h-[60vh]">
        {callouts.flatMap((callout) =>
          callout.parts.map((part) => (
            <li key={`${callout.position}|${part.oemNumber}`}>
              <button
                type="button"
                onClick={() => onPick(part)}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md border bg-card p-2 text-left transition-colors',
                  'hover:border-primary/50 active:bg-secondary',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  callout.position === currentPosition && 'border-amber-500/60',
                )}
              >
                <Typography
                  variant="code"
                  className="min-w-8 shrink-0 rounded bg-secondary px-1 text-center"
                >
                  {callout.position}
                </Typography>
                <span className="grid min-w-0 gap-0.5">
                  <Typography variant="bodySm">{part.name}</Typography>
                  <Typography variant="bodyXs" tone="muted">
                    {[part.oemNumber, part.note, part.appliesPeriod].filter(Boolean).join(' · ')}
                  </Typography>
                </span>
              </button>
            </li>
          )),
        )}
      </ul>
    </div>
  )
}
