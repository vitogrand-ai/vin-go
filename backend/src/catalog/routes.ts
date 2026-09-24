import {
  apiErrorSchema,
  branchSchemesRequestSchema,
  branchSchemesResponseSchema,
  catalogStatusResponseSchema,
  catalogTreeRequestSchema,
  catalogTreeResponseSchema,
  decodeVinRequestSchema,
  decodeVinResponseSchema,
  offersRequestSchema,
  offersResponseSchema,
  resolvePlateRequestSchema,
  resolvePlateResponseSchema,
  schemePartsRequestSchema,
  searchPartsRequestSchema,
  searchPartsResponseSchema,
} from '@web-app-demo/contracts'
import { createRoute, OpenAPIHono } from '@hono/zod-openapi'

import { AppError, validationErrorHook } from '../http/errors'
import { fetchSchemeImage, parseSchemeImageUrl } from './scheme-image'
import type { CatalogService } from './service'

type CatalogRouteEnv = {
  Variables: {
    catalogService: CatalogService
  }
}

const errorResponseContent = {
  'application/json': { schema: apiErrorSchema },
}

const decodeVinRoute = createRoute({
  method: 'post',
  path: '/decode-vin',
  request: {
    body: { content: { 'application/json': { schema: decodeVinRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: decodeVinResponseSchema } },
      description: 'Расшифрованный автомобиль',
    },
    400: { content: errorResponseContent, description: 'Некорректный VIN' },
    404: { content: errorResponseContent, description: 'Автомобиль не найден' },
  },
})

const resolvePlateRoute = createRoute({
  method: 'post',
  path: '/resolve-plate',
  request: {
    body: { content: { 'application/json': { schema: resolvePlateRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: resolvePlateResponseSchema } },
      description: 'Автомобиль по госномеру',
    },
    400: { content: errorResponseContent, description: 'Некорректный госномер' },
    404: { content: errorResponseContent, description: 'Автомобиль не найден' },
  },
})

const searchPartsRoute = createRoute({
  method: 'post',
  path: '/search',
  request: {
    body: { content: { 'application/json': { schema: searchPartsRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: searchPartsResponseSchema } },
      description: 'Автомобиль и найденные запчасти',
    },
    400: { content: errorResponseContent, description: 'Некорректный запрос' },
    404: { content: errorResponseContent, description: 'Автомобиль не найден' },
  },
})

const schemePartsRoute = createRoute({
  method: 'post',
  path: '/scheme',
  request: {
    body: { content: { 'application/json': { schema: schemePartsRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: searchPartsResponseSchema } },
      description: 'Детали узла схемы: весь узел либо одна выноска',
    },
    400: { content: errorResponseContent, description: 'Некорректный запрос' },
    404: { content: errorResponseContent, description: 'Автомобиль не найден' },
  },
})

const catalogTreeRoute = createRoute({
  method: 'post',
  path: '/tree',
  request: {
    body: { content: { 'application/json': { schema: catalogTreeRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: catalogTreeResponseSchema } },
      description: 'Дерево узлов каталога машины (плоский список)',
    },
    400: { content: errorResponseContent, description: 'Некорректный запрос' },
    404: { content: errorResponseContent, description: 'Автомобиль не найден' },
  },
})

const branchSchemesRoute = createRoute({
  method: 'post',
  path: '/branch-schemes',
  request: {
    body: { content: { 'application/json': { schema: branchSchemesRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: branchSchemesResponseSchema } },
      description: 'Схемы листа дерева узлов',
    },
    400: { content: errorResponseContent, description: 'Некорректный запрос' },
    404: { content: errorResponseContent, description: 'Автомобиль не найден' },
  },
})

const offersRoute = createRoute({
  method: 'post',
  path: '/offers',
  request: {
    body: { content: { 'application/json': { schema: offersRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: offersResponseSchema } },
      description: 'Предложения по тирам и полный список',
    },
    400: { content: errorResponseContent, description: 'Некорректный запрос' },
  },
})

const statusRoute = createRoute({
  method: 'get',
  path: '/status',
  responses: {
    200: {
      content: { 'application/json': { schema: catalogStatusResponseSchema } },
      description: 'Подключённые источники данных и признак демо-режима',
    },
  },
})

export type CatalogRoutesOptions = {
  /** fetch для прокси схем — подменяется в тестах, по умолчанию глобальный. */
  imageFetch?: typeof fetch
}

export function createCatalogRoutes(options: CatalogRoutesOptions = {}) {
  const routes = new OpenAPIHono<CatalogRouteEnv>({
    defaultHook: validationErrorHook,
  })
  const imageFetch = options.imageFetch ?? fetch

  routes.openapi(statusRoute, (c) => {
    return c.json(c.get('catalogService').status(), 200)
  })

  // Схема узла через наш адрес — для браузера на HTTPS-странице и мобильного:
  // 17vin отдаёт картинки только по HTTP (см. scheme-image.ts). Не в OpenAPI:
  // ответ бинарный, а не JSON-контракт.
  routes.get('/image', async (c) => {
    const url = parseSchemeImageUrl(c.req.query('src') ?? '')
    if (!url) {
      throw new AppError(400, 'BAD_REQUEST', 'Проксируются только схемы подключённых каталогов')
    }
    const image = await fetchSchemeImage(url, imageFetch)
    return c.body(image.bytes, 200, {
      'Content-Type': image.contentType,
      // Схема узла не меняется: день в кэше браузера экономит и CDN каталогу, и нам.
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    })
  })

  routes.openapi(decodeVinRoute, async (c) => {
    const service = c.get('catalogService')
    const { vin } = c.req.valid('json')
    return c.json(await service.decodeVin(vin), 200)
  })

  routes.openapi(resolvePlateRoute, async (c) => {
    const service = c.get('catalogService')
    const { plate } = c.req.valid('json')
    return c.json(await service.resolvePlate(plate), 200)
  })

  routes.openapi(searchPartsRoute, async (c) => {
    const service = c.get('catalogService')
    const { vin, query } = c.req.valid('json')
    return c.json(await service.searchParts(vin, query), 200)
  })

  routes.openapi(schemePartsRoute, async (c) => {
    const service = c.get('catalogService')
    const { vin, schemeId, position } = c.req.valid('json')
    return c.json(await service.schemeParts(vin, schemeId, position), 200)
  })

  routes.openapi(catalogTreeRoute, async (c) => {
    const service = c.get('catalogService')
    const { vin } = c.req.valid('json')
    return c.json(await service.catalogTree(vin), 200)
  })

  routes.openapi(branchSchemesRoute, async (c) => {
    const service = c.get('catalogService')
    const { vin, branchId } = c.req.valid('json')
    return c.json(await service.branchSchemes(vin, branchId), 200)
  })

  routes.openapi(offersRoute, async (c) => {
    const service = c.get('catalogService')
    const { oemNumber, region } = c.req.valid('json')
    return c.json(await service.getOffers(oemNumber, region), 200)
  })

  return routes
}
