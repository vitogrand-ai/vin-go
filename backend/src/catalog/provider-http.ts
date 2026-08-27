import { AppError } from '../http/errors'

/** Потолок ожидания ответа провайдера: зависший upstream не должен вешать запрос пользователя. */
export const PROVIDER_TIMEOUT_MS = 5_000

/**
 * Общий HTTP-вызов к внешнему провайдеру данных (acat, ABCP, PartsIndex, …).
 *
 * Возвращает распарсенный JSON, либо `null` если сущность не найдена (HTTP 404
 * или пустое тело) — это штатный «нет результата», НЕ ошибка. Любой другой сбой
 * (сеть, таймаут, 5xx, битый JSON) — отказ вышестоящего сервиса: бросается
 * AppError(502) с названием провайдера, чтобы падение upstream НЕ замаскировалось
 * под «не найдено» (404/пустой список) на уровне сервиса.
 *
 * Различия провайдеров (авторизация, query-параметры) остаются в самих
 * адаптерах: сюда передаётся уже готовый url и заголовки.
 */
export async function requestProviderJson(opts: {
  /** Человекочитаемое имя провайдера — в сообщение ошибки и лог. */
  provider: string
  url: string
  fetchImpl: typeof fetch
  headers?: Record<string, string>
  /** HTTP-метод (по умолчанию GET). POST — для провайдеров с form-запросами (VINqu). */
  method?: 'GET' | 'POST'
  /** Тело запроса для POST (FormData/URLSearchParams сами проставляют Content-Type). */
  body?: BodyInit
  /** Таймаут ответа, мс (по умолчанию PROVIDER_TIMEOUT_MS). */
  timeoutMs?: number
}): Promise<unknown | null> {
  const { provider, url, fetchImpl, headers, method, body } = opts
  const timeoutMs = opts.timeoutMs ?? PROVIDER_TIMEOUT_MS

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: method ?? 'GET',
      body,
      headers: { Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (cause) {
    if (isTimeout(cause)) {
      console.error(`[${provider}] таймаут запроса (${timeoutMs} мс)`, url)
      throw unavailable(provider, `нет ответа за ${timeoutMs} мс`)
    }
    console.error(`[${provider}] сетевой сбой запроса`, url, cause)
    throw unavailable(provider, 'сеть недоступна')
  }

  // «Не найдено» — штатный пустой результат, а не ошибка провайдера.
  if (response.status === 404) return null

  if (!response.ok) {
    console.error(`[${provider}] неуспешный ответ`, url, response.status)
    throw unavailable(provider, `HTTP ${response.status}`)
  }

  // Чтение тела — под тем же таймаут-сигналом: AbortSignal может сработать уже
  // после получения заголовков, во время стриминга тела (большие ответы,
  // медленный канал) — это тоже отказ провайдера, а не наш баг (500).
  let text: string
  try {
    text = await response.text()
  } catch (cause) {
    if (isTimeout(cause)) {
      console.error(`[${provider}] таймаут чтения ответа (${timeoutMs} мс)`, url)
      throw unavailable(provider, `тело ответа не дочитано за ${timeoutMs} мс`)
    }
    console.error(`[${provider}] обрыв чтения ответа`, url, cause)
    throw unavailable(provider, 'обрыв при чтении ответа')
  }
  if (!text.trim()) return null

  try {
    return JSON.parse(text) as unknown
  } catch (cause) {
    console.error(`[${provider}] некорректный JSON`, url, cause)
    throw unavailable(provider, 'некорректный JSON в ответе')
  }
}

/** 502: отказ вышестоящего сервиса — отделяем от «не найдено» (404) и багов (500). */
function unavailable(provider: string, reason: string): AppError {
  return new AppError(502, 'INTERNAL_ERROR', `Провайдер ${provider} недоступен (${reason})`)
}

/**
 * Прерывание по AbortSignal.timeout приходит как DOMException TimeoutError (или
 * AbortError). DOMException не во всех рантаймах наследует Error, поэтому
 * проверяем по name, а не по instanceof.
 */
function isTimeout(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false
  const name = (cause as { name?: unknown }).name
  return name === 'TimeoutError' || name === 'AbortError'
}
