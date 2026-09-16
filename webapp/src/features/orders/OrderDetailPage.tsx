import { Link, useNavigate, useParams } from '@tanstack/react-router'
import {
  allowedOrderTransitionsFor,
  marginPercent,
  type OrderDto,
  type OrderItemDto,
  type OrderStatus,
  type OrganizationDto,
  type PaymentMethod,
} from '@web-app-demo/contracts'
import { useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { Typography } from '@/components/ui/typography'
import { AnalogsPanel } from '@/features/catalog/AnalogsPanel'
import { RequireAuth } from '@/features/cabinet/RequireAuth'
import {
  useAddOrderWork,
  useCreatePayment,
  useOrder,
  useOrganization,
  useRefundOrder,
  useRemoveOrderWork,
  useReorder,
  useUpdateOrderNotes,
  useUpdateOrderReception,
  useUpdateOrderStatus,
} from '@/features/cabinet/queries'
import { useAuth } from '@/lib/use-auth'
import { describeApiError } from '@/lib/errors'
import { formatMoney, parseRubInput } from '@/lib/format'
import { STATUS_LABEL, TRANSITION_LABEL } from './status'

/** Пока заказ не выдан и не отменён, заказ-наряд правится (совпадает с бэкендом). */
const EDITABLE_STATUSES = new Set<OrderStatus>(['DRAFT', 'PLACED', 'PAID', 'PROCESSING', 'READY'])

/** Что уходит на печать: смета для клиента или заказ-наряд по ПП РФ № 780. */
type PrintMode = 'estimate' | 'workorder'

export function OrderDetailPage() {
  return (
    <RequireAuth>
      <OrderDetail />
    </RequireAuth>
  )
}

function OrderDetail() {
  const params = useParams({ strict: false }) as { id?: string }
  const id = params.id ?? ''
  const order = useOrder(id)

  if (order.isPending) {
    return (
      <Shell>
        <div className="flex items-center gap-3">
          <Spinner />
          <Typography tone="muted">Загружаем заказ…</Typography>
        </div>
      </Shell>
    )
  }

  if (order.isError) {
    return (
      <Shell>
        <Typography tone="destructive">{describeApiError(order.error)}</Typography>
        <Button asChild variant="outline" className="w-fit">
          <Link to="/orders">К заказам</Link>
        </Button>
      </Shell>
    )
  }

  return <Loaded order={order.data.order} />
}

function Loaded({ order }: { order: OrderDto }) {
  const { user } = useAuth()
  const organization = useOrganization()
  const org = organization.data?.organization ?? null
  const status = STATUS_LABEL[order.status]
  // Сотрудник видит только отмену до оплаты; операторские переходы — у оператора платформы.
  const transitions = allowedOrderTransitionsFor(user?.role ?? 'USER', order.status)
  const placed = order.placedAt ?? order.createdAt
  const editable = EDITABLE_STATUSES.has(order.status)

  const createPayment = useCreatePayment()
  const updateStatus = useUpdateOrderStatus()
  const refund = useRefundOrder()
  const reorder = useReorder()
  const navigate = useNavigate()
  const [method, setMethod] = useState<PaymentMethod>('card')
  const [printMode, setPrintMode] = useState<PrintMode>('estimate')

  const canPay = order.status === 'PLACED' && order.paymentStatus !== 'SUCCEEDED'
  const canRefund = order.paymentStatus === 'SUCCEEDED' && order.status !== 'REFUNDED'
  // Без реквизитов заказ-наряд — не договор (ПП № 780, п. 9(а)): предупреждаем до печати.
  const requisitesMissing = !org?.legalName || !org?.inn || !org?.address

  const printAs = (mode: PrintMode) => {
    setPrintMode(mode)
    // Печатная разметка должна успеть переключиться до диалога печати.
    window.setTimeout(() => window.print(), 50)
  }

  const handlePay = () =>
    createPayment.mutate(
      { orderId: order.id, method },
      {
        onSuccess: (data) => {
          if (data.payment.confirmationUrl) window.location.href = data.payment.confirmationUrl
          else toast.error('Провайдер не вернул ссылку на оплату')
        },
        onError: (error) => toast.error(describeApiError(error)),
      },
    )

  const handleRefund = () => {
    if (!window.confirm('Вернуть средства по этому заказу?')) return
    refund.mutate(order.id, {
      onSuccess: () => toast.success('Возврат выполнен'),
      onError: (error) => toast.error(describeApiError(error)),
    })
  }

  const handleStatus = (target: OrderStatus) =>
    updateStatus.mutate(
      { orderId: order.id, status: target },
      {
        onSuccess: () => toast.success(`Статус: ${STATUS_LABEL[target].label}`),
        onError: (error) => toast.error(describeApiError(error)),
      },
    )

  const handleReorder = () =>
    reorder.mutate(order, {
      onSuccess: ({ added, unavailable }) => {
        if (added === 0) {
          toast.error('Не удалось добавить позиции — предложения устарели')
          return
        }
        toast.success(
          `Добавлено в корзину: ${added}` +
            (unavailable.length ? `. Недоступно: ${unavailable.join(', ')}` : ''),
        )
        void navigate({ to: '/cart' })
      },
      onError: (error) => toast.error(describeApiError(error)),
    })

  return (
    <Shell>
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link to={order.status === 'DRAFT' ? '/cart' : '/orders'}>
            {order.status === 'DRAFT' ? '← К корзине' : '← К заказам'}
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          {order.status !== 'DRAFT' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={reorder.isPending || order.items.length === 0}
              onClick={handleReorder}
            >
              {reorder.isPending ? <Spinner /> : null}
              Повторить заказ
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={() => printAs('estimate')}>
            Печать сметы
          </Button>
          <Button type="button" size="sm" onClick={() => printAs('workorder')}>
            Печать заказ-наряда
          </Button>
        </div>
      </div>

      {requisitesMissing && organization.isSuccess ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 print:hidden"
        >
          <Typography variant="bodySm">
            В заказ-наряде не хватает реквизитов автосервиса (наименование, ИНН, адрес) —{' '}
            <Link to="/settings" className="text-primary hover:underline">
              заполните их в настройках
            </Link>
            .
          </Typography>
        </div>
      ) : null}

      {/* Рабочая карточка: закуп, цена для клиента и маржа. На печать не идёт. */}
      <Card className="print:hidden">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Заказ № {order.number}</CardTitle>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
          <Typography tone="muted" variant="bodySm">
            от {new Date(placed).toLocaleString('ru-RU')}
            {order.vehicle
              ? ` · ${order.vehicle.make} ${order.vehicle.model}${order.vehicle.year ? ` ${order.vehicle.year}` : ''}`
              : ''}
            {order.vehicleVin ? ` · VIN ${order.vehicleVin}` : ''}
            {order.customer
              ? ` · ${order.customer.name}${order.customer.phone ? `, ${order.customer.phone}` : ''}`
              : ''}
          </Typography>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="hidden grid-cols-[1fr_auto_auto] gap-x-6 text-right sm:grid">
            <span />
            <Typography variant="bodyXs" tone="muted">
              Закуп
            </Typography>
            <Typography variant="bodyXs" tone="muted">
              Клиенту
            </Typography>
          </div>
          {order.items.map((item) => (
            <OrderItemRow key={item.id} item={item} />
          ))}
          <Separator />
          <div className="grid gap-1 sm:grid-cols-[1fr_auto_auto] sm:gap-x-6 sm:text-right">
            <Typography variant="bodySm" tone="muted">
              Запчасти ({order.itemCount} шт.)
            </Typography>
            <Typography variant="h5">{formatMoney(order.total)}</Typography>
            <Typography variant="h5">{formatMoney(order.saleTotal)}</Typography>
          </div>
          <Typography variant="bodyXs" tone="muted" className="sm:text-right">
            Маржа автосервиса по запчастям: {formatMoney(order.marginTotal)} (
            {marginPercent(order.total.amount, order.saleTotal.amount).toLocaleString('ru-RU')} %
            к закупу)
          </Typography>
          {order.works.length > 0 ? (
            <div className="grid gap-1 sm:grid-cols-[1fr_auto] sm:gap-x-6 sm:text-right">
              <Typography variant="bodySm" tone="muted">
                Работы ({order.works.length})
              </Typography>
              <Typography variant="h5">{formatMoney(order.worksTotal)}</Typography>
            </div>
          ) : null}
          <div className="grid gap-1 rounded-lg border border-primary p-3 sm:grid-cols-[1fr_auto] sm:gap-x-6 sm:text-right">
            <Typography variant="bodySmMedium">Итого клиенту</Typography>
            <Typography variant="h4">{formatMoney(order.grandTotal)}</Typography>
          </div>
        </CardContent>
      </Card>

      <WorksCard order={order} editable={editable} />
      <ReceptionCard key={order.id} order={order} editable={editable} />

      {/* Печатные формы: только одна из них видна на печати. */}
      {printMode === 'estimate' ? (
        <Estimate order={order} organization={org} />
      ) : (
        <WorkOrderPrint order={order} organization={org} />
      )}

      {/* Действия */}
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        {canPay ? (
          <>
            <div className="inline-flex rounded-lg border p-0.5">
              {(['card', 'sbp'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMethod(value)}
                  className={
                    'rounded-md px-3 py-1 text-sm font-medium transition-colors ' +
                    (method === value
                      ? 'bg-secondary text-secondary-foreground'
                      : 'text-muted-foreground hover:text-foreground')
                  }
                >
                  {value === 'card' ? 'Карта' : 'СБП'}
                </button>
              ))}
            </div>
            <Button type="button" disabled={createPayment.isPending} onClick={handlePay}>
              {createPayment.isPending ? <Spinner /> : null}
              Оплатить {formatMoney(order.total)}
            </Button>
          </>
        ) : null}
        {transitions.map((target) => (
          <Button
            key={target}
            type="button"
            variant={target === 'CANCELLED' ? 'outline' : 'default'}
            disabled={updateStatus.isPending}
            onClick={() => handleStatus(target)}
          >
            {TRANSITION_LABEL[target]}
          </Button>
        ))}
        {canRefund ? (
          <Button
            type="button"
            variant="destructive"
            disabled={refund.isPending}
            onClick={handleRefund}
          >
            {refund.isPending ? <Spinner /> : null}
            Вернуть деньги
          </Button>
        ) : null}
      </div>

      <NotesEditor orderId={order.id} initial={order.notes} />
    </Shell>
  )
}

