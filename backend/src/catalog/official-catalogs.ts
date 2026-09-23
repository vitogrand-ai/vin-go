/**
 * Официальные бесплатные каталоги заводов для марок, которых нет НИ В ОДНОМ
 * подключённом каталоге с поиском по VIN (сверка от 23.09.2026 — таблица
 * вендора parts-catalogs и docs/FREE_CATALOGS.md, раздел «Заводы РФ»).
 *
 * Мастеру с УАЗом бот раньше отвечал «проверьте VIN» — как будто тот ошибся в
 * номере. Настоящая причина — ограничение каталогов, и у завода при этом есть
 * официальный каталог. Марку узнаём без каталога — по WMI (первые 3 символа
 * VIN закреплены за производителем в ISO 3780), поэтому подсказка работает
 * именно тогда, когда все источники ответили «не найдено».
 *
 * Ссылки ТОЛЬКО на заводы и их официальных поставщиков: на серые и пиратские
 * ресурсы бот не ссылается (см. docs/FREE_CATALOGS.md).
 */

export type OfficialCatalog = {
  /** Марка по-русски — для текста ответа. */
  brand: string
  url: string
  /** Что мастер найдёт по ссылке (поиска по VIN там нет — сказать честно). */
  note: string
}

/** WMI (первые 3 символа VIN) → официальный каталог завода. */
const OFFICIAL_CATALOGS: Record<string, OfficialCatalog> = {
  // УАЗ, Ульяновск.
  XTT: {
    brand: 'УАЗ',
    url: 'https://www.uaz.ru/uploads/docs/parts-and-accessories/supplies-catalog.pdf',
    note: 'заводской PDF-каталог запчастей (без поиска по VIN)',
  },
  // АвтоВАЗ, Тольятти.
  XTA: {
    brand: 'LADA',
    url: 'https://www.lada-image.ru/products/catalog/',
    note: 'каталог по узлам от официального поставщика запчастей LADA (без поиска по VIN)',
  },
  // КАМАЗ, Набережные Челны.
  XTC: {
    brand: 'КАМАЗ',
    url: 'https://shop.kamaz.ru/',
    note: 'официальный магазин завода с каталогом по узлам (без поиска по VIN)',
  },
}

/**
 * Официальный каталог завода по VIN или null: марка не из списка, либо это
 * frame-номер (JDM), у которого WMI нет.
 */
export function officialCatalogForVin(vinOrFrame: string): OfficialCatalog | null {
  const vin = vinOrFrame.trim().toUpperCase()
  if (vin.length !== 17 || vin.includes('-')) return null
  return OFFICIAL_CATALOGS[vin.slice(0, 3)] ?? null
}
