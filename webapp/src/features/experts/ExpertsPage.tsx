import { Link } from '@tanstack/react-router'
import type { ExpertRequestDto, ExpertRequestStatus } from '@web-app-demo/contracts'
import { useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { Typography } from '@/components/ui/typography'
import { AnalogsPanel } from '@/features/catalog/AnalogsPanel'
import { RequireAuth } from '@/features/cabinet/RequireAuth'
import { useAnswerExpertRequest, useExpertRequests } from '@/features/cabinet/queries'
import { describeApiError } from '@/lib/errors'
import { useAuth } from '@/lib/use-auth'

export function ExpertsPage() {
  return (
    <RequireAuth>
      <Experts />
    </RequireAuth>
  )
}

const STATUS_META: Record<
  ExpertRequestStatus,
  { label: string; variant: 'default' | 'secondary' | 'destructive' }
> = {
  NEW: { label: 'Ждёт эксперта', variant: 'secondary' },
  ANSWERED: { label: 'Есть ответ', variant: 'default' },
  REJECTED: { label: 'Отклонена', variant: 'destructive' },
}

/**
 * Заявки эксперту. Сотрудник автосервиса видит свои: статус, ответ и
 * предложения по найденным номерам. Оператор платформы видит общую очередь и
 * отвечает прямо здесь — это и есть «человек в цикле» для сложных VIN.
 */
function Experts() {
  const { user } = useAuth()
  const requests = useExpertRequests()
  const isOperator = user?.role === 'OPERATOR'
  const list = requests.data?.requests ?? []

  return (
    <section className="mx-auto grid w-full max-w-4xl gap-6 px-5 py-10">
      <div className="grid gap-3">
        <Badge variant="outline" className="w-fit">
          Эксперт
        </Badge>
        <Typography variant="h1">{isOperator ? 'Очередь заявок' : 'Заявки эксперту'}</Typography>
        <Typography tone="muted" className="max-w-2xl">
          {isOperator
            ? 'Автосервисы просят подобрать деталь, которую не нашли каталоги. Ответьте номерами — автор получит уведомление и сразу увидит предложения.'
            : 'Когда каталоги не нашли деталь, отправьте запрос эксперту из поиска. Ответ с каталожными номерами появится здесь и придёт уведомлением.'}
        </Typography>
      </div>

      {requests.isPending ? (
        <div className="flex items-center gap-3">
          <Spinner />
          <Typography tone="muted">Загружаем заявки…</Typography>
        </div>
      ) : requests.isError ? (
        <Typography tone="destructive">{describeApiError(requests.error)}</Typography>
      ) : list.length === 0 ? (
        <Card size="sm">
          <CardContent className="grid gap-3 pt-6">
            <Typography tone="muted">
              {isOperator
                ? 'Очередь пуста — все заявки закрыты.'
                : 'Заявок пока нет. Кнопка «Спросить эксперта» появляется в поиске, когда ничего не найдено.'}
            </Typography>
            {!isOperator ? (
              <Button asChild className="w-fit">
                <Link to="/search">Перейти к поиску</Link>
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {list.map((request) => (
            <RequestCard key={request.id} request={request} isOperator={isOperator} />
          ))}
        </div>
      )}
    </section>
  )
}

function RequestCard({ request, isOperator }: { request: ExpertRequestDto; isOperator: boolean }) {
  const meta = STATUS_META[request.status]
  const vehicle = request.vehicle
    ? `${request.vehicle.make} ${request.vehicle.model}` +
      (request.vehicle.year ? `, ${request.vehicle.year}` : '')
    : 'Авто не опознано каталогом'

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>
            № {request.number} · «{request.query}»
          </CardTitle>
          <Badge variant={meta.variant}>{meta.label}</Badge>
        </div>
        <CardDescription>
          {vehicle} · VIN {request.vin} · {new Date(request.createdAt).toLocaleString('ru-RU')}
          {isOperator ? ` · ${request.orgName}` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {request.comment ? (
          <Typography variant="bodySm" tone="muted">
            {request.comment}
          </Typography>
        ) : null}

        {request.answerText ? (
          <div className="grid gap-2 rounded-lg border bg-muted/30 p-4">
            <Typography variant="bodySmMedium">Ответ эксперта</Typography>
            <Typography variant="bodySm">{request.answerText}</Typography>
            {request.answerOems.map((oem) => (
              <div key={oem} className="grid gap-1">
                <Typography variant="code">{oem}</Typography>
                <AnalogsPanel oemNumber={oem} />
              </div>
            ))}
          </div>
        ) : null}

        {isOperator && request.status === 'NEW' ? <AnswerForm requestId={request.id} /> : null}
      </CardContent>
    </Card>
  )
}

/** Форма ответа оператора: текст + каталожные номера через запятую. */
function AnswerForm({ requestId }: { requestId: string }) {
  const answer = useAnswerExpertRequest()
  const [text, setText] = useState('')
  const [oems, setOems] = useState('')

  const submit = (status: 'ANSWERED' | 'REJECTED') => {
    if (!text.trim()) {
      toast.error('Напишите ответ')
      return
    }
    answer.mutate(
      {
        id: requestId,
        status,
        answerText: text.trim(),
        answerOems: oems
          .split(/[,;\s]+/)
          .map((value) => value.trim())
          .filter(Boolean),
      },
      {
        onSuccess: () => toast.success(status === 'ANSWERED' ? 'Ответ отправлен' : 'Заявка отклонена'),
        onError: (error) => toast.error(describeApiError(error)),
      },
    )
  }

  return (
    <div className="grid gap-2">
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Что подходит и почему: деталь, сторона, ограничения по двигателю…"
        maxLength={2000}
        rows={3}
      />
      <Input
        value={oems}
        onChange={(event) => setOems(event.target.value)}
        placeholder="Каталожные номера через запятую: 1K0407271AA, 1K0498099"
        maxLength={400}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={answer.isPending} onClick={() => submit('ANSWERED')}>
          {answer.isPending ? <Spinner /> : null}
          Ответить
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={answer.isPending}
          onClick={() => submit('REJECTED')}
        >
          Отклонить
        </Button>
      </div>
    </div>
  )
}
