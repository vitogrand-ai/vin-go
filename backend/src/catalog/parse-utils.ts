/**
 * Защитные хелперы разбора ответов внешних API (acat, ABCP, PartsIndex, …).
 * Толерантны к формату: несколько возможных имён поля, отсутствующее/иного типа
 * значение не роняет разбор. Общие для всех адаптеров провайдеров.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Первое непустое строковое/числовое значение по списку возможных имён поля. */
export function str(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const raw = obj[key]
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  }
  return null
}

/** Первое целое значение по списку возможных имён поля. */
export function int(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const raw = obj[key]
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  return null
}

/** Первое дробное значение (напр. цена в рублях). Терпит запятую-разделитель. */
export function num(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const raw = obj[key]
    const n =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string'
          ? Number.parseFloat(raw.replace(',', '.'))
          : Number.NaN
    if (Number.isFinite(n)) return n
  }
  return null
}

/** Первое булево значение. Терпит 1/0 и "true"/"false"/"yes"/"no". */
export function bool(obj: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const raw = obj[key]
    if (typeof raw === 'boolean') return raw
    if (typeof raw === 'number') return raw !== 0
    if (typeof raw === 'string') {
      const v = raw.trim().toLowerCase()
      if (v === 'true' || v === '1' || v === 'yes') return true
      if (v === 'false' || v === '0' || v === 'no' || v === '') return false
    }
  }
  return null
}

export function asArray(value: unknown): Record<string, unknown>[] | null {
  return Array.isArray(value) ? value.filter(isRecord) : null
}

export function firstRecord(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const value = obj[key]
    if (isRecord(value)) return value
  }
  return null
}

export function firstArray(data: unknown, keys: string[]): Record<string, unknown>[] | null {
  if (!isRecord(data)) return null
  for (const key of keys) {
    const arr = asArray(data[key])
    if (arr) return arr
  }
  return null
}
