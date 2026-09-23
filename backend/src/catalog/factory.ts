import type { DbClient } from '../db'
import type { AppEnv } from '../env'
import { AbcpSupplierProvider } from './abcp-provider'
import { CatalogTranslator } from './catalog-translator'
import { CachingDealerPriceProvider } from './dealer-price-cache'
import { TranslatingCatalogProvider } from './translating-catalog'
import { AnthropicTranslationProvider } from './translation-provider'
import { ACAT_DEFAULT_BASE_URL, AcatCatalogProvider } from './acat-provider'
import { AVTOCOD_DEFAULT_BASE_URL, AvtocodPlateProvider } from './avtocod-provider'
import { EMEX_DEFAULT_BASE_URL, EmexSupplierProvider } from './emex-provider'
import { EPCDATA_DEFAULT_BASE_URL, EpcdataCatalogProvider } from './epcdata-provider'
import { FallbackCatalogProvider, type NamedCatalogProvider } from './fallback-catalog'
import { MergingSupplierProvider, type NamedSupplierProvider } from './merging-supplier'
import { MockCatalogProvider, MockPlateProvider, MockSupplierProvider } from './mock-providers'
import { CachingSupplierProvider, type OfferResolver } from './offer-cache'
import { PARTSAPI_DEFAULT_BASE_URL, PartsApiCatalogProvider } from './partsapi-provider'
import { PARTSCATALOGS_DEFAULT_BASE_URL, PartsCatalogsCatalogProvider } from './partscatalogs-provider'
import { PARTSINDEX_DEFAULT_BASE_URL, PartsIndexCatalogProvider } from './partsindex-provider'
import type {
  CatalogProvider,
  DealerPriceProvider,
  PlateProvider,
  SupplierProvider,
} from './providers'
import { CachingCatalogProvider } from './vin-cache'
import { VIN17_DEFAULT_BASE_URL, Vin17CatalogProvider } from './vin17-provider'
import { VPIC_DEFAULT_BASE_URL, VpicCatalogProvider } from './vpic-provider'
import type { DataSource } from '@web-app-demo/contracts'

export type CatalogProviders = {
  catalog: CatalogProvider
  suppliers: SupplierProvider
  plates: PlateProvider
  /** Снимок выдачи для резолва offerId корзиной (тот же инстанс, что suppliers). */
  offerResolver: OfferResolver
  /** Какие источники подключены и что из них демо — для честных ответов API. */
  meta: CatalogProvidersMeta
  /** Цена оригинала у дилеров; нет источника — нет и цены (мок её не выдумывает). */
  dealerPrices?: DealerPriceProvider
}

export type CatalogProvidersMeta = {
  catalog: DataSource
  suppliers: DataSource
  plates: DataSource
}

/** Метаданные для полностью мокового набора (бот без ключей, тесты). */
export const MOCK_PROVIDERS_META: CatalogProvidersMeta = {
  catalog: { names: ['mock'], demo: true },
  suppliers: { names: ['mock'], demo: true },
  plates: { names: ['mock'], demo: true },
}

/**
 * Выбор провайдеров каталога/поставщиков/госномеров по конфигурации — единая
 * точка сборки для API (app.ts) и бота (bot.ts), без дублирования моков.
 *
 * Реальные адаптеры подключаются ЗДЕСЬ по env (тот же паттерн, что
 * `createPaymentProvider`) — маршруты, `CatalogService`, бот и веб при этом не
 * меняются, потому что все они работают через интерфейсы провайдеров.
 *
 * Каталог: агрегация источников по ключам — acat (`ACAT_API_KEY`, широкий primary)
 *   + PartsAPI/TecDoc (`PARTSAPI_KEY`, боевой, ~428М кроссов, нужен РФ-IP)
 *   + PartsIndex (`PARTSINDEX_API_KEY`, свежие китайцы) + parts-catalogs
 *   (`PARTSCATALOGS_API_KEY`, мировой OEM с русской локализацией) + 17vin
 *   (`VIN17_USER`+`VIN17_PASSWORD`, китайский EPC, $0.15/VIN) + epcdata
 *   (`EPCDATA_API_KEY`, JDM по frame-номеру). 2+ заданы → связка через
 *   FallbackCatalogProvider; один → он; ни одного → мок.
 * Поставщики: слияние источников по ключам — ABCP/4mycar (`ABCP_LOGIN`+
 *   `ABCP_PASSWORD`+`ABCP_API_URL` — хост клиентского API магазина) + Emex
 *   (`EMEX_API_KEY`). Оба заданы → MergingSupplierProvider (сравнение цен);
 *   один → он; ни одного → мок.
 * Госномера: `AVTOCOD_API_KEY` → боевой Avtocod (госномер→VIN), иначе мок.
 * Перевод: `ANTHROPIC_API_KEY` + доступная БД → выдача каталога переводится на
 *   русский с кэшем (TranslatingCatalogProvider); иначе — язык провайдера.
 * Кэш VIN: при боевом каталоге и доступной БД расшифровка кэшируется в
 *   таблице vin_decodes (CachingCatalogProvider) — повторы бесплатны.
 * `meta` описывает, что подключено: API отдаёт это в ответах, чтобы веб и бот
 *   честно помечали демо-данные.
 */
