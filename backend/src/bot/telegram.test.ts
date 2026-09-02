import { describe, expect, test } from 'bun:test'

import { describeNetworkError, HttpTelegramClient } from './telegram'

/**
 * Токен бота лежит прямо в пути URL каждого вызова Bot API, а объект ошибки
 * fetch хранит этот URL в поле `path`. Из-за этого `console.error(error)`
 * однажды напечатал боевой токен в journald. Тесты держат границу: наружу из
 * клиента не должно уходить ничего, где токен мог бы оказаться.
 */
const TOKEN = '8781563556:AAFnfb-testtoken-not-a-real-secret'

/** Ошибка ровно такой формы, какую бросает Bun при отказе соединения. */
function connectionRefused(url: string): Error {
  const error = new TypeError('Unable to connect. Is the computer able to access the url?') as
    & TypeError
    & { path: string; code: string; errno: number }
  error.path = url
  error.code = 'ConnectionRefused'
  error.errno = 0
  return error
}

/** Стаб fetch — та же идиома, что у провайдеров каталога (provider-http.ts). */
function stubFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: unknown) => handler(String(input))) as unknown as typeof fetch
}

function failingFetch(): typeof fetch {
  return stubFetch((url) => {
    throw connectionRefused(url)
  })
}

/** Возвращает пойманную ошибку вместо результата. */
async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
    throw new Error('ожидалась ошибка, но вызов завершился успешно')
  } catch (error) {
    return error as Error
  }
}

describe('HttpTelegramClient: токен не утекает в ошибки', () => {
  test('сетевой сбой getUpdates не выносит наружу URL с токеном', async () => {
    const client = new HttpTelegramClient(TOKEN, failingFetch())

    const error = await caught(client.getUpdates(0, 30))

    // Ни сообщение, ни любое собственное поле ошибки не содержат токен.
    expect(error.message).not.toContain(TOKEN)
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(TOKEN)
    // При этом причина сбоя обязана остаться читаемой — иначе чинить нечем.
    expect(error.message).toContain('getUpdates')
    expect(error.message).toContain('ConnectionRefused')
  })

  test('sendMessage при сетевом сбое ведёт себя так же', async () => {
    const client = new HttpTelegramClient(TOKEN, failingFetch())

    const error = await caught(client.sendMessage(1, 'привет'))

    expect(error.message).not.toContain(TOKEN)
    expect(error.message).toContain('sendMessage')
  })

  test('ошибку Bot API (ok:false) по-прежнему видно с описанием', async () => {
    const client = new HttpTelegramClient(
      TOKEN,
      stubFetch(
        () => new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 }),
      ),
    )

    const error = await caught(client.sendMessage(1, 'привет'))

    expect(error.message).toContain('chat not found')
    expect(error.message).not.toContain(TOKEN)
  })

  test('downloadFile при сбое возвращает null, а в лог не пишет токен', async () => {
    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '))

    try {
      const client = new HttpTelegramClient(TOKEN, failingFetch())

      expect(await client.downloadFile('file_1')).toBeNull()
      expect(warnings.join('\n')).not.toContain(TOKEN)
      expect(warnings.join('\n')).toContain('file_1')
    } finally {
      console.warn = realWarn
    }
  })
})

describe('describeNetworkError', () => {
  test('предпочитает код сбоя — по нему и чинят', () => {
    expect(describeNetworkError({ code: 'ConnectionRefused', path: 'https://secret' })).toBe(
      'ConnectionRefused',
    )
  })

  test('без кода берёт имя ошибки', () => {
    expect(describeNetworkError(new TypeError('нет связи'))).toBe('TypeError')
  })

  test('на мусоре не падает', () => {
    expect(describeNetworkError(null)).toBe('сетевая ошибка')
    expect(describeNetworkError('строка')).toBe('сетевая ошибка')
  })
})
