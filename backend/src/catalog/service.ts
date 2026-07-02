import type {
  DecodeVinResponse,
  OffersResponse,
  ResolvePlateResponse,
  SearchPartsResponse,
} from '@web-app-demo/contracts'

import { AppError } from '../http/errors'
import { MockCatalogProvider, MockPlateProvider, MockSupplierProvider } from './mock-providers'
import type { CatalogProvider, PlateProvider, SupplierProvider } from './providers'
import { selectTiers } from './tiering'

/**
 * Сервис подбора: связывает провайдер каталога, провайдер поставщиков и
 * логику тиров. Провайдеры внедряются, поэтому переход с мока на реальные
 * API (Laximo, TecDoc, ABCP/Emex) не затрагивает маршруты и контракты.
 */
export class CatalogService {
  constructor(
    private readonly catalog: CatalogProvider,
    private readonly suppliers: SupplierProvider,
    private readonly plates: PlateProvider,
  ) {}

  async decodeVin(vin: string): Promise<DecodeVinResponse> {
    const vehicle = await this.catalog.decodeVin(vin)
    if (!vehicle) {
      throw new AppError(404, 'NOT_FOUND', 'Автомобиль по этому VIN не найден')
    }
    return { vehicle }
  }

  async resolvePlate(plate: string): Promise<ResolvePlateResponse> {
    const vin = await this.plates.resolvePlate(plate)
    if (!vin) {
      throw new AppError(404, 'NOT_FOUND', 'Автомобиль по этому госномеру не найден')
    }
    return this.decodeVin(vin)
  }

  async searchParts(vin: string, query: string): Promise<SearchPartsResponse> {
    const { vehicle } = await this.decodeVin(vin)
    const parts = await this.catalog.searchParts(vehicle, query)
    return { vehicle, parts }
  }

  async getOffers(oemNumber: string, region?: string): Promise<OffersResponse> {
    const offers = await this.suppliers.getOffers(oemNumber, region)
    const sorted = [...offers].sort((a, b) => a.price.amount - b.price.amount)
    return {
      oemNumber: oemNumber.trim().toUpperCase(),
      picks: selectTiers(sorted),
      offers: sorted,
    }
  }
}

/** Сервис на мок-провайдерах (используется ботом и тестами). */
export function createMockCatalogService(): CatalogService {
  return new CatalogService(
    new MockCatalogProvider(),
    new MockSupplierProvider(),
    new MockPlateProvider(),
  )
}
