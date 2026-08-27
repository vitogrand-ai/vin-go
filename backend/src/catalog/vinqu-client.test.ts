import { describe, expect, test } from 'bun:test'

import { AppError } from '../http/errors'
import { VinquExpertClient, mapQueryInfo } from './vinqu-client'

/** Стаб fetch с доступом к методу/телу запроса, без реальной сети. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: unknown, init?: RequestInit) =>
    handler(String(input), init)) as unknown as typeof fetch
}

function clientWith(handler: (url: string, init?: RequestInit) => Response): VinquExpertClient {
  return new VinquExpertClient({
    siteHash: 'site-hash',
    accessHash: 'access-hash',
    baseUrl: 'https://publicapi.vinqu.test',
    fetchImpl: stubFetch(handler),
  })
}

describe('VinquExpertClient.createQuery', () => {
  test('POST form-data на vinquery/add с авторизацией и carInfo → QueryId', async () => {
    let captured: { url: string; init?: RequestInit } | null = null
    const client = clientWith((url, init) => {
      captured = { url, init }
      return new Response(JSON.stringify({ QueryId: 4242 }), { status: 200 })
    })

    const queryId = await client.createQuery({
      car: { vin: 'JTDKB20U893478151', brand: 'Toyota', year: '2008' },
      parts: ['колодки передние', ' фильтр масляный '],
      clientComment: 'нужен оригинал',
      guest: { phone: '+79990000000' },
    })

    expect(queryId).toBe('4242')
    expect(captured!.url).toBe('https://publicapi.vinqu.test/vinquery/add')
    expect(captured!.init?.method).toBe('POST')
    const form = captured!.init?.body as FormData
    expect(form.get('siteHash')).toBe('site-hash')
    expect(form.get('accessHash')).toBe('access-hash')
    expect(form.get('carInfo[vin]')).toBe('JTDKB20U893478151')
    expect(form.getAll('parts[]')).toEqual(['колодки передние', 'фильтр масляный'])
    expect(form.get('clientComment')).toBe('нужен оригинал')
    expect(form.get('guestInfo[phone]')).toBe('+79990000000')
  })

  test('бизнес-ошибка {Error} при HTTP 200 → AppError(502) с причиной', async () => {
    const client = clientWith(
      () => new Response(JSON.stringify({ Error: 'неверный accessHash' }), { status: 200 }),
    )
    const error = await client
      .createQuery({ car: { vin: 'X' }, parts: ['деталь'] })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).status).toBe(502)
    expect((error as AppError).message).toContain('неверный accessHash')
  })
})

describe('VinquExpertClient.getQuery', () => {
  test('карточка запроса → номера от экспертов; удалённые офферы отброшены', async () => {
    const client = clientWith((url) => {
      expect(url).toContain('/vinquery/info/4242?')
      expect(url).toContain('siteHash=site-hash')
      return new Response(
        JSON.stringify({
          _id: '4242',
          status: 3,
          state: 1,
          parts: [
            {
              query: 'колодки передние',
              offers: [
                { brand: 'Toyota', number: '04465-42160', descr: 'Колодки', quantity: 1 },
                { brand: 'TRW', number: 'GDB3289', deleted: true }, // удалён экспертом
                { brand: 'NoNumber' }, // без номера — в проценку не отдать
              ],
            },
          ],
        }),
        { status: 200 },
      )
    })

    const info = await client.getQuery('4242')
    expect(info).not.toBeNull()
    expect(info!.id).toBe('4242')
    expect(info!.status).toBe(3)
    expect(info!.parts).toHaveLength(1)
    expect(info!.parts[0]!.offers).toEqual([
      { brand: 'Toyota', number: '04465-42160', description: 'Колодки', quantity: 1 },
    ])
  })

  test('404 → null (запрос не найден — это не ошибка)', async () => {
    const client = clientWith(() => new Response('not found', { status: 404 }))
    expect(await client.getQuery('missing')).toBeNull()
  })
})

describe('mapQueryInfo', () => {
  test('пустая карточка без parts → пустой список, id из аргумента', () => {
    const info = mapQueryInfo('77', { status: 0 })
    expect(info.id).toBe('77')
    expect(info.parts).toEqual([])
    expect(info.state).toBeNull()
  })
})
