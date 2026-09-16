import type { DealerPrice, Offer, Part, Vehicle } from '@web-app-demo/contracts'

/**
 * Провайдер каталога: расшифровка VIN и поиск каталожных (OEM) номеров.
 * Сейчас реализован мок; позже сюда встают адаптеры Laximo / TecDoc.
 */
export interface CatalogProvider {
  /** Расшифровывает VIN в карточку автомобиля. Возвращает null, если VIN не найден. */
  decodeVin(vin: string): Promise<Vehicle | null>
  /** Ищет запчасти для автомобиля по текстовому запросу. */
  searchParts(vehicle: Vehicle, query: string): Promise<Part[]>
  /**
   * Все детали узла по его идентификатору (`Part.schemeId`) — без отбора по
   * запросу, с номерами позиций со схемы. Мастер смотрит на картинку и называет
   * номер: на схеме фары «9» — это жгут проводов, названия которого он не знает.
   * Метод необязательный: схемы отдаёт не каждый каталог.
   */
  schemeParts?(vehicle: Vehicle, schemeId: string): Promise<Part[]>
}

/**
 * Провайдер поставщиков: предложения по каталожному номеру.
 * Сейчас реализован мок; позже сюда встают адаптеры ABCP / Emex / Berg / Армтек.
 */
export interface SupplierProvider {
  /** Возвращает предложения по OEM-номеру для указанного региона. */
  getOffers(oemNumber: string, region?: string): Promise<Offer[]>
}

/**
 * Справочная цена оригинала у официальных дилеров по OEM-номеру. Не поставщик:
 * по этой цене не купить, она — ориентир рядом с предложениями.
 */
export interface DealerPriceProvider {
  /** Цена по номеру или null, если источник её не знает. */
  dealerPrice(oemNumber: string): Promise<DealerPrice | null>
}

/**
 * Провайдер реестра: госномер → VIN. В РФ нет бесплатного официального API,
 * поэтому сейчас мок; позже сюда встаёт платный сервис (АвтоИстория, Avtocod и т.п.).
 */
export interface PlateProvider {
  /** Возвращает VIN по госномеру или null, если не найден. */
  resolvePlate(plate: string): Promise<string | null>
}
