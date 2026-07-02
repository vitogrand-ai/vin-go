import { Link } from '@tanstack/react-router'
import { useState } from 'react'
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
import { Spinner } from '@/components/ui/spinner'
import { Typography } from '@/components/ui/typography'
import { RequireAuth } from '@/features/cabinet/RequireAuth'
import { useAddVehicle, useGarage, useRemoveVehicle } from '@/features/cabinet/queries'
import { describeApiError } from '@/lib/errors'

export function GaragePage() {
  return (
    <RequireAuth>
      <Garage />
    </RequireAuth>
  )
}

function Garage() {
  const [vin, setVin] = useState('')
  const [nickname, setNickname] = useState('')
  const garage = useGarage()
  const addVehicle = useAddVehicle()
  const removeVehicle = useRemoveVehicle()

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!vin.trim()) return
    addVehicle.mutate(
      { vin, nickname: nickname.trim() || undefined },
      {
        onSuccess: () => {
          setVin('')
          setNickname('')
          toast.success('Автомобиль добавлен в гараж')
        },
        onError: (error) => toast.error(describeApiError(error)),
      },
    )
  }

  const vehicles = garage.data?.vehicles ?? []

  return (
    <section className="mx-auto grid w-full max-w-6xl gap-8 px-5 py-10">
      <div className="grid gap-3">
        <Badge variant="outline" className="w-fit">
          Гараж
        </Badge>
        <Typography variant="h1">Мои автомобили</Typography>
        <Typography tone="muted" className="max-w-2xl">
          Сохраните автомобили, чтобы быстро подбирать запчасти без повторного ввода VIN.
        </Typography>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto]">
            <div className="grid gap-1.5">
              <Typography variant="label" tone="muted">
                VIN
              </Typography>
              <Input
                value={vin}
                onChange={(event) => setVin(event.target.value.toUpperCase())}
                placeholder="WVWZZZ1JZ3W386752"
                maxLength={17}
                spellCheck={false}
                className="font-mono"
              />
            </div>
            <div className="grid gap-1.5">
              <Typography variant="label" tone="muted">
                Название (необязательно)
              </Typography>
              <Input
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                placeholder="Моя Гольф"
                maxLength={60}
              />
            </div>
            <div className="grid gap-1.5">
              <Typography variant="label" tone="muted" className="sm:opacity-0">
                &nbsp;
              </Typography>
              <Button type="submit" disabled={addVehicle.isPending || !vin.trim()}>
                {addVehicle.isPending ? <Spinner /> : null}
                Добавить
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {garage.isPending ? (
        <div className="flex items-center gap-3">
          <Spinner />
          <Typography tone="muted">Загружаем гараж…</Typography>
        </div>
      ) : vehicles.length === 0 ? (
        <Typography tone="muted">Гараж пуст. Добавьте первый автомобиль по VIN.</Typography>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {vehicles.map((vehicle) => (
            <Card key={vehicle.id} size="sm">
              <CardHeader>
                <CardTitle>{vehicle.nickname ?? `${vehicle.make} ${vehicle.model}`}</CardTitle>
                <CardDescription className="font-mono">{vehicle.vin}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3">
                <div className="grid gap-0.5">
                  <Typography variant="bodySmMedium">
                    {vehicle.make} {vehicle.model}, {vehicle.year}
                  </Typography>
                  <Typography variant="bodyXs" tone="muted">
                    {vehicle.engine ?? 'Двигатель не определён'}
                  </Typography>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button asChild size="sm">
                    <Link to="/search" search={{ vin: vehicle.vin }}>
                      Подобрать запчасти
                    </Link>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={removeVehicle.isPending}
                    onClick={() =>
                      removeVehicle.mutate(vehicle.id, {
                        onError: (error) => toast.error(describeApiError(error)),
                      })
                    }
                  >
                    Удалить
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  )
}
