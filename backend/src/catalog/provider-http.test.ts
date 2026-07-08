import { describe, expect, test } from 'bun:test'

import { AppError } from '../http/errors'
import { requestProviderJson } from './provider-http'

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