export function createCatalogProviders(env: AppEnv, db?: DbClient): CatalogProviders {
  // Поставщики оборачиваются кэшем-снимком: поиск запоминает предложения по id,
  // корзина резолвит выбранное из снимка (см. CachingSupplierProvider).
  const supplierSources = createSupplierProvider(env)
  const suppliers = new CachingSupplierProvider(supplierSources.provider)
  const catalogSources = createCatalogProvider(env)

  return {
    catalog: withTranslation(withVinCache(catalogSources, db), env, db),
    suppliers,
    plates: env.AVTOCOD_API_KEY
      ? new AvtocodPlateProvider({
          apiKey: env.AVTOCOD_API_KEY,
          baseUrl: env.AVTOCOD_BASE_URL ?? AVTOCOD_DEFAULT_BASE_URL,
        })
      : new MockPlateProvider(),
    offerResolver: suppliers,
    dealerPrices: createDealerPriceProvider(env),
    meta: {
      catalog: { names: catalogSources.names, demo: catalogSources.names.length === 0 },
      suppliers: { names: supplierSources.names, demo: supplierSources.names.length === 0 },
      plates: env.AVTOCOD_API_KEY ? { names: ['avtocod'], demo: false } : { names: [], demo: true },
    },
  }
}

/**
 * Цена оригинала у дилеров. Сейчас её знает только 17vin (оп. 4006), и она
 * платная за каждый вызов — поэтому всегда за кэшем. Отдельный инстанс
 * адаптера безвреден: состояния, кроме кредов, у него нет.
 */
function createDealerPriceProvider(env: AppEnv): DealerPriceProvider | undefined {
  if (!env.VIN17_USER || !env.VIN17_PASSWORD) return undefined
  return new CachingDealerPriceProvider(
    new Vin17CatalogProvider({
      user: env.VIN17_USER,
      password: env.VIN17_PASSWORD,
      baseUrl: env.VIN17_BASE_URL ?? VIN17_DEFAULT_BASE_URL,
    }),
  )
}

/** Собранный слой источников: провайдер и имена боевых источников (пусто = мок). */
type AssembledSources<T> = { provider: T; names: string[] }

/**
 * Кэш расшифровки VIN в БД — только для боевых каталогов и только при наличии
 * БД: мок отвечает мгновенно и бесплатно, а тесты каталога живут без Postgres.
 */
function withVinCache(sources: AssembledSources<CatalogProvider>, db?: DbClient): CatalogProvider {
  if (sources.names.length === 0 || !db) return sources.provider
  return new CachingCatalogProvider(sources.provider, db)
}

/**
 * Оборачивает каталог переводом на русский, если есть ключ модели и БД под кэш.
 * Кэш обязателен: без него каждый поиск заново оплачивал бы перевод тех же
 * названий, поэтому при отсутствии `db` перевод не включается.
 */
function withTranslation(catalog: CatalogProvider, env: AppEnv, db?: DbClient): CatalogProvider {
  if (!env.ANTHROPIC_API_KEY || !db) return catalog

  const translator = new CatalogTranslator(
    db,
    new AnthropicTranslationProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.TRANSLATION_MODEL,
    }),
  )
  return new TranslatingCatalogProvider(catalog, translator)
}

/** Собирает поставщиков из доступных ключей: 0 → мок, 1 → он, 2+ → слияние выдач. */
function createSupplierProvider(env: AppEnv): AssembledSources<SupplierProvider> {
  const sources: NamedSupplierProvider[] = []

  if (env.ABCP_LOGIN && env.ABCP_PASSWORD && env.ABCP_API_URL) {
    sources.push({
      name: 'abcp',
      provider: new AbcpSupplierProvider({
        login: env.ABCP_LOGIN,
        password: env.ABCP_PASSWORD,
        baseUrl: env.ABCP_API_URL,
      }),
    })
  }

  if (env.EMEX_API_KEY) {
    sources.push({
      name: 'emex',
      provider: new EmexSupplierProvider({
        apiKey: env.EMEX_API_KEY,
        baseUrl: env.EMEX_BASE_URL ?? EMEX_DEFAULT_BASE_URL,
      }),
    })
  }

  const names = sources.map((source) => source.name)
  if (sources.length === 0) return { provider: new MockSupplierProvider(), names }
  if (sources.length === 1) return { provider: sources[0]!.provider, names }
  return { provider: new MergingSupplierProvider(sources), names }
}