function OrderItemRow({ item }: { item: OrderItemDto }) {
  const [showAnalogs, setShowAnalogs] = useState(false)

  return (
    <div className="grid gap-2">
      <div className="grid gap-1 sm:grid-cols-[1fr_auto_auto] sm:items-start sm:gap-x-6">
        <div className="min-w-0">
          <Typography variant="bodySmMedium">{item.partName}</Typography>
          <Typography variant="bodyXs" tone="muted">
            {item.brand} · {item.oemNumber} · {item.quantity} шт.
          </Typography>
          <button
            type="button"
            onClick={() => setShowAnalogs((value) => !value)}
            className="text-xs text-primary hover:underline"
          >
            {showAnalogs ? 'Скрыть аналоги' : 'Показать аналоги'}
          </button>
        </div>
        <Typography variant="bodySmMedium" className="shrink-0 sm:text-right">
          {formatMoney(item.lineTotal)}
        </Typography>
        <Typography variant="bodySmMedium" className="shrink-0 sm:text-right">
          {formatMoney(item.saleLineTotal)}
        </Typography>
      </div>
      {showAnalogs ? <AnalogsPanel oemNumber={item.oemNumber} /> : null}
    </div>
  )
}

/**
 * Работы (услуги) заказ-наряда. Цена — для клиента, в рублях; количество —
 * нормо-часы или штуки, как удобно мастеру.
 */
