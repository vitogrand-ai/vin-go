import { AppError } from '../http/errors'
import { safeUrl } from './provider-http'

/**
 * Прокси картинок схем узлов для браузера и мобильного.
 *
 * Зачем: 17vin отдаёт схемы только по HTTP (`resource.17vin.com`; HTTPS-зеркало
 * из документации лежит), а браузер на HTTPS-странице такую картинку
 * блокирует как mixed content — мастер увидит пустую рамку вместо схемы. iOS
 * запрещает HTTP-картинки по умолчанию. CDN parts-catalogs не отдаёт файл
 * серверам Telegram, но нам отдаёт. Поэтому картинка идёт через наш адрес:
 * клиент просит `GET /api/catalog/image?src=<url>`, бэкенд скачивает у
 * каталога и отдаёт как есть.
 *
 * Открытый прокси — приглашение гонять через сервер чужие файлы, поэтому
 * разрешены только хосты каталогов, только картинки и только до 10 МБ.
 * Телеграм-бот этим не пользуется: он качает картинку сам (`telegram.ts`).
 */

/** Хосты картинок подключённых каталогов — единственные, куда ходит прокси. */
export const SCHEME_IMAGE_HOSTS: ReadonlySet<string> = new Set([
  'resource.17vin.com', // 17vin, оп. 2004: /img/{epc}/{файл}
  'images.17vin.com', // HTTPS-зеркало 17vin из документации (на сент. 2026 лежит)
  'ru.img.parts-catalogs.com', // parts-catalogs, CDN схем
  'img.parts-catalogs.com',
])

/** Схемы узлов — десятки килобайт; больше — не схема. */
export const SCHEME_IMAGE_MAX_BYTES = 10 * 1024 * 1024

/** CDN каталога может подвиснуть — не держим соединение браузера дольше. */
export const SCHEME_IMAGE_TIMEOUT_MS = 15_000

/**
 * Адрес картинки, если его можно проксировать: http/https и хост из списка.
 * Всё остальное — `null`: чужой хост, схема `file:`, мусор.
 */
export function parseSchemeImageUrl(raw: string): URL | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!SCHEME_IMAGE_HOSTS.has(url.hostname.toLowerCase())) return null
  if (url.username || url.password) return null
  return url
}

export type SchemeImage = { bytes: ArrayBuffer; contentType: string }

/**
 * Скачивает картинку у каталога. 404 у каталога — 404 у нас (схемы нет);
 * любой другой отказ — 502: это сбой источника, а не наш.
 */
export async function fetchSchemeImage(
  url: URL,
  fetchImpl: typeof fetch = fetch,
): Promise<SchemeImage> {
  let response: Response
  try {
    response = await fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(SCHEME_IMAGE_TIMEOUT_MS),
      headers: { Accept: 'image/*' },
    })
  } catch (error) {
    console.warn('[scheme-image] картинка не скачана', safeUrl(url.toString()), error)
    throw new AppError(502, 'INTERNAL_ERROR', 'Каталог не отдал схему')
  }

  if (response.status === 404) throw new AppError(404, 'NOT_FOUND', 'Схема не найдена')
  if (!response.ok) {
    console.warn('[scheme-image] неуспешный ответ', safeUrl(url.toString()), response.status)
    throw new AppError(502, 'INTERNAL_ERROR', `Каталог не отдал схему (HTTP ${response.status})`)
  }

  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > SCHEME_IMAGE_MAX_BYTES) {
    throw new AppError(502, 'INTERNAL_ERROR', 'Файл схемы больше допустимого')
  }

  const bytes = await response.arrayBuffer()
  if (bytes.byteLength === 0) throw new AppError(502, 'INTERNAL_ERROR', 'Каталог отдал пустую схему')
  if (bytes.byteLength > SCHEME_IMAGE_MAX_BYTES) {
    throw new AppError(502, 'INTERNAL_ERROR', 'Файл схемы больше допустимого')
  }

  // Картинку узнаём по первым байтам, а не по заголовку: 17vin отдаёт схемы
  // как `application/octet-stream` (живьём, сент 2026), и проверка заголовка
  // отбрасывала их все. Сигнатура строже заголовка и в обратную сторону —
  // страница ошибки с кодом 200 и `image/png` в заголовке тоже не пройдёт.
  const contentType = sniffImageType(new Uint8Array(bytes))
  if (!contentType) {
    throw new AppError(502, 'INTERNAL_ERROR', 'Каталог вместо схемы отдал не картинку')
  }
  return { bytes, contentType }
}

/** Тип картинки по сигнатуре файла; не картинка — `null`. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const matches = (offset: number, ...signature: number[]): boolean =>
    signature.every((byte, index) => bytes[offset + index] === byte)

  if (matches(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (matches(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (matches(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (matches(0, 0x52, 0x49, 0x46, 0x46) && matches(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  return null
}