/** Собирает каталог из доступных источников: 0 → мок, 1 → он, 2+ → агрегация. */
function createCatalogProvider(env: AppEnv): AssembledSources<CatalogProvider> {
  const sources: NamedCatalogProvider[] = []

  if (env.ACAT_API_KEY) {
    sources.push({
      name: 'acat',
      provider: new AcatCatalogProvider({
        apiKey: env.ACAT_API_KEY,
        baseUrl: env.ACAT_BASE_URL ?? ACAT_DEFAULT_BASE_URL,
      }),
    })
  }

  // PartsAPI/TecDoc — самый широкий источник применимости (2025Q4) и уже
  // оплачен. Ставим сразу после acat: он отвечает медленнее, но покрытие по
  // европейским и японским машинам шире, чем у остальных источников.
  if (env.PARTSAPI_KEY) {
    sources.push({
      name: 'partsapi',
      provider: new PartsApiCatalogProvider({
        apiKey: env.PARTSAPI_KEY,
        baseUrl: env.PARTSAPI_BASE_URL ?? PARTSAPI_DEFAULT_BASE_URL,
        methodKeys: {
          VINdecode: env.PARTSAPI_KEY_VINDECODE,
          getSearchTree: env.PARTSAPI_KEY_GETSEARCHTREE,
          getArticles: env.PARTSAPI_KEY_GETARTICLES,
        },
      }),
    })
  }

  if (env.PARTSINDEX_API_KEY) {
    sources.push({
      name: 'partsindex',
      provider: new PartsIndexCatalogProvider({
        apiKey: env.PARTSINDEX_API_KEY,
        baseUrl: env.PARTSINDEX_BASE_URL ?? PARTSINDEX_DEFAULT_BASE_URL,
      }),
    })
  }

  // Мировой OEM-каталог parts-catalogs.com: понимает VIN и frame, локализован на
  // русский (запросы поиска работают без словаря перевода). Тестовый ключ имеет
  // квоту по числу VIN, поэтому после подписочных источников, но перед 17vin:
  // покрытие мировое, а у 17vin сильная сторона — только китайцы. Имя источника
  // 'partscatalogs' захардкожено и в адаптере (проверка доверия к vehicle.raw).
  // Источник со схемами узлов: когда деталь нашёл каталог без картинок,
  // FallbackCatalogProvider добирает схемы здесь (это ещё один VIN в квоте).
  if (env.PARTSCATALOGS_API_KEY) {
    sources.push({
      name: 'partscatalogs',
      provider: new PartsCatalogsCatalogProvider({
        apiKey: env.PARTSCATALOGS_API_KEY,
        baseUrl: env.PARTSCATALOGS_BASE_URL ?? PARTSCATALOGS_DEFAULT_BASE_URL,
      }),
      providesImages: true,
    })
  }

  // Китайский EPC: после широких каталогов — платит $0.15 за каждый новый VIN,
  // поэтому пусть сперва отвечают источники с абонентской платой. Добирает
  // китайские авто (и локализованные иномарки), которые они не опознали.
  // Схемы узлов приходят вместе с деталями — своему поиску они не стоят ничего.
  // Но как ДОНОР схем для чужой выдачи (attachImages) 17vin декодирует VIN
  // заново, и если каталог этот VIN ещё не видел — это те самые $0.15. Отсюда
  // и порядок: доноров перебирают сверху вниз, parts-catalogs стоит выше.
  if (env.VIN17_USER && env.VIN17_PASSWORD) {
    sources.push({
      name: 'vin17',
      provider: new Vin17CatalogProvider({
        user: env.VIN17_USER,
        password: env.VIN17_PASSWORD,
        baseUrl: env.VIN17_BASE_URL ?? VIN17_DEFAULT_BASE_URL,
      }),
      providesImages: true,
    })
  }

  // JDM (правый руль): в общем порядке последним, но framePriority разворачивает
  // очередь для frame-номеров — они идут сюда первыми, не тратя вызовы широких
  // каталогов (см. FallbackCatalogProvider).
  if (env.EPCDATA_API_KEY) {
    sources.push({
      name: 'epcdata',
      provider: new EpcdataCatalogProvider({
        apiKey: env.EPCDATA_API_KEY,
        baseUrl: env.EPCDATA_BASE_URL ?? EPCDATA_DEFAULT_BASE_URL,
      }),
      framePriority: true,
    })
  }

  // Бесплатный государственный декодер NHTSA vPIC — последний рубеж, только
  // расшифровка VIN (`decodeOnly`: деталей у него нет). Реально помогает по
  // машинам рынка США — прочие VIN адаптер сам отсекает по контрольной цифре,
  // не делая сетевого вызова. Ключа не требует, поэтому подключается всегда,
  // когда есть хоть один боевой каталог; в чистом мок-режиме не участвует —
  // демо-набор не должен наполовину ходить в сеть.
  if (sources.length > 0) {
    sources.push({
      name: 'vpic',
      provider: new VpicCatalogProvider({ baseUrl: env.VPIC_BASE_URL ?? VPIC_DEFAULT_BASE_URL }),
      decodeOnly: true,
    })
  }

  const names = sources.map((source) => source.name)
  if (sources.length === 0) return { provider: new MockCatalogProvider(), names }
  if (sources.length === 1) return { provider: sources[0]!.provider, names }
  return { provider: new FallbackCatalogProvider(sources), names }
}
