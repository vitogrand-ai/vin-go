import { useQuery } from '@tanstack/react-query'
import type { CatalogTreeNode, Part } from '@web-app-demo/contracts'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { Typography } from '@/components/ui/typography'
import { SchemeViewer } from '@/features/search/SchemeViewer'
import { describeApiError } from '@/lib/errors'
import { publicApi } from '@/lib/public-api'
import { cn } from '@/lib/utils'

type CatalogTreeProps = {
  vin: string
  /** Мастер выбрал деталь на схеме узла — дальше предложения поставщиков. */
  onPick: (part: Part) => void
  /** Заголовок зависит от того, откуда пришли: после пустой выдачи или сами. */
  afterEmptySearch?: boolean
}

/**
 * Поиск детали глазами: дерево узлов каталога → схема → деталь на схеме.
 *
 * Для детали, которую поиск по названию не нашёл: мастер знает, где она стоит
 * и как выглядит, но не знает, как её называет каталог. Узел выбирает он сам —
 * номер детали приходит из каталога при открытии узла, догадок здесь нет.
 */
export function CatalogTree({ vin, onPick, afterEmptySearch }: CatalogTreeProps) {
  // Путь от корня: id выбранных узлов. Последний лист открывает схемы.
  const [path, setPath] = useState<string[]>([])

  const tree = useQuery({
    queryKey: ['catalog-tree', vin],
    queryFn: () => publicApi.catalogTree({ vin }),
    staleTime: 30 * 60_000,
  })
  const nodes = useMemo(() => tree.data?.nodes ?? [], [tree.data])
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])

  const current = path.length > 0 ? byId.get(path[path.length - 1]!) : undefined
  const leaf = current?.leaf ? current : undefined
  const children = useMemo(
    () => (leaf ? [] : nodes.filter((node) => node.parentId === (current?.id ?? null))),
    [nodes, current, leaf],
  )

  const schemes = useQuery({
    queryKey: ['branch-schemes', vin, leaf?.id],
    queryFn: () => publicApi.branchSchemes({ vin, branchId: leaf!.id }),
    enabled: Boolean(leaf),
    staleTime: 30 * 60_000,
  })

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{afterEmptySearch ? 'Найти на схеме каталога' : 'Узлы каталога'}</CardTitle>
        <CardDescription>
          {afterEmptySearch ? 'Каталог мог назвать деталь иначе. ' : ''}
          Выберите узел, где стоит деталь, откройте схему и нажмите деталь на ней — номер придёт из
          каталога.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {tree.isPending ? (
          <div className="flex items-center gap-2" role="status">
            <Spinner />
            <Typography variant="bodySm" tone="muted">
              Загружаем узлы каталога…
            </Typography>
          </div>
        ) : tree.isError ? (
          <Typography variant="bodySm" tone="destructive">
            {describeApiError(tree.error)}
          </Typography>
        ) : nodes.length === 0 ? (
          <Typography variant="bodySm" tone="muted">
            У каталога этой машины нет дерева узлов. Попробуйте другое название запчасти или спросите
            эксперта.
          </Typography>
        ) : (
          <>
            <TreePath path={path} byId={byId} onGo={setPath} />
            {leaf ? (
              <LeafSchemes
                vin={vin}
                loading={schemes.isPending}
                error={schemes.isError ? describeApiError(schemes.error) : null}
                schemes={schemes.data?.schemes ?? []}
                onPick={onPick}
              />
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {children.map((node) => (
                  <Button
                    key={node.id}
                    type="button"
                    variant="outline"
                    className="h-auto justify-start py-2.5 text-left whitespace-normal"
                    onClick={() => setPath([...path, node.id])}
                  >
                    {node.name}
                  </Button>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** Где мы в дереве: каждый шаг пути нажимается и возвращает на свой уровень. */
function TreePath({
  path,
  byId,
  onGo,
}: {
  path: string[]
  byId: Map<string, CatalogTreeNode>
  onGo: (path: string[]) => void
}) {
  if (path.length === 0) return null
  return (
    <nav aria-label="Путь по узлам каталога" className="flex flex-wrap items-center gap-x-1 gap-y-1">
      <PathStep label="Все узлы" onClick={() => onGo([])} />
      {path.map((id, index) => {
        const last = index === path.length - 1
        return (
          <span key={id} className="flex items-center gap-x-1">
            <Typography variant="bodySm" tone="muted" aria-hidden>
              ›
            </Typography>
            {last ? (
              <Typography variant="bodySmMedium" aria-current="location">
                {byId.get(id)?.name ?? '…'}
              </Typography>
            ) : (
              <PathStep label={byId.get(id)?.name ?? '…'} onClick={() => onGo(path.slice(0, index + 1))} />
            )}
          </span>
        )
      })}
    </nav>
  )
}

function PathStep({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded text-muted-foreground underline-offset-4 hover:text-foreground hover:underline',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <Typography variant="bodySm" tone="current">
        {label}
      </Typography>
    </button>
  )
}

/** Схемы листа: миниатюра открывает узел целиком, деталь выбирается на схеме или в списке. */
function LeafSchemes({
  vin,
  loading,
  error,
  schemes,
  onPick,
}: {
  vin: string
  loading: boolean
  error: string | null
  schemes: { schemeId: string; name: string; imageUrl: string | null }[]
  onPick: (part: Part) => void
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2" role="status">
        <Spinner />
        <Typography variant="bodySm" tone="muted">
          Загружаем схемы узла…
        </Typography>
      </div>
    )
  }
  if (error) {
    return (
      <Typography variant="bodySm" tone="destructive">
        {error}
      </Typography>
    )
  }
  const withImage = schemes.filter((scheme) => scheme.imageUrl)
  if (withImage.length === 0) {
    return (
      <Typography variant="bodySm" tone="muted">
        В этом узле у машины нет схем. Вернитесь на шаг назад и выберите соседний узел.
      </Typography>
    )
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {withImage.map((scheme) => (
        <div key={scheme.schemeId} className="grid content-start gap-1.5">
          <Typography variant="bodySmMedium">{scheme.name}</Typography>
          <SchemeViewer
            imageUrl={scheme.imageUrl!}
            partName={scheme.name}
            node={{ vin, schemeId: scheme.schemeId }}
            onPick={onPick}
          />
        </div>
      ))}
    </div>
  )
}
