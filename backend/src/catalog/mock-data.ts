import type { PartQuality } from '@web-app-demo/contracts'

/**
 * Демо-данные для Этапа 1. Заменяются реальными провайдерами без изменения
 * контрактов и маршрутов. Цены/наличие генерируются детерминированно от
 * OEM-номера, чтобы выдача была стабильной между запросами.
 */

export type KnownVehicle = {
  make: string
  model: string
  year: number
  engine: string
  bodyType: string
}

/** Несколько узнаваемых VIN для демонстрации. */
export const KNOWN_VEHICLES: Record<string, KnownVehicle> = {
  WVWZZZ1JZ3W386752: {
    make: 'Volkswagen',
    model: 'Golf IV',
    year: 2003,
    engine: '1.6 MPI (BFQ)',
    bodyType: 'Хэтчбек',
  },
  XTA210990Y2293564: {
    make: 'LADA (ВАЗ)',
    model: '2109',
    year: 2000,
    engine: '1.5 (21083)',
    bodyType: 'Хэтчбек',
  },
  JTDBR32E430123456: {
    make: 'Toyota',
    model: 'Corolla E120',
    year: 2003,
    engine: '1.6 VVT-i (3ZZ-FE)',
    bodyType: 'Седан',
  },
}

/** Демо-госномера (кириллица) → VIN. Реальный реестр подключается позже. */
export const KNOWN_PLATES: Record<string, string> = {
  А123ВС777: 'WVWZZZ1JZ3W386752',
  О001АА199: 'XTA210990Y2293564',
  Е777КХ797: 'JTDBR32E430123456',
}

/** Сопоставление кода WMI (первые 3 символа VIN) с маркой — для неизвестных VIN. */
const WMI_TO_MAKE: Record<string, string> = {
  WVW: 'Volkswagen',
  WAU: 'Audi',
  WBA: 'BMW',
  WDB: 'Mercedes-Benz',
  XTA: 'LADA (ВАЗ)',
  JTD: 'Toyota',
  JHM: 'Honda',
  KMH: 'Hyundai',
  KNA: 'KIA',
  VF1: 'Renault',
  Z8N: 'Nissan',
}

export function makeFromVin(vin: string): string {
  return WMI_TO_MAKE[vin.slice(0, 3)] ?? 'Неизвестный производитель'
}

export type CatalogPart = {
  oemNumber: string
  name: string
  category: string
  /** Ключевые слова для поиска (нижний регистр). */
  keywords: string[]
}

/** Демо-каталог распространённых запчастей. Поиск идёт по keywords. */
export const CATALOG_PARTS: CatalogPart[] = [
  {
    oemNumber: '1J0698151',
    name: 'Колодки тормозные передние, комплект',
    category: 'Тормозная система',
    keywords: ['колодки', 'тормозные', 'тормоз', 'передние', 'brake', 'pads'],
  },
  {
    oemNumber: '1K0615301AA',
    name: 'Диск тормозной передний',
    category: 'Тормозная система',
    keywords: ['диск', 'тормозной', 'тормоз', 'передний', 'brake', 'disc'],
  },
  {
    oemNumber: '06A115561B',
    name: 'Фильтр масляный',
    category: 'Двигатель',
    keywords: ['фильтр', 'масляный', 'масло', 'oil', 'filter'],
  },
  {
    oemNumber: '1J0129620',
    name: 'Фильтр воздушный',
    category: 'Двигатель',
    keywords: ['фильтр', 'воздушный', 'воздух', 'air', 'filter'],
  },
  {
    oemNumber: '6Q0698107',
    name: 'Амортизатор передний',
    category: 'Подвеска',
    keywords: ['амортизатор', 'стойка', 'подвеска', 'передний', 'shock', 'absorber'],
  },
  {
    oemNumber: '04E905611',
    name: 'Свеча зажигания',
    category: 'Система зажигания',
    keywords: ['свеча', 'зажигания', 'свечи', 'spark', 'plug'],
  },
  {
    oemNumber: 'G052167M4',
    name: 'Масло моторное 5W-40, 1 л',
    category: 'Технические жидкости',
    keywords: ['масло', 'моторное', 'oil', '5w-40', '5w40'],
  },
]

export type MockBrand = {
  brand: string
  quality: PartQuality
  /** Множитель цены относительно базовой стоимости детали. */
  priceFactor: number
  supplierName: string
}

/**
 * Бренды по классам качества. Один OEM-бренд помечается как оригинал отдельно
 * в провайдере. Множители цены задают реалистичный разброс.
 */
export const MOCK_BRANDS: MockBrand[] = [
  { brand: 'Patron', quality: 'BUDGET', priceFactor: 0.55, supplierName: 'Армтек' },
  { brand: 'StartVolt', quality: 'BUDGET', priceFactor: 0.6, supplierName: 'РОССКО' },
  { brand: 'Fenox', quality: 'BUDGET', priceFactor: 0.68, supplierName: 'Берг' },
  { brand: 'TRW', quality: 'AFTERMARKET', priceFactor: 0.85, supplierName: 'Emex' },
  { brand: 'Febi Bilstein', quality: 'AFTERMARKET', priceFactor: 0.92, supplierName: 'Autodoc' },
  { brand: 'Valeo', quality: 'AFTERMARKET', priceFactor: 0.98, supplierName: 'ABCP' },
  { brand: 'Bosch', quality: 'PREMIUM', priceFactor: 1.25, supplierName: 'Emex' },
  { brand: 'Sachs', quality: 'PREMIUM', priceFactor: 1.4, supplierName: 'Берг' },
  { brand: 'Brembo', quality: 'PREMIUM', priceFactor: 1.55, supplierName: 'ABCP' },
]

/** Бренд оригинала (заглушка; в реальности — марка автомобиля). */
export const ORIGINAL_BRAND = { brand: 'OEM (оригинал)', supplierName: 'Официальный дилер' }
