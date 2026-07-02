import type { Offer } from '@web-app-demo/contracts'

import type { SupplierProvider } from './providers'

/** Резолвер предложения по id из недавней выдачи (снимок поиска). */
export interface OfferResolver {
  findOffer(offerId: string): Offer | undefined
}

/**
 * Декоратор поставщиков со снимком выдачи. На каждый getOffers (поиск)
 * запоминает предложения по их id на TTL; addItem затем резолвит выбранное
 * предложение из снимка, а не повторным getOffers.
 *
 * Зачем: у реального API id предложения между поиском и «в корзину» не совпадёт
 * (повторный запрос вернёт другой набор), поэтому поиск offer.id по свежему
 * getOffers давал бы ложное «Предложение не найдено». Снимок это чинит и заодно
 * снижает число платных запросов к поставщику. Часы инъектируются для тестов.
 *
 * Кэш in-memory на процесс: клиент ищет и добавляет в одном бэкенде (веб/мобильное
 * — через API, бот — через свой процесс), поэтому снимок виден. При горизонтальном
 * масштабировании нескольких API-инстансов потребуется общий стор (Redis/БД) —
 * осознанно отложено; на промах addItem падает на re-fetch.
 */
export class CachingSupplierProvider implements SupplierProvider, OfferResolver {
  private readonly cache = new Map<string, { offer: Offer; expiresAt: number }>()

  constructor(
    private readonly inner: SupplierProvider,
    private readonly ttlMs = 15 * 60 * 1000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async getOffers(oemNumber: string, region?: string): Promise<Offer[]> {
    const offers = await this.inner.getOffers(oemNumber, region)
    const expiresAt = this.now() + this.ttlMs
    for (const offer of offers) {
      this.cache.set(offer.id, { offer, expiresAt })
    }
    this.sweep()
    return offers
  }

  findOffer(offerId: string): Offer | undefined {
    const hit = this.cache.get(offerId)
    if (!hit) return undefined
    if (hit.expiresAt <= this.now()) {
      this.cache.delete(offerId)
      return undefined
    }
    return hit.offer
  }

  private sweep(): void {
    if (this.cache.size < 5000) return
    const t = this.now()
    for (const [id, entry] of this.cache) {
      if (entry.expiresAt <= t) this.cache.delete(id)
    }
  }
}
