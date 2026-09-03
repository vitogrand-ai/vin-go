import { Link } from '@tanstack/react-router'
import type { CustomerDto } from '@web-app-demo/contracts'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { Typography } from '@/components/ui/typography'
import { RequireAuth } from '@/features/cabinet/RequireAuth'
import {
  useCreateCustomer,
  useCustomers,
  useRemoveCustomer,
  useUpdateCustomer,
} from '@/features/cabinet/queries'
import { describeApiError } from '@/lib/errors'

export function CustomersPage() {
  return (
    <RequireAuth>
      <Customers />
    </RequireAuth>
  )
}

/**
 * Клиенты автосервиса — владельцы машин. Список общий для сотрудников:
 * приёмщик заводит человека один раз, потом цепляет к нему авто и заказы.
 */
function Customers() {
  const customers = useCustomers()
  const create = useCreateCustomer()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [search, setSearch] = useState('')

  const visible = useMemo(() => {
    const list = customers.data?.customers ?? []
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (customer) =>
        customer.name.toLowerCase().includes(q) || (customer.phone ?? '').toLowerCase().includes(q),
    )
  }, [customers.data?.customers, search])

  const handleCreate = (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    create.mutate(
      { name: name.trim(), phone: phone.trim() || undefined },
      {
        onSuccess: () => {
          setName('')
          setPhone('')
          toast.success('Клиент добавлен')
        },
        onError: (error) => toast.error(describeApiError(error)),
      },
    )
  }

  return (
    <section className="mx-auto grid w-full max-w-6xl gap-8 px-5 py-10">
      <div className="grid gap-3">
        <Badge variant="outline" className="w-fit">
          Клиенты
        </Badge>
        <Typography variant="h1">Клиенты автосервиса</Typography>
        <Typography tone="muted" className="max-w-2xl">
          Владельцы машин, для которых вы подбираете запчасти. Имя и телефон попадают в смету, а
          авто из гаража и заказы копятся в истории клиента.
        </Typography>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleCreate} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto]">
            <div className="grid gap-1.5">
              <Typography variant="label" tone="muted">
                Имя
              </Typography>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Иван Петров"
                maxLength={120}
              />
            </div>
            <div className="grid gap-1.5">
              <Typography variant="label" tone="muted">
                Телефон (необязательно)
              </Typography>
              <Input
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="+7 900 000-00-00"
                inputMode="tel"
                maxLength={32}
              />
            </div>
            <div className="grid gap-1.5">
              <Typography variant="label" tone="muted" className="sm:opacity-0">
                &nbsp;
              </Typography>
              <Button type="submit" disabled={create.isPending || !name.trim()}>
                {create.isPending ? <Spinner /> : null}
                Добавить
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {customers.isPending ? (
        <div className="flex items-center gap-3">
          <Spinner />
          <Typography tone="muted">Загружаем клиентов…</Typography>
        </div>
      ) : (customers.data?.customers.length ?? 0) === 0 ? (
        <Typography tone="muted">Клиентов пока нет. Добавьте первого — имени достаточно.</Typography>
      ) : (
        <div className="grid gap-4">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Поиск по имени или телефону"
            className="max-w-xs"
          />
          {visible.length === 0 ? (
            <Typography tone="muted">Никого не нашлось.</Typography>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {visible.map((customer) => (
                <CustomerCard key={customer.id} customer={customer} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function CustomerCard({ customer }: { customer: CustomerDto }) {
  const update = useUpdateCustomer()
  const remove = useRemoveCustomer()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(customer.name)
  const [phone, setPhone] = useState(customer.phone ?? '')
  const [note, setNote] = useState(customer.note ?? '')

  const handleSave = (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    update.mutate(
      {
        id: customer.id,
        name: name.trim(),
        phone: phone.trim() === '' ? null : phone.trim(),
        note: note.trim() === '' ? null : note.trim(),
      },
      {
        onSuccess: () => {
          setEditing(false)
          toast.success('Карточка клиента сохранена')
        },
        onError: (error) => toast.error(describeApiError(error)),
      },
    )
  }

  const handleRemove = () => {
    if (!window.confirm(`Удалить клиента «${customer.name}»? Авто и заказы останутся.`)) return
    remove.mutate(customer.id, {
      onError: (error) => toast.error(describeApiError(error)),
    })
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{customer.name}</CardTitle>
        <CardDescription>
          {customer.phone ?? 'Телефон не указан'} · авто: {customer.vehicleCount} · заказов:{' '}
          {customer.orderCount}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {editing ? (
          <form onSubmit={handleSave} className="grid gap-3">
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
            <Input
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="Телефон"
              inputMode="tel"
              maxLength={32}
            />
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Заметка: как обращаться, особенности, договорённости"
              maxLength={500}
              rows={2}
            />
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={update.isPending || !name.trim()}>
                {update.isPending ? <Spinner /> : null}
                Сохранить
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Отмена
              </Button>
            </div>
          </form>
        ) : (
          <>
            {customer.note ? (
              <Typography variant="bodySm" tone="muted">
                {customer.note}
              </Typography>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild size="sm" variant="outline">
                <Link to="/garage">Гараж</Link>
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
                Изменить
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={remove.isPending}
                onClick={handleRemove}
              >
                Удалить
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
