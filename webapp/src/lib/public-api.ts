import { ApiClient } from './api'

/**
 * Публичный клиент для эндпоинтов, не требующих авторизации (каталог, подбор).
 * Авторизованные вызовы (корзина, заказы) пойдут через клиент из AuthProvider.
 */
export const publicApi = new ApiClient({
  getAccessToken: () => null,
  setAccessToken: () => undefined,
})
