import type { Offer } from '@web-app-demo/contracts'

import type { SupplierProvider } from './providers'

/**
 * Объединение нескольких поставщиков за одним запросом предложений — сравнение
 * цен из разных источников (ABCP + Emex + …). В отличие от каталогов
 * (`FallbackCatalogProvider`: первый опознавший VIN выигрывает), поставщики
 * опрашиваются ВСЕ параллельно, а выдачи сливаются: одна и та же деталь у
 * разных поставщиков за разную цену — это и есть ценность для СТО, дублей
 * здесь нет. Уникальность offer.id обеспечивают сами адаптеры префиксом
 * (`ABCP-…`, `EMEX-…`) — на нём держится резолв корзины из снимка.
 *
 * Семантика ошибок: упавший источник не валит сравнение — возвращаем то, что
 * собрали (деградация вместо отказа), сбой в лог. Но если НИ ОДИН источник не
 * ответил и были сбои — пробрасываем первый сбой, чтобы отказ upstream не
 * замаскировался под «предложений нет» (пустой список).
 */

export type NamedSupplierProvider = { name: string; provider: SupplierProvider }

export class MergingSupplierProvider implements SupplierProvider {
  private readonly providers: NamedSupplierProvider[]

  constructor(providers: NamedSupplierProvider[]) {
    if (providers.length === 0) {
      throw new Error('MergingSupplierProvider требует хотя бы один источник')
    }
    this.providers = providers
  }

  async getOffers(oemNumber: string, region?: string): Promise<Offer[]> {
    const results = await Promise.allSettled(
      this.providers.map(({ provider }) => provider.getOffers(oemNumber, region)),
    )

    const offers: Offer[] = []
    let firstError: unknown = null

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        offers.push(...result.value)
        return
      }
      const name = this.providers[index]!.name
      console.error(`[suppliers:${name}] getOffers упал, продолжаем с остальными`, result.reason)
      firstError ??= result.reason
    })

    // Совсем пусто И были сбои → не выдаём отказ upstream за «предложений нет».
    if (offers.length === 0 && firstError !== null) throw firstError
    return offers
  }
}
