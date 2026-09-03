import { Link } from '@tanstack/react-router'
import type { CustomerDto, SavedVehicle } from '@web-app-demo/contracts'
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
import {
  useAddVehicle,
  useCustomers,
  useGarage,
  useRemoveVehicle,
  useUpdateVehicle,
} from '@/features/cabinet/queries'
import { describeApiError } from '@/lib/errors'

export function GaragePage() {
  return (
    <RequireAuth>
      <Garage />
    </RequireAuth>
  )
}

/** Число из поля «пробег, км» → int; пусто или мусор → undefined. */
function parseMileage(value: string): number | undefined {
  const digits = value.replace(/\D/g, '')
  if (digits === '') return undefined
  const km = Number(digits)
  return Number.isFinite(km) ? km : undefined
}

function Garage() {
  const [vin, setVin] = useState('')
  const [nickname, setNickname] = useState('')
  const [plate, setPlate] = useState('')
  const [mileage, setMileage] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [search, setSearch] = useState('')
  const garage = useGarage()
  const customers = useCustomers()
  const addVehicle = useAddVehicle()

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!vin.trim()) return
    addVehicle.mutate(
      {
        vin,
        nickname: nickname.trim() || undefined,
        plate: plate.trim() || undefined,
        mileageKm: parseMileage(mileage),
        customerId: customerId || undefined,
      },
      {
        onSuccess: () => {
          setVin('')
          setNickname('')
          setPlate('')
          setMileage('')
          setCustomerId('')
          toast.success('Автомобиль добавлен в гараж')
        },
        onError: (error) => toast.error(describeApiError(error)),
      },
    )
  }

  const vehicles = garage.data?.vehicles ?? []
  const customerList = customers.data?.customers ?? []
  const q = search.trim().toLowerCase()
  const visible = q
    ? vehicles.filter((vehicle) =>
        [vehicle.vin, vehicle.plate, vehicle.nickname, vehicle.make, vehicle.model, vehicle.customer?.name]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(q)),
      )
    : vehicles

  return (
    <section className="mx-auto grid w-full max-w-6xl gap-8 px-5 py-10">
      <div className="grid gap-3">
        <Badge variant="outline" className="w-fit">
          Гараж
        </Badge>
        <Typography variant="h1">Гараж автосервиса</Typography>
        <Typography tone="muted" className="max-w-2xl">
          Машины ваших клиентов, общие для всех сотрудников. Госномер и пробег — чтобы находить
          авто без VIN и знать, что пора менять.
        </Typography>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-3">
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
                  Госномер
                </Typography>
                <Input
                  value={plate}
                  onChange={(event) => setPlate(event.target.value.toUpperCase())}
                  placeholder="А123ВС777"
                  maxLength={9}
                  spellCheck={false}
                  className="font-mono"
                />
              </div>
              <div className="grid gap-1.5">
                <Typography variant="label" tone="muted">
                  Пробег, км
                </Typography>
                <Input
                  value={mileage}
                  onChange={(event) => setMileage(event.target.value)}
                  placeholder="145000"
                  inputMode="numeric"
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto]">
              <div className="grid gap-1.5">
                <Typography variant="label" tone="muted">
                  Клиент
                </Typography>
                <CustomerSelect
                  customers={customerList}
                  value={customerId}
                  onChange={setCustomerId}
                />
              </div>
              <div className="grid gap-1.5">
                <Typography variant="label" tone="muted">
                  Название (необязательно)
                </Typography>
                <Input
                  value={nickname}
                  onChange={(event) => setNickname(event.target.value)}
                  placeholder="Гольф Петрова"
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
        <div className="grid gap-4">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Поиск: госномер, VIN, клиент, модель"
            className="max-w-xs"
          />
          {visible.length === 0 ? (
            <Typography tone="muted">Под поиск ничего не подходит.</Typography>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {visible.map((vehicle) => (
                <VehicleCard key={vehicle.id} vehicle={vehicle} customers={customerList} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function CustomerSelect({
  customers,
  value,
  onChange,
}: {
  customers: CustomerDto[]
  value: string
  onChange: (id: string) => void
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-9 rounded-md border bg-input/30 px-3 text-sm"
    >
      <option value="">Без клиента</option>
      {customers.map((customer) => (
        <option key={customer.id} value={customer.id}>
          {customer.name}
          {customer.phone ? ` · ${customer.phone}` : ''}
        </option>
      ))}
    </select>
  )
}

function VehicleCard({ vehicle, customers }: { vehicle: SavedVehicle; customers: CustomerDto[] }) {
  const removeVehicle = useRemoveVehicle()
  const updateVehicle = useUpdateVehicle()
  const [editing, setEditing] = useState(false)
  const [nickname, setNickname] = useState(vehicle.nickname ?? '')
  const [plate, setPlate] = useState(vehicle.plate ?? '')
  const [mileage, setMileage] = useState(vehicle.mileageKm?.toString() ?? '')
  const [customerId, setCustomerId] = useState(vehicle.customer?.id ?? '')

  const handleSave = (event: React.FormEvent) => {
    event.preventDefault()
    updateVehicle.mutate(
      {
        id: vehicle.id,
        nickname: nickname.trim() === '' ? null : nickname.trim(),
        plate: plate.trim() === '' ? null : plate.trim(),
        mileageKm: mileage.trim() === '' ? null : (parseMileage(mileage) ?? null),
        customerId: customerId === '' ? null : customerId,
      },
      {
        onSuccess: () => {
          setEditing(false)
          toast.success('Карточка авто сохранена')
        },
        onError: (error) => toast.error(describeApiError(error)),
      },
    )
  }

  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{vehicle.nickname ?? `${vehicle.make} ${vehicle.model}`}</CardTitle>
          {vehicle.plate ? <Badge variant="outline">{vehicle.plate}</Badge> : null}
        </div>
        <CardDescription className="font-mono">{vehicle.vin}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-0.5">
          <Typography variant="bodySmMedium">
            {vehicle.make} {vehicle.model}
            {vehicle.year ? `, ${vehicle.year}` : ''}
          </Typography>
          <Typography variant="bodyXs" tone="muted">
            {vehicle.engine ?? 'Двигатель не определён'}
            {vehicle.mileageKm !== null
              ? ` · пробег ${vehicle.mileageKm.toLocaleString('ru-RU')} км`
              : ''}
          </Typography>
          <Typography variant="bodyXs" tone="muted">
            {vehicle.customer
              ? `Клиент: ${vehicle.customer.name}${vehicle.customer.phone ? `, ${vehicle.customer.phone}` : ''}`
              : 'Клиент не указан'}
          </Typography>
        </div>

        {editing ? (
          <form onSubmit={handleSave} className="grid gap-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                value={plate}
                onChange={(event) => setPlate(event.target.value.toUpperCase())}
                placeholder="Госномер"
                maxLength={9}
                className="font-mono"
              />
              <Input
                value={mileage}
                onChange={(event) => setMileage(event.target.value)}
                placeholder="Пробег, км"
                inputMode="numeric"
              />
            </div>
            <CustomerSelect customers={customers} value={customerId} onChange={setCustomerId} />
            <Input
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              placeholder="Название"
              maxLength={60}
            />
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={updateVehicle.isPending}>
                {updateVehicle.isPending ? <Spinner /> : null}
                Сохранить
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Отмена
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm">
              <Link to="/search" search={{ vin: vehicle.vin }}>
                Подобрать запчасти
              </Link>
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
              Изменить
            </Button>
            <Button
              type="button"
              variant="ghost"
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
        )}
      </CardContent>
    </Card>
  )
}
