import type { DealerPrice } from '@web-app-demo/contracts'

import type { DealerPriceProvider } from './providers'

/**
 * Кэш цены у дилера по номеру.
 *
 * Зачем: у 17vin цена дилера (оп. 4006) списывает баланс за КАЖДЫЙ вызов,
 * включая повтор того же номера, — их собственный трёхмесячный кэш по VIN на неё
 * не действует. А мастер открывает одну деталь по нескольку раз: выбрал,
 * вернулся к списку, открыл снова. Дилерские цены меняются редко, сутки
 * устаревания здесь ничего не портят.
 *
 * «Цены нет» кэшируется так же, как цена: это тоже оплаченный ответ.
 *
 * In-memory на процесс, как и снимок предложений (`CachingSupplierProvider`):
 * у API и бота кэши свои, после рестарта первый запрос номера платный снова.
 * Часы инъектируются для тестов.
 */
export class CachingDealerPriceProvider implements DealerPriceProvider {
  private readonly cache = new Map<string, { price: DealerPrice | null; expiresAt: number }>()

  constructor(
    private readonly inner: DealerPriceProvider,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async dealerPrice(oemNumber: string): Promise<DealerPrice | null> {
    const key = oemNumber.replace(/[\s-]/g, '').toUpperCase()
    const cached = this.cache.get(key)
    if (cached && cached.expiresAt > this.now()) return cached.price

    const price = await this.inner.dealerPrice(oemNumber)
    this.cache.set(key, { price, expiresAt: this.now() + this.ttlMs })
    return price
  }
}
