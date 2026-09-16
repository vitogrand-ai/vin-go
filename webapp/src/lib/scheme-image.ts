import { apiBaseUrl } from './api'

/**
 * Адрес схемы узла для `<img src>`.
 *
 * 17vin отдаёт схемы только по HTTP; на HTTPS-странице браузер такую картинку
 * блокирует (mixed content), и мастер видит пустую рамку. Такие адреса идут
 * через прокси бэкенда (`GET /api/catalog/image`), HTTPS-схемы parts-catalogs —
 * напрямую, как раньше. Решение принимает клиент, а не API: ограничение
 * браузерное, бот и сервер работают с исходным адресом.
 */
export function schemeImageSrc(imageUrl: string): string {
  if (!imageUrl.startsWith('http://')) return imageUrl
  return `${apiBaseUrl}/api/catalog/image?src=${encodeURIComponent(imageUrl)}`
}
