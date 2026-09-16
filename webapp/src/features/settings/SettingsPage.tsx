import type { OrganizationDto, TelegramLinkCodeResponse } from '@web-app-demo/contracts'
import { bpsToPercent, percentToBps } from '@web-app-demo/contracts'
import { useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Typography } from '@/components/ui/typography'
import { RequireAuth } from '@/features/cabinet/RequireAuth'
import {
  useJoinOrganization,
  useOrganization,
  useRotateInviteCode,
  useTelegramLinkCode,
  useTelegramStatus,
  useUpdateOrganization,
} from '@/features/cabinet/queries'
import { describeApiError } from '@/lib/errors'
import { formatMarkup } from '@/lib/format'
import { useAuth } from '@/lib/use-auth'

export function SettingsPage() {
  return (
    <RequireAuth>
      <Settings />
    </RequireAuth>
  )
}

function Settings() {
  return (
    <section className="mx-auto grid w-full max-w-3xl gap-6 px-5 py-10">
      <div className="grid gap-3">
        <Badge variant="outline" className="w-fit">
          Настройки
        </Badge>
        <Typography variant="h1">Настройки</Typography>
      </div>

      <OrganizationCard />
      <JoinOrganizationCard />
      <TelegramCard />
    </section>
  )
}

/**
 * Автосервис: название, телефон (печатаются в смете), наценка по умолчанию и
 * код приглашения сотрудников. Менять может только владелец — сотрудник видит
 * значения и код, чтобы позвать коллегу.
 */
function OrganizationCard() {
  const { user } = useAuth()
  const org = useOrganization()

  if (org.isPending) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 pt-6">
          <Spinner />
          <Typography tone="muted">Загружаем автосервис…</Typography>
        </CardContent>
      </Card>
    )
  }
  if (org.isError) {
    return <Typography tone="destructive">{describeApiError(org.error)}</Typography>
  }

  const isOwner = user?.orgRole === 'OWNER'
  return (
    <OrganizationForm
      key={org.data.organization.id}
      organization={org.data.organization}
      isOwner={isOwner}
    />
  )
}

type OrgDraft = {
  name?: string
  phone?: string
  markupPercent?: string
  legalName?: string
  inn?: string
  ogrn?: string
  address?: string
  warrantyText?: string
}

