import { useQuery } from '@tanstack/react-query'

import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { Typography } from '@/components/ui/typography'
import { formatDelivery, formatMoney, TIER_META } from '@/lib/format'
import { publicApi } from '@/lib/public-api'

/** Компактный список аналогов (3 тира) по OEM-номеру. Публичные данные. */
export function AnalogsPanel({ oemNumber }: { oemNumber: string }) {
  const offers = useQuery({
    queryKey: ['offers', oemNumber],
    queryFn: () => publicApi.offers({ oemNumber }),
  })

  if (offers.isPending) {
    return (
      <div className="flex items-center gap-2 py-2">
        <Spinner />
        <Typography variant="bodyXs" tone="muted">
          Загружаем аналоги…
        </Typography>
      </div>
    )
  }

  if (offers.isError) {
    return (
      <Typography variant="bodyXs" tone="destructive">
        Не удалось загрузить аналоги.
      </Typography>
    )
  }

  return (
    <div className="grid gap-2 rounded-lg border bg-muted/30 p-3">
      {offers.data.picks.map((pick) => (
        <div key={pick.tier} className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Badge variant={pick.tier === 'BALANCED' ? 'default' : 'secondary'}>
              {TIER_META[pick.tier].label}
            </Badge>
            <Typography variant="bodyXs" tone="muted" className="truncate">
              {pick.offer.brand} · {formatDelivery(pick.offer.deliveryDays)}
            </Typography>
          </div>
          <Typography variant="bodySmMedium" className="shrink-0">
            {formatMoney(pick.offer.price)}
          </Typography>
        </div>
      ))}
      <Typography variant="bodyXs" tone="muted">
        Всего предложений: {offers.data.offers.length}
      </Typography>
    </div>
  )
}
