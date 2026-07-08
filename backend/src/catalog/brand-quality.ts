import type { PartQuality } from '@web-app-demo/contracts'

/**
 * Справочник бренд → класс качества. Основа честных тиров (Эконом/Оптимальный/
 * Оригинал): `tiering.ts` берёт `quality` для веса «цена/качество», а бренды
 * автопроизводителей помечают предложение как оригинал.
 *
 * Классы (`PartQuality`):
 *   • OEM        — оригинал автопроизводителя / завод-изготовитель на конвейер;
 *   • PREMIUM    — топовый афтемаркет и OES-поставщики (Bosch, Brembo, ZF…);
 *   • AFTERMARKET— крепкий средний сегмент (Febi, Blue Print, Meyle…);
 *   • BUDGET     — эконом (Patron, StartVolt, LYNXauto…).
 *
 * ⚠️ Это КУРИРУЕМАЯ рыночная классификация, а не эталон. Позиционирование брендов
 * спорно и меняется — список правится под свой ассортимент. Неизвестный бренд →
 * AFTERMARKET (нейтральная середина, тиры не ломает). Для максимальной точности
 * позже можно заменить на справочник из TecDoc.
 *
 * Сопоставление регистронезависимо и терпит разделители (`Mann-Filter` =
 * `mann filter`). Разные написания одного бренда добавляй явными алиасами.
 */

/** Бренды автопроизводителей: и класс OEM, и признак «оригинал». */
const OEM_BRANDS = [
  // Европа
  'Volkswagen', 'VW', 'Audi', 'Skoda', 'Seat', 'BMW', 'Mini', 'Mercedes-Benz', 'Mercedes',
  'Opel', 'Ford', 'Renault', 'Dacia', 'Peugeot', 'Citroen', 'Fiat', 'Alfa Romeo', 'Volvo',
  'Porsche', 'Land Rover', 'Jaguar',
  // Азия
  'Toyota', 'Lexus', 'Nissan', 'Infiniti', 'Datsun', 'Honda', 'Acura', 'Mazda', 'Mitsubishi',
  'Subaru', 'Suzuki', 'Daihatsu', 'Hyundai', 'Kia', 'Genesis', 'Daewoo', 'SsangYong',
  // Америка
  'Chevrolet', 'Cadillac', 'GMC', 'Chrysler', 'Dodge', 'Jeep',
  // Россия / СНГ
  'LADA', 'ВАЗ', 'Лада', 'GAZ', 'ГАЗ', 'UAZ', 'УАЗ', 'KAMAZ', 'КАМАЗ', 'Moskvich', 'Москвич',
  // Китай
  'Chery', 'Haval', 'Great Wall', 'Geely', 'Changan', 'Exeed', 'Omoda', 'Jaecoo', 'Jetour',
  'Tank', 'Lixiang', 'Li Auto', 'Zeekr', 'Evolute', 'Belgee', 'Dongfeng', 'Foton', 'FAW',
  'JAC', 'BYD', 'Voyah', 'Hongqi', 'GAC', 'BAIC', 'Livan', 'Kaiyi', 'Soueast', 'Jetta',
]

/** Топовый афтемаркет и OES-поставщики конвейера. */
const PREMIUM_BRANDS = [
  'Bosch', 'Brembo', 'ATE', 'Textar', 'Pagid', 'Zimmermann', 'Otto Zimmermann', 'TRW', 'Lucas',
  'Sachs', 'ZF', 'ZF Sachs', 'Bilstein', 'Lemforder', 'Lemförder', 'Koni', 'KYB', 'Kayaba',
  'Continental', 'ContiTech', 'VDO', 'Mann', 'Mann-Filter', 'Mahle', 'Knecht', 'Hengst',
  'Denso', 'Aisin', 'NGK', 'NTK', 'Beru', 'Valeo', 'LuK', 'INA', 'FAG', 'Schaeffler', 'SKF',
  'Gates', 'Koyo', 'NSK', 'NTN', 'Elring', 'Victor Reinz', 'Reinz', 'Glyco', 'Kolbenschmidt',
  'Pierburg', 'Hella', 'Behr', 'Nissens', 'Delphi', 'Magneti Marelli', 'Sidem', 'Moog',
  'Philips', 'Osram', 'Varta', 'Exide', 'Wabco', 'Eberspacher', 'Purflux', 'Champion',
]

/** Крепкий средний сегмент. */
const AFTERMARKET_BRANDS = [
  'Febi', 'Febi Bilstein', 'Swag', 'Vaico', 'Blue Print', 'Blueprint', 'Meyle', 'Monroe',
  'Ferodo', 'Roadhouse', 'Remsa', 'Icer', 'Bendix', 'Mintex', 'Nipparts', 'Japanparts',
  'Japko', 'Ashika', 'Herth+Buss', 'Jakoparts', 'Maxgear', 'Metzger', 'Topran', 'Ruville',
  'Optimal', 'Kamoka', 'Denckermann', 'Frenkit', 'Filtron', 'WIX', 'Fram', 'Sakura', 'Alco',
  'Bosal', 'Walker', 'Sidat', 'Facet', 'Era', 'Cargo', 'Autlog', 'NK', 'A.B.S.', 'Mapco',
  'Quinton Hazell', 'Comline', 'First Line', 'Corteco', 'Stellox', 'Sasic', 'Ucel',
]

/** Эконом-сегмент. */
const BUDGET_BRANDS = [
  'Patron', 'StartVolt', 'СтартВОЛЬТ', 'Fenox', 'LYNXauto', 'Lynx', 'Sat', 'Sailing', 'Fitshi',
  'AMD', 'Trialli', 'TZA', 'Kraft', 'Hola', 'Pilenga', 'Miles', 'Just Drive', 'JD', 'Ween',
  'Luzar', 'Zekkert', 'Finwhale', 'Pekar', 'Riginal', 'Master', 'Cworks', 'Amiwa', 'Bapmic',
  'Dexen', 'Yuki', 'Marshall', 'Fortech', 'Hort', 'Mega Power', 'AutoStandart', 'TSN',
  'Cross', 'Wonderful', 'BigFilteR', 'Nevsky Filter', 'Salut',
]

/** Приводит бренд к каноничной форме: нижний регистр, разделители → пробел. */
function normalize(brand: string): string {
  return brand.trim().toLowerCase().replace(/[\s._-]+/g, ' ').trim()
}

const QUALITY_BY_BRAND = new Map<string, PartQuality>()
// Порядок важен: OEM пишем последним, чтобы он выиграл при случайном пересечении.
for (const brand of BUDGET_BRANDS) QUALITY_BY_BRAND.set(normalize(brand), 'BUDGET')
for (const brand of AFTERMARKET_BRANDS) QUALITY_BY_BRAND.set(normalize(brand), 'AFTERMARKET')
for (const brand of PREMIUM_BRANDS) QUALITY_BY_BRAND.set(normalize(brand), 'PREMIUM')
for (const brand of OEM_BRANDS) QUALITY_BY_BRAND.set(normalize(brand), 'OEM')

const AUTOMAKER_BRANDS = new Set(OEM_BRANDS.map(normalize))

/** Класс качества по бренду. Неизвестный бренд → AFTERMARKET. */
export function classifyQuality(brand: string): PartQuality {
  return QUALITY_BY_BRAND.get(normalize(brand)) ?? 'AFTERMARKET'
}

/**
 * true, если бренд — автопроизводитель (значит предложение оригинальное).
 * Используется как запасной признак, когда у поставщика нет явного флага.
 */
export function isOriginalBrand(brand: string): boolean {
  return AUTOMAKER_BRANDS.has(normalize(brand))
}