function OrganizationForm({
  organization,
  isOwner,
}: {
  organization: OrganizationDto
  isOwner: boolean
}) {
  const update = useUpdateOrganization()
  const rotate = useRotateInviteCode()
  // Форма хранит только то, что человек правит; остальное берётся из ответа
  // сервера — после сохранения черновик сбрасывается, и поля показывают факт.
  const [draft, setDraft] = useState<OrgDraft>({})
  const name = draft.name ?? organization.name
  const phone = draft.phone ?? organization.phone ?? ''
  const markupPercent = draft.markupPercent ?? String(bpsToPercent(organization.defaultMarkupBps))
  // Реквизиты для заказ-наряда (ПП РФ № 780, п. 9(а)).
  const legalName = draft.legalName ?? organization.legalName ?? ''
  const inn = draft.inn ?? organization.inn ?? ''
  const ogrn = draft.ogrn ?? organization.ogrn ?? ''
  const address = draft.address ?? organization.address ?? ''
  const warrantyText = draft.warrantyText ?? organization.warrantyText ?? ''
  const setName = (value: string) => setDraft((current) => ({ ...current, name: value }))
  const setPhone = (value: string) => setDraft((current) => ({ ...current, phone: value }))
  const setMarkupPercent = (value: string) =>
    setDraft((current) => ({ ...current, markupPercent: value }))
  const setField = (field: keyof OrgDraft) => (value: string) =>
    setDraft((current) => ({ ...current, [field]: value }))
  const requisiteChanged = (value: string, saved: string | null) => (value.trim() || null) !== saved

  const parsedPercent = Number(markupPercent.replace(',', '.'))
  const markupValid = Number.isFinite(parsedPercent) && parsedPercent >= 0 && parsedPercent <= 1000
  const dirty =
    name.trim() !== organization.name ||
    (phone.trim() || null) !== organization.phone ||
    (markupValid && percentToBps(parsedPercent) !== organization.defaultMarkupBps) ||
    requisiteChanged(legalName, organization.legalName) ||
    requisiteChanged(inn, organization.inn) ||
    requisiteChanged(ogrn, organization.ogrn) ||
    requisiteChanged(address, organization.address) ||
    requisiteChanged(warrantyText, organization.warrantyText)

  const handleSave = (event: React.FormEvent) => {
    event.preventDefault()
    if (!markupValid) {
      toast.error('Наценка — число от 0 до 1000 %')
      return
    }
    update.mutate(
      {
        name: name.trim(),
        phone: phone.trim() === '' ? null : phone.trim(),
        defaultMarkupBps: percentToBps(parsedPercent),
        legalName: legalName.trim() || null,
        inn: inn.trim() || null,
        ogrn: ogrn.trim() || null,
        address: address.trim() || null,
        warrantyText: warrantyText.trim() || null,
      },
      {
        onSuccess: () => {
          setDraft({})
          toast.success('Настройки автосервиса сохранены')
        },
        onError: (error) => toast.error(describeApiError(error)),
      },
    )
  }

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(organization.inviteCode)
      toast.success('Код приглашения скопирован')
    } catch {
      toast.error('Не удалось скопировать — выделите код вручную')
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Автосервис</CardTitle>
          <Badge variant={isOwner ? 'default' : 'secondary'}>
            {isOwner ? 'Владелец' : 'Сотрудник'}
          </Badge>
        </div>
        <CardDescription>
          Название и телефон печатаются в смете для клиента, реквизиты — в заказ-наряде. Наценка по
          умолчанию применяется к каждой позиции при добавлении в корзину — её можно поправить
          вручную в самой корзине.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <form onSubmit={handleSave} className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Typography variant="label" tone="muted">
                Название
              </Typography>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                disabled={!isOwner}
              />
            </div>
            <div className="grid gap-1.5">
              <Typography variant="label" tone="muted">
                Телефон для клиентов
              </Typography>
              <Input
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="+7 900 000-00-00"
                maxLength={32}
                inputMode="tel"
                disabled={!isOwner}
              />
            </div>
          </div>
          <div className="grid gap-4 rounded-lg border p-4">
            <div className="grid gap-0.5">
              <Typography variant="bodySmMedium">Реквизиты для заказ-наряда</Typography>
              <Typography variant="bodyXs" tone="muted">
                Наименование юрлица или ИП, ИНН, ОГРН и адрес — обязательные сведения об
                исполнителе (Правила ТО и ремонта, ПП РФ № 780, п. 9).
              </Typography>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5 sm:col-span-2">
                <Typography variant="label" tone="muted">
                  Юридическое наименование
                </Typography>
                <Input
                  value={legalName}
                  onChange={(event) => setField('legalName')(event.target.value)}
                  placeholder="ИП Иванов И.И. или ООО «Автосервис»"
                  maxLength={160}
                  disabled={!isOwner}
                />
              </div>
              <div className="grid gap-1.5">
                <Typography variant="label" tone="muted">
                  ИНН
                </Typography>
                <Input
                  value={inn}
                  onChange={(event) => setField('inn')(event.target.value)}
                  placeholder="10 или 12 цифр"
                  inputMode="numeric"
                  maxLength={12}
                  disabled={!isOwner}
                />
              </div>
              <div className="grid gap-1.5">
                <Typography variant="label" tone="muted">
                  ОГРН / ОГРНИП
                </Typography>
                <Input
                  value={ogrn}
                  onChange={(event) => setField('ogrn')(event.target.value)}
                  placeholder="13 или 15 цифр"
                  inputMode="numeric"
                  maxLength={15}
                  disabled={!isOwner}
                />
              </div>
              <div className="grid gap-1.5 sm:col-span-2">
                <Typography variant="label" tone="muted">
                  Адрес
                </Typography>
                <Input
                  value={address}
                  onChange={(event) => setField('address')(event.target.value)}
                  placeholder="г. Москва, ул. Автосервисная, 1"
                  maxLength={300}
                  disabled={!isOwner}
                />
              </div>
              <div className="grid gap-1.5 sm:col-span-2">
                <Typography variant="label" tone="muted">
                  Гарантия (текст в заказ-наряде)
                </Typography>
                <Input
                  value={warrantyText}
                  onChange={(event) => setField('warrantyText')(event.target.value)}
                  placeholder="На работы — 30 дней, на запчасти — гарантия производителя"
                  maxLength={1000}
                  disabled={!isOwner}
                />
              </div>
            </div>
          </div>
          <div className="grid gap-1.5 sm:max-w-xs">
            <Typography variant="label" tone="muted">
              Наценка по умолчанию, %
            </Typography>
            <Input
              value={markupPercent}
              onChange={(event) => setMarkupPercent(event.target.value)}
              inputMode="decimal"
              aria-invalid={!markupValid}
              disabled={!isOwner}
            />
            <Typography variant="bodyXs" tone="muted">
              Сейчас: {formatMarkup(organization.defaultMarkupBps)}. Закуп 1 000 ₽ → клиенту{' '}
              {markupValid
                ? Math.round(1000 * (1 + parsedPercent / 100)).toLocaleString('ru-RU')
                : '—'}{' '}
              ₽.
            </Typography>
          </div>
          {isOwner ? (
            <Button type="submit" className="w-fit" disabled={!dirty || update.isPending}>
              {update.isPending ? <Spinner /> : null}
              Сохранить
            </Button>
          ) : (
            <Typography variant="bodyXs" tone="muted">
              Изменить настройки может владелец автосервиса.
            </Typography>
          )}
        </form>

        <div className="grid gap-2 rounded-lg border bg-muted/30 p-4">
          <Typography variant="bodySm" tone="muted">
            Код приглашения сотрудников. Коллега вводит его при регистрации — и попадает в ваш
            автосервис: общий гараж, клиенты и заказы. Сотрудников: {organization.memberCount}.
          </Typography>
          <div className="flex flex-wrap items-center gap-2">
            <Typography variant="code">{organization.inviteCode}</Typography>
            <Button type="button" size="sm" variant="outline" onClick={() => void copyInvite()}>
              Скопировать
            </Button>
            {isOwner ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={rotate.isPending}
                onClick={() =>
                  rotate.mutate(undefined, {
                    onSuccess: () => toast.success('Код обновлён, старый больше не действует'),
                    onError: (error) => toast.error(describeApiError(error)),
                  })
                }
              >
                Сменить код
              </Button>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/** Переход в другой автосервис по коду — для тех, кто зарегистрировался сам. */
function JoinOrganizationCard() {
  const join = useJoinOrganization()
  const [code, setCode] = useState('')

  return (
    <Card>
      <CardHeader>
        <CardTitle>Присоединиться к автосервису</CardTitle>
        <CardDescription>
          Если вас пригласили в существующий автосервис, введите его код. Ваша корзина переедет с
          вами, а пустой личный автосервис можно забыть.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (!code.trim()) return
            join.mutate(code, {
              onSuccess: (data) => {
                setCode('')
                toast.success(`Теперь вы в автосервисе «${data.organization.name}»`)
              },
              onError: (error) => toast.error(describeApiError(error)),
            })
          }}
          className="flex flex-wrap items-end gap-3"
        >
          <div className="grid gap-1.5">
            <Typography variant="label" tone="muted">
              Код приглашения
            </Typography>
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="ABCD2345"
              maxLength={32}
            />
          </div>
          <Button type="submit" variant="outline" disabled={!code.trim() || join.isPending}>
            {join.isPending ? <Spinner /> : null}
            Перейти
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function TelegramCard() {
  const status = useTelegramStatus()
  const linkCode = useTelegramLinkCode()
  const [code, setCode] = useState<TelegramLinkCodeResponse | null>(null)

  const linked = status.data?.linked ?? false

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Telegram-бот</CardTitle>
          {status.isPending ? null : (
            <Badge variant={linked ? 'default' : 'secondary'}>
              {linked ? 'Подключён' : 'Не подключён'}
            </Badge>
          )}
        </div>
        <CardDescription>
          Привяжите Telegram, чтобы искать запчасти, добавлять в корзину и смотреть заказы прямо в
          чате.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {code ? (
          <div className="grid gap-2 rounded-lg border bg-muted/30 p-4">
            <Typography variant="bodySm" tone="muted">
              Откройте бота и отправьте команду:
            </Typography>
            <Typography variant="code" className="text-base">
              /start {code.code}
            </Typography>
            {code.deepLink ? (
              <Button asChild size="sm" className="w-fit">
                <a href={code.deepLink} target="_blank" rel="noreferrer">
                  Открыть бота
                </a>
              </Button>
            ) : (
              <Typography variant="bodyXs" tone="muted">
                Имя бота не настроено — отправьте команду вручную в вашего бота.
              </Typography>
            )}
            <Typography variant="bodyXs" tone="muted">
              Код действует 15 минут.
            </Typography>
          </div>
        ) : null}

        <Button
          type="button"
          className="w-fit"
          disabled={linkCode.isPending}
          onClick={() =>
            linkCode.mutate(undefined, {
              onSuccess: (data) => {
                setCode(data)
                void status.refetch()
              },
              onError: (error) => toast.error(describeApiError(error)),
            })
          }
        >
          {linkCode.isPending ? <Spinner /> : null}
          {linked ? 'Перепривязать Telegram' : 'Подключить Telegram'}
        </Button>
      </CardContent>
    </Card>
  )
}
