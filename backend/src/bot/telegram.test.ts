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

/**
 * Схема узла раньше уходила ссылкой, и Telegram отвечал «failed to get HTTP URL
 * content»: CDN каталога не отдаёт файл его серверам. Теперь картинку качает
 * клиент и грузит файлом — тесты держат это поведение.
 */
describe('HttpTelegramClient.sendPhoto: картинка уходит файлом', () => {
  const PHOTO_URL = 'https://ru.img.parts-catalogs.com/r/300x430/subaru/S14-262-01.png'
  /** Сигнатура PNG — этого хватает, чтобы отличить байты картинки от подмены. */
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  /** Стаб с журналом вызовов: важно не только что ответили, но и куда ходили. */
  function recordingFetch(handler: (url: string) => Response) {
    const calls: { url: string; init?: RequestInit }[] = []
    const impl = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return handler(String(input))
    }) as unknown as typeof fetch
    return { impl, calls }
  }

  function catalogAndTelegram(photo: () => Response) {
    return recordingFetch((url) =>
      url.startsWith('https://api.telegram.org')
        ? new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
        : photo(),
    )
  }

  function okPhoto() {
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
  }

  test('скачивает картинку сама и шлёт её multipart-ом, а не ссылкой', async () => {
    const { impl, calls } = catalogAndTelegram(okPhoto)
    const client = new HttpTelegramClient(TOKEN, impl)

    await client.sendPhoto(42, PHOTO_URL, {
      caption: 'Колодки',
      parseMode: 'HTML',
      replyMarkup: { inline_keyboard: [[{ text: 'Эконом', callback_data: 'oem:1' }]] },
    })

    // Сначала каталог, потом Telegram — именно в этом порядке.
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toBe(PHOTO_URL)
    expect(calls[1]!.url).toContain('/sendPhoto')

    const form = calls[1]!.init?.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('chat_id')).toBe('42')
    expect(form.get('caption')).toBe('Колодки')
    expect(form.get('parse_mode')).toBe('HTML')
    // Клавиатура переживает multipart только строкой JSON.
    expect(JSON.parse(String(form.get('reply_markup')))).toEqual({
      inline_keyboard: [[{ text: 'Эконом', callback_data: 'oem:1' }]],
    })

    // В поле photo — байты картинки, а не её адрес.
    const sent = form.get('photo') as Blob
    expect(sent).toBeInstanceOf(Blob)
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(PNG)
    expect(String(form.get('photo'))).not.toContain('parts-catalogs')
  })

  test('недоступную картинку не несёт в Telegram — сбой виден сразу', async () => {
    const { impl, calls } = catalogAndTelegram(() => new Response('', { status: 404 }))
    const client = new HttpTelegramClient(TOKEN, impl)

    const error = await caught(client.sendPhoto(42, PHOTO_URL))

    expect(error.message).toContain('404')
    expect(error.message).not.toContain(TOKEN)
    // Единственный вызов — к каталогу: зря дёргать Bot API незачем.
    expect(calls).toHaveLength(1)
  })

  test('страницу-ошибку CDN с кодом 200 отличает от картинки', async () => {
    const { impl, calls } = catalogAndTelegram(
      () => new Response('<html>error</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    )
    const client = new HttpTelegramClient(TOKEN, impl)

    const error = await caught(client.sendPhoto(42, PHOTO_URL))

    expect(error.message).toContain('text/html')
    expect(calls).toHaveLength(1)
  })

  test('картинку с типом octet-stream узнаёт по байтам и шлёт', async () => {
    // Живьём 18.09.2026: CDN 17vin отдаёт схемы Jaguar как application/octet-stream,
    // бот отказывался от картинки и мастер получал выдачу без схемы.
    const { impl, calls } = catalogAndTelegram(
      () => new Response(PNG, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
    )
    const client = new HttpTelegramClient(TOKEN, impl)

    await client.sendPhoto(42, PHOTO_URL)

    expect(calls).toHaveLength(2)
    const sent = (calls[1]!.init?.body as FormData).get('photo') as Blob
    expect(sent.type).toBe('image/png')
  })

  test('octet-stream без подписи картинки в Telegram не несёт', async () => {
    const { impl, calls } = catalogAndTelegram(
      () =>
        new Response('not an image', {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
    )
    const client = new HttpTelegramClient(TOKEN, impl)

    const error = await caught(client.sendPhoto(42, PHOTO_URL))

    expect(error.message).toContain('octet-stream')
    expect(calls).toHaveLength(1)
  })

  test('отказ Bot API остаётся читаемым и без токена', async () => {
    const { impl } = recordingFetch((url) =>
      url.startsWith('https://api.telegram.org')
        ? new Response(JSON.stringify({ ok: false, description: 'PHOTO_INVALID_DIMENSIONS' }), {
            status: 400,
          })
        : okPhoto(),
    )
    const client = new HttpTelegramClient(TOKEN, impl)

    const error = await caught(client.sendPhoto(42, PHOTO_URL))

    expect(error.message).toContain('PHOTO_INVALID_DIMENSIONS')
    expect(error.message).not.toContain(TOKEN)
  })

  test('сетевой сбой при скачивании не выносит наружу токен', async () => {
    const client = new HttpTelegramClient(TOKEN, failingFetch())

    const error = await caught(client.sendPhoto(42, PHOTO_URL))

    expect(error.message).toContain('ConnectionRefused')
    expect(error.message).not.toContain(TOKEN)
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(TOKEN)
  })
})
