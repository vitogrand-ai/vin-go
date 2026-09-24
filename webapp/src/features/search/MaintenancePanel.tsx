import { useQueries } from '@tanstack/react-query'
import { MAINTENANCE_ITEMS, type Part } from '@web-app-demo/contracts'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { Typography } from '@/components/ui/typography'
import { publicApi } from '@/lib/public-api'
import { cn } from '@/lib/utils'

type MaintenancePanelProps = {
  vin: string
  /** Деталь выбрана — дальше предложения поставщиков. */
  onPick: (part: Part) => void
  /** Показать все исполнения пункта — обычный поиск его названием. */
  onShowAll: (query: string) => void
}

/**
 * Детали ТО одной кнопкой: масляный, воздушный, салонный, топливный фильтры и
 * свечи (`MAINTENANCE_ITEMS`). Каждый пункт — обычный поиск, запросы идут
 * параллельно, и строка появляется, как только её пункт найден: все пять
 * вместе на медленной машине каталога — до полуминуты.
 */
export function MaintenancePanel({ vin, onPick, onShowAll }: MaintenancePanelProps) {
  const results = useQueries({
    queries: MAINTENANCE_ITEMS.map((item) => ({
      queryKey: ['maintenance', vin, item.query],
      queryFn: () => publicApi.searchParts({ vin, query: item.query }),
      staleTime: 30 * 60_000,
    })),
  })

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Детали ТО</CardTitle>
        <CardDescription>
          Нажмите деталь — покажем цены. Несколько исполнений — сверьте с тем, что стоит на машине.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {MAINTENANCE_ITEMS.map((item, index) => {
          const result = results[index]!
          const parts = result.data?.parts ?? []
          const first = parts[0]
          return (
            <div
              key={item.query}
              className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[10rem_1fr_auto] sm:items-center"
            >
              <Typography variant="bodySmMedium">{item.label}</Typography>
              {result.isPending ? (
                <div className="flex items-center gap-2" role="status">
                  <Spinner />
                  <Typography variant="bodySm" tone="muted">
                    Ищем в каталоге…
                  </Typography>
                </div>
              ) : result.isError ? (
                <Typography variant="bodySm" tone="destructive">
                  Каталог не ответил — попробуйте позже
                </Typography>
              ) : first ? (
                <button
                  type="button"
                  onClick={() => onPick(first)}
                  className={cn(
                    'grid min-w-0 gap-0.5 rounded-md px-2 py-1 text-left transition-colors',
                    'hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  )}
                >
                  <Typography variant="bodySm">{first.name}</Typography>
                  <Typography variant="code" tone="muted">
                    {first.oemNumber}
                  </Typography>
                </button>
              ) : (
                <Typography variant="bodySm" tone="muted">
                  В каталоге этой машины не найден
                </Typography>
              )}
              {parts.length > 1 ? (
                <Button type="button" variant="outline" size="sm" onClick={() => onShowAll(item.query)}>
                  Все варианты ({parts.length})
                </Button>
              ) : null}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
