import { describe, expect, test } from 'bun:test'

import { AppError } from '../http/errors'
import { requestProviderJson, safeUrl } from './provider-http'

describe('requestProviderJson: таймаут', () => {
  test('срабатывание таймаута → AppError(502) с внятной причиной', async () => {
    // fetch отклоняется TimeoutError-образной причиной — так реальный fetch
    // падает при срабатывании AbortSignal.timeout. Сам сигнал в тесте не ждём:
    // его unref-таймер в bun test не стреляет на пустом event loop (вечный hang).
    const timeoutFetch = (() =>
      new Promise((_resolve, reject) => {
        setTimeout(
          () => reject(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })),
          5,
        )
      })) as unknown as typeof fetch

    const error = await requestProviderJson({
      provider: 'test',
      url: 'https://api.test/hang',
      fetchImpl: timeoutFetch,
      timeoutMs: 20,
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).status).toBe(502)
    expect((error as AppError).message).toContain('20 мс')
  })

  test('таймаут во время ЧТЕНИЯ ТЕЛА → AppError(502), а не сырой DOMException (баг 500)', async () => {
    // Заголовки пришли вовремя, но AbortSignal сработал при стриминге тела —
    // response.text() отклоняется TimeoutError уже после успешного fetch.
    const bodyTimeoutFetch = (async () =>
      ({
        status: 200,
        ok: true,
        text: () =>
          Promise.reject(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })),
      }) as unknown as Response) as unknown as typeof fetch

    const error = await requestProviderJson({
      provider: 'test',
      url: 'https://api.test/slow-body',
      fetchImpl: bodyTimeoutFetch,
      timeoutMs: 20,
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).status).toBe(502)
    expect((error as AppError).message).toContain('не дочитано')
  })

  test('быстрый ответ проходит до таймаута', async () => {
    const okFetch = (async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch
    const data = await requestProviderJson({
      provider: 'test',
      url: 'https://api.test/fast',
      fetchImpl: okFetch,
      timeoutMs: 1000,
    })
    expect(data).toEqual({ ok: true })
  })
})


/**
 * Ключи части провайдеров лежат прямо в query (`key` у PartsAPI, `user`+`token`
 * у 17vin), а при сбое модуль пишет адрес в журнал. Так уже утекал токен бота —
 * тест держит границу.
 */
describe('safeUrl: секреты не уходят в журнал', () => {
  test('значения ключей и логинов заменяются', () => {
    const masked = safeUrl('https://api.partsapi.ru/?method=VINdecode&key=SECRET123&vin=WVW')
    expect(masked).not.toContain('SECRET123')
    expect(masked).toContain('key=***')
    expect(masked).toContain('method=VINdecode') // остальное читаемо — по нему чинят

    const vin17 = safeUrl('http://api.17vin.com:8080/toyota?action=search&user=alice&token=abc123')
    expect(vin17).not.toContain('abc123')
    expect(vin17).not.toContain('alice')
    expect(vin17).toContain('action=search')
  })

  test('адрес без секретов не портится', () => {
    const plain = 'https://api.parts-catalogs.com/v1/car/info?q=WVWZZZ1JZ3W386752'
    expect(safeUrl(plain)).toBe(plain)
  })

  test('токен в пути (Telegram) убирает весь путь', () => {
    expect(safeUrl('https://api.telegram.org/bot123456:AAsecret/sendMessage')).toBe(
      'https://api.telegram.org/***',
    )
  })

  test('неразобранный адрес наружу не отдаётся', () => {
    expect(safeUrl('не-адрес-с-секретом')).toBe('<адрес скрыт>')
  })
})
