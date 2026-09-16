import { describe, expect, test } from 'bun:test'
import { OpenAPIHono } from '@hono/zod-openapi'

import { handleError } from '../http/errors'
import { createCatalogRoutes } from './routes'
import { fetchSchemeImage, parseSchemeImageUrl, SCHEME_IMAGE_MAX_BYTES } from './scheme-image'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Заглушка сети: тесту важен только ответ, сигнатура fetch целиком не нужна. */
function stubFetch(handler: (input: string | URL | Request) => Promise<Response>): typeof fetch {
  return handler as unknown as typeof fetch
}

function imageResponse(bytes: Uint8Array<ArrayBuffer> = PNG, headers: Record<string, string> = {}) {
  return new Response(new Blob([bytes]), {
    status: 200,
    headers: { 'content-type': 'image/png', ...headers },
  })
}

describe('parseSchemeImageUrl — только картинки каталогов', () => {
  test('HTTP-хост 17vin разрешён: ради него прокси и существует', () => {
    const url = parseSchemeImageUrl('http://resource.17vin.com/img/toyota/153008A.png')
    expect(url?.hostname).toBe('resource.17vin.com')
  })

  test('CDN parts-catalogs разрешён', () => {
    expect(parseSchemeImageUrl('https://ru.img.parts-catalogs.com/a/b.png')).not.toBeNull()
  })

  test('чужой хост, не-http схема и мусор отклоняются', () => {
    expect(parseSchemeImageUrl('https://example.com/x.png')).toBeNull()
    expect(parseSchemeImageUrl('file:///etc/passwd')).toBeNull()
    expect(parseSchemeImageUrl('http://127.0.0.1:3000/health')).toBeNull()
    expect(parseSchemeImageUrl('not a url')).toBeNull()
    expect(parseSchemeImageUrl('')).toBeNull()
  })

  test('доступ в адресе (user:pass@host) не проксируем', () => {
    expect(parseSchemeImageUrl('http://u:p@resource.17vin.com/img/x.png')).toBeNull()
  })
})

describe('fetchSchemeImage — что отдаём наружу', () => {
  const url = new URL('http://resource.17vin.com/img/toyota/153008A.png')

  test('картинка приходит байт в байт со своим типом', async () => {
    const image = await fetchSchemeImage(url, stubFetch(async () => imageResponse()))
    expect(image.contentType).toBe('image/png')
    expect(new Uint8Array(image.bytes)).toEqual(PNG)
  })

  test('17vin отдаёт схему как octet-stream — узнаём PNG по сигнатуре', async () => {
    // Живой ответ resource.17vin.com, сент 2026: заголовок не image/*.
    const image = await fetchSchemeImage(
      url,
      stubFetch(async () => imageResponse(PNG, { 'content-type': 'application/octet-stream' })),
    )
    expect(image.contentType).toBe('image/png')
  })

  test('страница ошибки с заголовком image/png — всё равно не картинка → 502', async () => {
    await expect(
      fetchSchemeImage(
        url,
        stubFetch(
          async () =>
            new Response('<html>503</html>', { status: 200, headers: { 'content-type': 'image/png' } }),
        ),
      ),
    ).rejects.toMatchObject({ status: 502 })
  })

  test('404 каталога → 404 (схемы нет), не сбой', async () => {
    await expect(
      fetchSchemeImage(url, stubFetch(async () => new Response('', { status: 404 }))),
    ).rejects.toMatchObject({ status: 404 })
  })

  test('страница ошибки с кодом 200 — не картинка → 502', async () => {
    await expect(
      fetchSchemeImage(
        url,
        stubFetch(
          async () =>
            new Response('<html>503</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
        ),
      ),
    ).rejects.toMatchObject({ status: 502 })
  })

  test('слишком большой файл отклоняется по заголовку и по факту', async () => {
    await expect(
      fetchSchemeImage(
        url,
        stubFetch(async () => imageResponse(PNG, { 'content-length': String(SCHEME_IMAGE_MAX_BYTES + 1) })),
      ),
    ).rejects.toMatchObject({ status: 502 })

    const huge = new Uint8Array(SCHEME_IMAGE_MAX_BYTES + 1)
    await expect(fetchSchemeImage(url, stubFetch(async () => imageResponse(huge)))).rejects.toMatchObject({
      status: 502,
    })
  })

  test('сетевой сбой → 502', async () => {
    await expect(
      fetchSchemeImage(
        url,
        stubFetch(async () => {
          throw new Error('ECONNRESET')
        }),
      ),
    ).rejects.toMatchObject({ status: 502 })
  })
})

describe('GET /api/catalog/image — прокси схемы для браузера', () => {
  function appWith(fetchImpl: typeof fetch) {
    const app = new OpenAPIHono()
    app.route('/api/catalog', createCatalogRoutes({ imageFetch: fetchImpl }))
    app.onError(handleError)
    return app
  }

  test('отдаёт картинку каталога с кэшем и типом', async () => {
    const calls: string[] = []
    const app = appWith(
      stubFetch(async (input) => {
        calls.push(String(input))
        return imageResponse()
      }),
    )

    const src = 'http://resource.17vin.com/img/toyota/153008A.png'
    const res = await app.request(`/api/catalog/image?src=${encodeURIComponent(src)}`)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('max-age')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
    expect(calls).toEqual([src])
  })

  test('чужой адрес → 400, к сети не ходим', async () => {
    let called = false
    const app = appWith(
      stubFetch(async () => {
        called = true
        return imageResponse()
      }),
    )

    const res = await app.request(`/api/catalog/image?src=${encodeURIComponent('https://example.com/x.png')}`)
    expect(res.status).toBe(400)
    expect(called).toBe(false)
  })

  test('без src → 400', async () => {
    const app = appWith(stubFetch(async () => imageResponse()))
    expect((await app.request('/api/catalog/image')).status).toBe(400)
  })
})
