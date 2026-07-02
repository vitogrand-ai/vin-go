import type { TelegramLinkCodeResponse } from '@web-app-demo/contracts'
import { useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { Typography } from '@/components/ui/typography'
import { RequireAuth } from '@/features/cabinet/RequireAuth'
import { useTelegramLinkCode, useTelegramStatus } from '@/features/cabinet/queries'
import { describeApiError } from '@/lib/errors'

export function SettingsPage() {
  return (
    <RequireAuth>
      <Settings />
    </RequireAuth>
  )
}

function Settings() {
  const status = useTelegramStatus()
  const linkCode = useTelegramLinkCode()
  const [code, setCode] = useState<TelegramLinkCodeResponse | null>(null)

  const linked = status.data?.linked ?? false

  return (
    <section className="mx-auto grid w-full max-w-3xl gap-6 px-5 py-10">
      <div className="grid gap-3">
        <Badge variant="outline" className="w-fit">
          Настройки
        </Badge>
        <Typography variant="h1">Настройки</Typography>
      </div>

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
    </section>
  )
}
