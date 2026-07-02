/**
 * Проверка источника webhook по IP-диапазонам ЮKassa (defense-in-depth).
 *
 * Основная защита от подделки webhook — перепроверка статуса через API провайдера
 * в PaymentService.applyPaymentStatus. IP-allowlist — дополнительный сетевой барьер,
 * включается флагом YOOKASSA_WEBHOOK_IP_ALLOWLIST=true и осмыслен только за доверенным
 * прокси, проставляющим X-Forwarded-For (например, DigitalOcean App Platform).
 *
 * Диапазоны — по документации ЮKassa (раздел «IP-адреса ЮKassa»). Обновляйте при
 * изменении в личном кабинете провайдера.
 */

const YOOKASSA_IPV4_CIDRS = [
  '185.71.76.0/27',
  '185.71.77.0/27',
  '77.75.153.0/25',
  '77.75.156.11/32',
  '77.75.156.35/32',
  '77.75.154.128/25',
] as const

// У ЮKassa один документированный IPv6-префикс — сверяем по префиксу /32.
const YOOKASSA_IPV6_PREFIXES = ['2a02:5180:'] as const

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let acc = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    acc = (acc << 8) | n
  }
  return acc >>> 0
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split('/')
  const bits = Number(bitsRaw)
  const ipInt = ipv4ToInt(ip)
  const rangeInt = ipv4ToInt(range ?? '')
  if (ipInt === null || rangeInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false
  }
  if (bits === 0) return true
  const mask = (0xffffffff << (32 - bits)) >>> 0
  return (ipInt & mask) === (rangeInt & mask)
}

/** Разрешён ли IP как источник webhook ЮKassa. */
export function isYooKassaWebhookIp(ip: string): boolean {
  const normalized = ip.trim().toLowerCase()
  if (!normalized) return false
  // IPv4-mapped IPv6 вида ::ffff:185.71.76.5 → берём IPv4-часть.
  const v4 = normalized.startsWith('::ffff:')
    ? normalized.slice('::ffff:'.length)
    : normalized
  if (YOOKASSA_IPV4_CIDRS.some((cidr) => ipv4InCidr(v4, cidr))) return true
  return YOOKASSA_IPV6_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

/**
 * Клиентский IP из заголовков обратного прокси. Берём первый (левый) адрес
 * X-Forwarded-For — это исходный клиент; остальные добавлены прокси по пути.
 */
export function clientIpFromHeaders(
  forwardedFor: string | undefined,
  realIp?: string | undefined,
): string | null {
  const first = forwardedFor?.split(',')[0]?.trim()
  if (first) return first
  const real = realIp?.trim()
  return real || null
}
