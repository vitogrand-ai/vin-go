import type { AppEnv } from '../env'
import { AbcpSupplierProvider } from './abcp-provider'
import { ACAT_DEFAULT_BASE_URL, AcatCatalogProvider } from './acat-provider'
import { AVTOCOD_DEFAULT_BASE_URL, AvtocodPlateProvider } from './avtocod-provider'
import { EMEX_DEFAULT_BASE_URL, EmexSupplierProvider } from './emex-provider'
import { EPCDATA_DEFAULT_BASE_URL, EpcdataCatalogProvider } from './epcdata-provider'
import { FallbackCatalogProvider, type NamedCatalogProvider } from './fallback-catalog'
import { MergingSupplierProvider, type NamedSupplierProvider } from './merging-supplier'
import { MockCatalogProvider, MockPlateProvider, MockSupplierProvider } from './mock-providers'
import { CachingSupplierProvider, type OfferResolver } from './offer-cache'
import { PARTSINDEX_DEFAULT_BASE_URL, PartsIndexCatalogProvider } from './partsindex-provider'
import type { CatalogProvider, PlateProvider, SupplierProvider } from './providers'
import { VIN17_DEFAULT_BASE_URL, Vin17CatalogProvider } from './vin17-provider'

export type CatalogProviders = {
  catalog: CatalogProvider
  suppliers: SupplierProvider
  plates: PlateProvider
  /** Снимок выдачи для резолва offerId корзиной (тот же инстанс, что suppliers). */
  offerResolver: OfferResolver
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
 *   + PartsIndex (`PARTSINDEX_API_KEY`, свежие китайцы) + 17vin (`VIN17_USER`+
 *   `VIN17_PASSWORD`, китайский EPC, $0.15/VIN) + epcdata (`EPCDATA_API_KEY`,
 *   JDM по frame-номеру). 2+ заданы → связка через FallbackCatalogProvider;
 *   один → он; ни одного → мок.
 * Поставщики: слияние источников по ключам — ABCP/4mycar (`ABCP_LOGIN`+
 *   `ABCP_PASSWORD`+`ABCP_API_URL` — хост клиентского API магазина) + Emex
 *   (`EMEX_API_KEY`). Оба заданы → MergingSupplierProvider (сравнение цен);
 *   один → он; ни одного → мок.
 * Госномера: `AVTOCOD_API_KEY` → боевой Avtocod (госномер→VIN), иначе мок.
 */
export function createCatalogProviders(env: AppEnv): CatalogProviders {
  // Поставщики оборачиваются кэшем-снимком: поиск запоминает предложения по id,
  // корзина резолвит выбранное из снимка (см. CachingSupplierProvider).
  const suppliers = new CachingSupplierProvider(createSupplierProvider(env))

  return {
    catalog: createCatalogProvider(env),
    suppliers,
    plates: env.AVTOCOD_API_KEY
      ? new AvtocodPlateProvider({
          apiKey: env.AVTOCOD_API_KEY,
          baseUrl: env.AVTOCOD_BASE_URL ?? AVTOCOD_DEFAULT_BASE_URL,
        })
      : new MockPlateProvider(),
    offerResolver: suppliers,
  }
}

/** Собирает поставщиков из доступных ключей: 0 → мок, 1 → он, 2+ → слияние выдач. */
function createSupplierProvider(env: AppEnv): SupplierProvider {
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

  if (sources.length === 0) return new MockSupplierProvider()
  if (sources.length === 1) return sources[0]!.provider
  return new MergingSupplierProvider(sources)
}

/** Собирает каталог из доступных источников: 0 → мок, 1 → он, 2+ → агрегация. */
function createCatalogProvider(env: AppEnv): CatalogProvider {
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

  if (env.PARTSINDEX_API_KEY) {
    sources.push({
      name: 'partsindex',
      provider: new PartsIndexCatalogProvider({
        apiKey: env.PARTSINDEX_API_KEY,
        baseUrl: env.PARTSINDEX_BASE_URL ?? PARTSINDEX_DEFAULT_BASE_URL,
      }),
    })
  }

  // Китайский EPC: после широких каталогов — платит $0.15 за каждый новый VIN,
  // поэтому пусть сперва отвечают источники с абонентской платой. Добирает
  // китайские авто (и локализованные иномарки), которые они не опознали.
  if (env.VIN17_USER && env.VIN17_PASSWORD) {
    sources.push({
      name: 'vin17',
      provider: new Vin17CatalogProvider({
        user: env.VIN17_USER,
        password: env.VIN17_PASSWORD,
        baseUrl: env.VIN17_BASE_URL ?? VIN17_DEFAULT_BASE_URL,
      }),
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

  if (sources.length === 0) return new MockCatalogProvider()
  if (sources.length === 1) return sources[0]!.provider
  return new FallbackCatalogProvider(sources)
}