function WorksCard({ order, editable }: { order: OrderDto; editable: boolean }) {
  const addWork = useAddOrderWork()
  const removeWork = useRemoveOrderWork()
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [quantity, setQuantity] = useState('1')

  const handleAdd = (event: React.FormEvent) => {
    event.preventDefault()
    const amount = parseRubInput(price)
    const qty = Number.parseInt(quantity, 10)
    if (!name.trim()) {
      toast.error('Название работы обязательно')
      return
    }
    if (amount === null) {
      toast.error('Цена работы — число в рублях')
      return
    }
    if (!Number.isFinite(qty) || qty < 1 || qty > 99) {
      toast.error('Количество — от 1 до 99')
      return
    }
    addWork.mutate(
      { orderId: order.id, name: name.trim(), amount, quantity: qty },
      {
        onSuccess: () => {
          setName('')
          setPrice('')
          setQuantity('1')
        },
        onError: (error) => toast.error(describeApiError(error)),
      },
    )
  }

  return (
    <Card className="print:hidden">
      <CardHeader>
        <CardTitle>Работы</CardTitle>
        <CardDescription>
          Услуги автосервиса по этому заказу — вторая половина заказ-наряда рядом с запчастями.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {order.works.length === 0 ? (
          <Typography variant="bodySm" tone="muted">
            Работ пока нет.
          </Typography>
        ) : (
          order.works.map((work) => (
            <div
              key={work.id}
              className="grid gap-1 sm:grid-cols-[1fr_auto_auto] sm:items-center sm:gap-x-6"
            >
              <div className="min-w-0">
                <Typography variant="bodySmMedium">{work.name}</Typography>
                <Typography variant="bodyXs" tone="muted">
                  {formatMoney(work.price)} × {work.quantity}
                </Typography>
              </div>
              <Typography variant="bodySmMedium" className="sm:text-right">
                {formatMoney(work.lineTotal)}
              </Typography>
              {editable ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={removeWork.isPending}
                  onClick={() =>
                    removeWork.mutate(
                      { orderId: order.id, workId: work.id },
                      { onError: (error) => toast.error(describeApiError(error)) },
                    )
                  }
                >
                  Удалить
                </Button>
              ) : (
                <span />
              )}
            </div>
          ))
        )}

        {editable ? (
          <form onSubmit={handleAdd} className="grid gap-3 border-t pt-3 sm:grid-cols-[1fr_8rem_5rem_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Typography variant="label" tone="muted">
                Работа
              </Typography>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Замена передних колодок"
                maxLength={160}
              />
            </div>
            <div className="grid gap-1.5">
              <Typography variant="label" tone="muted">
                Цена, ₽
              </Typography>
              <Input
                value={price}
                onChange={(event) => setPrice(event.target.value)}
                placeholder="2500"
                inputMode="decimal"
              />
            </div>
            <div className="grid gap-1.5">
              <Typography variant="label" tone="muted">
                Кол-во
              </Typography>
              <Input
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                inputMode="numeric"
              />
            </div>
            <Button type="submit" variant="outline" disabled={addWork.isPending}>
              {addWork.isPending ? <Spinner /> : null}
              Добавить
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  )
}

/** Дата для `<input type="date">` из ISO-строки; пусто, если даты нет. */
function toDateInput(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Конец рабочего дня выбранной даты — срок исполнения в ISO для API. */
function fromDateInput(value: string): string | null {
  if (!value) return null
  const date = new Date(`${value}T18:00:00`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * Приём машины: то, что по ПП РФ № 780 (п. 9, п. 12) должно быть в
 * заказ-наряде и приёмо-сдаточном акте помимо перечня работ и запчастей.
 */
function ReceptionCard({ order, editable }: { order: OrderDto; editable: boolean }) {
  const update = useUpdateOrderReception()
  const { reception } = order
  const [dueAt, setDueAt] = useState(() => toDateInput(reception.dueAt))
  const [complaint, setComplaint] = useState(reception.complaint ?? '')
  const [conditionNotes, setConditionNotes] = useState(reception.conditionNotes ?? '')
  const [plate, setPlate] = useState(reception.plate ?? '')
  const [mileage, setMileage] = useState(reception.mileageKm ? String(reception.mileageKm) : '')

  const dirty =
    dueAt !== toDateInput(reception.dueAt) ||
    complaint.trim() !== (reception.complaint ?? '') ||
    conditionNotes.trim() !== (reception.conditionNotes ?? '') ||
    plate.trim().toUpperCase() !== (reception.plate ?? '') ||
    (mileage.replace(/\D/g, '') || '') !== (reception.mileageKm ? String(reception.mileageKm) : '')

  const handleSave = (event: React.FormEvent) => {
    event.preventDefault()
    const mileageDigits = mileage.replace(/\D/g, '')
    update.mutate(
      {
        orderId: order.id,
        dueAt: fromDateInput(dueAt),
        complaint: complaint.trim() || null,
        conditionNotes: conditionNotes.trim() || null,
        plate: plate.trim() || null,
        mileageKm: mileageDigits ? Number(mileageDigits) : null,
      },
      {
        onSuccess: () => toast.success('Данные приёма сохранены'),
        onError: (error) => toast.error(describeApiError(error)),
      },
    )
  }

  return (
    <Card className="print:hidden">
      <CardHeader>
        <CardTitle>Приём машины</CardTitle>
        <CardDescription>
          Причина обращения, состояние при приёме и срок — это печатается в заказ-наряде и
          приёмо-сдаточном акте. Госномер и пробег подставляются из гаража.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSave} className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Typography variant="label" tone="muted">
                Госномер
              </Typography>
              <Input
                value={plate}
                onChange={(event) => setPlate(event.target.value.toUpperCase())}
                placeholder="А123ВС777"
                maxLength={9}
                className="font-mono"
                disabled={!editable}
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
                disabled={!editable}
              />
            </div>
            <div className="grid gap-1.5">
              <Typography variant="label" tone="muted">
                Срок исполнения
              </Typography>
              <Input
                type="date"
                value={dueAt}
                onChange={(event) => setDueAt(event.target.value)}
                disabled={!editable}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Typography variant="label" tone="muted">
              Причина обращения
            </Typography>
            <Textarea
              value={complaint}
              onChange={(event) => setComplaint(event.target.value)}
              placeholder="Со слов клиента: скрип при торможении, вибрация на 80 км/ч…"
              maxLength={1000}
              rows={2}
              disabled={!editable}
            />
          </div>
          <div className="grid gap-1.5">
            <Typography variant="label" tone="muted">
              Комплектность и повреждения при приёме
            </Typography>
            <Textarea
              value={conditionNotes}
              onChange={(event) => setConditionNotes(event.target.value)}
              placeholder="Царапина на заднем бампере, нет запаски, топливо ¼…"
              maxLength={2000}
              rows={2}
              disabled={!editable}
            />
          </div>
          {editable ? (
            <Button type="submit" className="w-fit" disabled={!dirty || update.isPending}>
              {update.isPending ? <Spinner /> : null}
              Сохранить приём
            </Button>
          ) : null}
        </form>
      </CardContent>
    </Card>
  )
}

function vehicleLine(order: OrderDto): string {
  const car = order.vehicle
    ? `${order.vehicle.make} ${order.vehicle.model}${order.vehicle.year ? `, ${order.vehicle.year}` : ''}`
    : null
  return [
    car,
    order.vehicleVin ? `VIN ${order.vehicleVin}` : null,
    order.reception.plate ? `госномер ${order.reception.plate}` : null,
    order.reception.mileageKm ? `пробег ${order.reception.mileageKm.toLocaleString('ru-RU')} км` : null,
  ]
    .filter(Boolean)
    .join(', ')
}

/**
 * Печатная смета для клиента автосервиса. Показывается только на печати:
 * в ней нет закупочных цен и маржи, зато есть автосервис, клиент, машина и работы.
 */
function Estimate({ order, organization }: { order: OrderDto; organization: OrganizationDto | null }) {
  const placed = order.placedAt ?? order.createdAt
  return (
    <div className="hidden print:block">
      <div className="grid gap-1">
        <Typography variant="h3">{organization?.name ?? 'Автосервис'}</Typography>
        {organization?.phone ? <Typography variant="bodySm">{organization.phone}</Typography> : null}
        <Typography variant="h4" className="pt-3">
          Смета № {order.number} от {new Date(placed).toLocaleDateString('ru-RU')}
        </Typography>
        {order.customer ? (
          <Typography variant="bodySm">
            Клиент: {order.customer.name}
            {order.customer.phone ? `, ${order.customer.phone}` : ''}
          </Typography>
        ) : null}
        {order.vehicleVin ? <Typography variant="bodySm">Автомобиль: {vehicleLine(order)}</Typography> : null}
      </div>
      <PrintTable
        title="Запчасти и материалы"
        rows={order.items.map((item) => ({
          key: item.id,
          name: `${item.partName} · ${item.brand}`,
          quantity: item.quantity,
          price: formatMoney(item.salePrice),
          total: formatMoney(item.saleLineTotal),
        }))}
        total={formatMoney(order.saleTotal)}
      />
      {order.works.length > 0 ? (
        <PrintTable
          title="Работы"
          rows={order.works.map((work) => ({
            key: work.id,
            name: work.name,
            quantity: work.quantity,
            price: formatMoney(work.price),
            total: formatMoney(work.lineTotal),
          }))}
          total={formatMoney(order.worksTotal)}
        />
      ) : null}
      <div className="mt-3 text-right">
        <Typography variant="h5">Итого: {formatMoney(order.grandTotal)}</Typography>
      </div>
      {order.notes ? (
        <Typography variant="bodyXs" tone="muted" className="pt-3">
          {order.notes}
        </Typography>
      ) : null}
    </div>
  )
}

/**
 * Заказ-наряд по Правилам оказания услуг по ТО и ремонту автомототранспортных
 * средств (ПП РФ от 29.05.2025 № 780): п. 9 — состав договора, п. 12 —
 * приёмо-сдаточный акт. Реквизиты исполнителя, заказчик, машина, причина
 * обращения, состояние при приёме, работы и запчасти с ценами, срок, гарантия,
 * кто принял, подписи. Чек ККТ формирует касса, не этот документ.
 */
function WorkOrderPrint({
  order,
  organization,
}: {
  order: OrderDto
  organization: OrganizationDto | null
}) {
  const placed = order.placedAt ?? order.createdAt
  const blank = '____________________'
  const executor = [
    organization?.legalName ?? organization?.name ?? blank,
    organization?.inn ? `ИНН ${organization.inn}` : null,
    organization?.ogrn ? `ОГРН ${organization.ogrn}` : null,
    organization?.address ?? null,
    organization?.phone ? `тел. ${organization.phone}` : null,
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <div className="hidden print:block">
      <div className="grid gap-1">
        <Typography variant="h3">
          Заказ-наряд № {order.number} от {new Date(placed).toLocaleDateString('ru-RU')}
        </Typography>
        <Typography variant="bodyXs" tone="muted">
          Договор на оказание услуг по техническому обслуживанию и ремонту автомототранспортного
          средства (Правила, утв. Постановлением Правительства РФ от 29.05.2025 № 780)
        </Typography>
      </div>

      <dl className="mt-4 grid gap-1">
        <PrintFact label="Исполнитель" value={executor} />
        <PrintFact
          label="Заказчик"
          value={
            order.customer
              ? `${order.customer.name}${order.customer.phone ? `, тел. ${order.customer.phone}` : ''}`
              : blank
          }
        />
        <PrintFact label="Автомобиль" value={order.vehicleVin ? vehicleLine(order) : blank} />
        <PrintFact label="Причина обращения" value={order.reception.complaint ?? blank} />
        <PrintFact
          label="Комплектность и повреждения при приёме"
          value={order.reception.conditionNotes ?? 'без замечаний'}
        />
        <PrintFact
          label="Срок исполнения"
          value={
            order.reception.dueAt
              ? new Date(order.reception.dueAt).toLocaleDateString('ru-RU')
              : blank
          }
        />
      </dl>

      <PrintTable
        title="Работы"
        rows={order.works.map((work) => ({
          key: work.id,
          name: work.name,
          quantity: work.quantity,
          price: formatMoney(work.price),
          total: formatMoney(work.lineTotal),
        }))}
        total={formatMoney(order.worksTotal)}
        emptyText="Работы не указаны"
      />
      <PrintTable
        title="Запчасти и материалы исполнителя"
        rows={order.items.map((item) => ({
          key: item.id,
          name: `${item.partName} · ${item.brand} · ${item.oemNumber}`,
          quantity: item.quantity,
          price: formatMoney(item.salePrice),
          total: formatMoney(item.saleLineTotal),
        }))}
        total={formatMoney(order.saleTotal)}
        emptyText="Запчасти не указаны"
      />

      <div className="mt-3 grid gap-1">
        <Typography variant="h5" className="text-right">
          Итого к оплате: {formatMoney(order.grandTotal)}
        </Typography>
        <Typography variant="bodyXs">
          Порядок оплаты: при выдаче автомобиля, наличными или безналично (карта, СБП). Кассовый
          чек выдаётся при расчёте.
        </Typography>
        <Typography variant="bodyXs">
          Гарантия:{' '}
          {organization?.warrantyText ??
            'на выполненные работы — в соответствии с законодательством РФ; на запчасти — гарантия производителя.'}
        </Typography>
        <Typography variant="bodyXs">
          Запчасти и материалы заказчика: {blank}
        </Typography>
        {order.notes ? <Typography variant="bodyXs">Примечание: {order.notes}</Typography> : null}
      </div>

      <div className="mt-6 grid grid-cols-2 gap-6">
        <div className="grid gap-4">
          <Typography variant="bodyXs">
            Заказ принял: {order.acceptedBy ?? blank}
            <br />
            подпись {blank}
          </Typography>
          <Typography variant="bodyXs">
            Автомобиль принят {blank} (дата), подпись исполнителя {blank}
          </Typography>
        </div>
        <div className="grid gap-4">
          <Typography variant="bodyXs">
            Заказчик: с условиями согласен, автомобиль передал
            <br />
            подпись {blank}
          </Typography>
          <Typography variant="bodyXs">
            Автомобиль получен, комплектность и качество проверил {blank} (дата), подпись{' '}
            {blank}
          </Typography>
        </div>
      </div>
    </div>
  )
}

function PrintFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[14rem_1fr] gap-2">
      <Typography as="dt" variant="bodyXs" tone="muted">
        {label}
      </Typography>
      <Typography as="dd" variant="bodySm">
        {value}
      </Typography>
    </div>
  )
}

function PrintTable({
  title,
  rows,
  total,
  emptyText,
}: {
  title: string
  rows: { key: string; name: string; quantity: number; price: string; total: string }[]
  total: string
  emptyText?: string
}) {
  return (
    <div className="mt-4">
      <Typography variant="bodySmMedium">{title}</Typography>
      {rows.length === 0 ? (
        <Typography variant="bodyXs" tone="muted">
          {emptyText ?? '—'}
        </Typography>
      ) : (
        <table className="mt-1 w-full">
          <thead>
            <tr className="border-b text-left">
              <th className="py-1">
                <Typography variant="bodyXs">Наименование</Typography>
              </th>
              <th className="py-1 text-right">
                <Typography variant="bodyXs">Кол-во</Typography>
              </th>
              <th className="py-1 text-right">
                <Typography variant="bodyXs">Цена</Typography>
              </th>
              <th className="py-1 text-right">
                <Typography variant="bodyXs">Сумма</Typography>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b">
                <td className="py-1">
                  <Typography variant="bodySm">{row.name}</Typography>
                </td>
                <td className="py-1 text-right">
                  <Typography variant="bodySm">{row.quantity}</Typography>
                </td>
                <td className="py-1 text-right">
                  <Typography variant="bodySm">{row.price}</Typography>
                </td>
                <td className="py-1 text-right">
                  <Typography variant="bodySm">{row.total}</Typography>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} className="py-1 text-right">
                <Typography variant="bodySmMedium">Итого</Typography>
              </td>
              <td className="py-1 text-right">
                <Typography variant="bodySmMedium">{total}</Typography>
              </td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  )
}

function NotesEditor({ orderId, initial }: { orderId: string; initial: string | null }) {
  const [notes, setNotes] = useState(initial ?? '')
  const updateNotes = useUpdateOrderNotes()
  const dirty = notes !== (initial ?? '')

  return (
    <Card className="print:hidden">
      <CardHeader>
        <CardTitle>Заметка к заказу</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Комментарий: договорённости, особенности… Печатается в смете и заказ-наряде."
          maxLength={2000}
          rows={3}
        />
        <Button
          type="button"
          className="w-fit"
          disabled={!dirty || updateNotes.isPending}
          onClick={() =>
            updateNotes.mutate(
              { orderId, notes },
              {
                onSuccess: () => toast.success('Заметка сохранена'),
                onError: (error) => toast.error(describeApiError(error)),
              },
            )
          }
        >
          {updateNotes.isPending ? <Spinner /> : null}
          Сохранить заметку
        </Button>
      </CardContent>
    </Card>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <section className="mx-auto grid w-full max-w-3xl gap-5 px-5 py-10">{children}</section>
}
