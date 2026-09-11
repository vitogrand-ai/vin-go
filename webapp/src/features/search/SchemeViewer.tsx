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
import { cn } from '@/lib/utils'

type SchemeViewerProps = {
  /** Адрес схемы узла — уже оригинал, каталог отдаёт около 800×1100. */
  imageUrl: string
  /** Название детали: идёт в alt и в заголовок окна просмотра. */
  partName: string
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
export function SchemeViewer({ imageUrl, partName }: SchemeViewerProps) {
  const [open, setOpen] = useState(false)
  // Внутри окна: false — схема вписана в экран, true — натуральный размер.
  const [actualSize, setActualSize] = useState(false)

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
        <img
          src={imageUrl}
          alt={`Схема узла: ${partName}`}
          loading="lazy"
          className={cn(
            'max-h-72 w-full object-contain',
            'transition-transform duration-200 ease-out group-hover:scale-[1.02]',
          )}
        />
        <span
          className={cn(
            'pointer-events-none absolute right-2 bottom-2 rounded-md bg-foreground/75 px-2 py-1',
            'text-xs text-background opacity-0 transition-opacity duration-200 ease-out',
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
            <DialogDescription>{partName}</DialogDescription>
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
              <img
                src={imageUrl}
                alt={`Схема узла: ${partName}`}
                className={actualSize ? 'max-w-none' : 'mx-auto max-h-[72vh] w-full object-contain'}
              />
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
                <a href={imageUrl} target="_blank" rel="noreferrer">
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
