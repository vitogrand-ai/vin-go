/**
 * История поиска в localStorage: последние запросы (VIN/госномер + запчасть),
 * чтобы не вводить 17-значный VIN заново. Хранится только на устройстве.
 */
export type SearchHistoryEntry = {
  mode: 'vin' | 'plate'
  /** VIN или госномер, как ввёл пользователь. */
  value: string
  query: string
}

const KEY = 'vin-go:search-history'
const MAX = 6

function isEntry(value: unknown): value is SearchHistoryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    (entry.mode === 'vin' || entry.mode === 'plate') &&
    typeof entry.value === 'string' &&
    typeof entry.query === 'string'
  )
}

export function readSearchHistory(): SearchHistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEntry).slice(0, MAX)
  } catch {
    return []
  }
}

/** Добавляет запись в начало истории (дедуп по mode+value+query), возвращает новый список. */
export function pushSearchHistory(entry: SearchHistoryEntry): SearchHistoryEntry[] {
  const value = entry.value.trim()
  const query = entry.query.trim()
  if (!value || !query) return readSearchHistory()

  const normalized: SearchHistoryEntry = { mode: entry.mode, value, query }
  const rest = readSearchHistory().filter(
    (item) =>
      !(item.mode === normalized.mode && item.value === value && item.query === query),
  )
  const next = [normalized, ...rest].slice(0, MAX)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // localStorage может быть недоступен (приватный режим) — история не критична.
  }
  return next
}
