import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Typography } from '@/components/ui/typography'
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
}

/**
 * Обводка выноски детали на схеме.
 *
 * Каталог даёт левый верхний угол подписи выноски, а сама подпись («15643A»)
 * уходит от него вправо и вниз. Рамка начинается чуть левее и выше угла и
 * накрывает подпись с запасом. Размер — в долях картинки, как и координата:
 * схемы каталога одного масштаба (~760 px в ширину), подпись там ~60–80 px.
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
      style={{
        left: `${Math.max(hotspot.x * 100 - 1.2, 0)}%`,
        top: `${Math.max(hotspot.y * 100 - 1, 0)}%`,
        width: '12%',
        height: '4%',
      }}
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
 */
export function SchemeViewer({ imageUrl, partName, position, hotspot }: SchemeViewerProps) {
  const [open, setOpen] = useState(false)
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
        <DialogContent className="max-w-[min(96vw,1100px)] gap-4 sm:max-w-[min(96vw,1100px)]">
          <DialogHeader>
            <DialogTitle>Схема узла</DialogTitle>
            <DialogDescription>
              {partName}
              {hotspot && position ? ` — обведена позиция ${position}` : ''}
            </DialogDescription>
          </DialogHeader>

          <div
            className={cn(
              'rounded-lg border bg-white',
              // В натуральную величину схема шире окна — прокручиваем её, а не сжимаем.
              actualSize ? 'max-h-[72vh] overflow-auto' : 'max-h-[72vh] overflow-hidden',
            )}
          >
            <button
              type="button"
              onClick={() => setActualSize((value) => !value)}
              aria-label={actualSize ? 'Вписать схему в окно' : 'Показать схему в натуральную величину'}
              className={cn(
                'block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                actualSize ? 'cursor-zoom-out' : 'w-full cursor-zoom-in',
              )}
            >
              <span className={actualSize ? 'relative inline-block' : 'flex justify-center'}>
                <span className="relative inline-block">
                  <img
                    src={src}
                    alt={alt}
                    className={actualSize ? 'block max-w-none' : 'block max-h-[72vh] max-w-full'}
                  />
                  {hotspot ? <SchemeMarker hotspot={hotspot} /> : null}
                </span>
              </span>
            </button>
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
