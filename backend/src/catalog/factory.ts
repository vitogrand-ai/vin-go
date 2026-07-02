import type { AppEnv } from '../env'
import { MockCatalogProvider, MockPlateProvider, MockSupplierProvider } from './mock-providers'
import { CachingSupplierProvider, type OfferResolver } from './offer-cache'
import type { CatalogProvider, PlateProvider, SupplierProvider } from './providers'

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
 * Сейчас всегда мок: боевых ключей (Laximo/TecDoc, ABCP/Emex/Berg/Армтек, реестр
 * госномеров) пока нет. Реальные адаптеры подключаются ЗДЕСЬ по env (тот же паттерн,
 * что `createPaymentProvider`) — маршруты, `CatalogService`, бот и веб при этом не
 * меняются, потому что все они работают через интерфейсы провайдеров.
 *
 * Точка расширения (пример): когда появится боевой адаптер поставщиков,
 *   suppliers: env.ABCP_LOGIN && env.ABCP_PASSWORD
 *     ? new AbcpSupplierProvider(env.ABCP_LOGIN, env.ABCP_PASSWORD)
 *     : new MockSupplierProvider()
 */
export function createCatalogProviders(_env: AppEnv): CatalogProviders {
  // Поставщики оборачиваются кэшем-снимком: поиск запоминает предложения по id,
  // корзина резолвит выбранное из снимка (см. CachingSupplierProvider).
  const suppliers = new CachingSupplierProvider(new MockSupplierProvider())
  return {
    catalog: new MockCatalogProvider(),
    suppliers,
    plates: new MockPlateProvider(),
    offerResolver: suppliers,
  }
}
