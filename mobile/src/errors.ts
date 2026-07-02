import { ApiRequestError } from './api'

export function describeApiError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401) return 'Сессия истекла. Войдите снова.'
    if (error.status === 404) return error.message || 'Не найдено.'
    if (error.status === 400 || error.status === 422) return error.message || 'Проверьте данные.'
    return error.message
  }
  return 'Не удалось выполнить запрос. Проверьте сеть и адрес API.'
}
