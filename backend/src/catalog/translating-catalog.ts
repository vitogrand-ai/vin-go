import type { Part, Vehicle } from '@web-app-demo/contracts'

import type { CatalogTranslator } from './catalog-translator'
import type { CatalogProvider } from './providers'

/**
 * Обёртка каталога, переводящая выдачу поиска на русский. Тот же приём, что
 * `CachingSupplierProvider` у поставщиков: источник данных ничего не знает о
 * переводе, а сервис, бот и веб получают уже русские названия.
 *
 * Перевод стоит здесь, а не на фронтенде, потому что название детали
 * замораживается в позицию заказа: в корзину и историю должно попасть то же
 * самое, что человек видел в выдаче.
 */
export class TranslatingCatalogProvider implements CatalogProvider {
  constructor(
    private readonly inner: CatalogProvider,
    private readonly translator: CatalogTranslator,
  ) {}

  decodeVin(vin: string): Promise<Vehicle | null> {
    return this.inner.decodeVin(vin)
  }

  async searchParts(vehicle: Vehicle, query: string): Promise<Part[]> {
    const parts = await this.inner.searchParts(vehicle, query)
    if (parts.length === 0) return parts

    const translations = await this.translator.translate(
      parts.flatMap((part) => [part.name, part.category]),
    )
    if (translations.size === 0) return parts

    return parts.map((part) => ({
      ...part,
      name: translations.get(part.name.trim()) ?? part.name,
      category: translations.get(part.category.trim()) ?? part.category,
    }))
  }
}
