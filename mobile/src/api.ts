import type { z } from 'zod'

import {
  apiErrorSchema,
  authResponseSchema,
  cartResponseSchema,
  createPaymentResponseSchema,
  garageResponseSchema,
  meResponseSchema,
  offersResponseSchema,
  orderResponseSchema,
  ordersResponseSchema,
  refreshResponseSchema,
  resolvePlateResponseSchema,
  searchPartsResponseSchema,
  vehicleResponseSchema,
  type AuthResponse,
  type CartResponse,
  type CreatePaymentResponse,
  type GarageResponse,
  type OffersResponse,
  type OrderResponse,
  type OrdersResponse,
  type ResolvePlateResponse,
  type SearchPartsResponse,
  type VehicleResponse,
} from './contracts'

// Телефону нужен LAN-IP машины, а не localhost. Задайте EXPO_PUBLIC_API_URL.
const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000').replace(/\/$/, '')

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST'
  body?: unknown
  auth?: boolean
}

/**
 * Хуки жизненного цикла сессии. ApiClient сам обновляет access-токен по 401
 * (см. rawRequest); auth.tsx поставляет доступ к refresh-токену и реакцию на
 * протухшую сессию.
 */
export type SessionHooks = {
  loadRefreshToken: () => Promise<string | null>
  persistRefreshToken: (token: string | null) => Promise<void>
  onSessionExpired: () => void
}

/** Клиент бэкенда. Заголовок mobile-платформы → refresh-токен приходит в теле. */
export class ApiClient {
  private accessToken: string | null = null
  private sessionHooks: SessionHooks | null = null
  private refreshInFlight: Promise<boolean> | null = null

  setAccessToken(token: string | null) {
    this.accessToken = token
  }

  /** auth.tsx регистрирует хуки один раз при старте провайдера. */
  setSessionHooks(hooks: SessionHooks | null) {
    this.sessionHooks = hooks
  }

  getAccessToken(): string | null {
    return this.accessToken
  }

  login(input: { email: string; password: string }): Promise<AuthResponse> {
    return this.request('/api/auth/login', authResponseSchema, { method: 'POST', body: input })
  }

  register(input: { email: string; password: string }): Promise<AuthResponse> {
    return this.request('/api/auth/register', authResponseSchema, { method: 'POST', body: input })
  }

  refresh(refreshToken: string) {
    return this.request('/api/auth/refresh', refreshResponseSchema, {
      method: 'POST',
      body: { refreshToken },
    })
  }

  me() {
    return this.request('/api/auth/me', meResponseSchema, { auth: true })
  }

  async logout(refreshToken: string | null) {
    await this.rawRequest('/api/auth/logout', {
      method: 'POST',
      body: { refreshToken: refreshToken ?? undefined },
    }).catch(() => undefined)
  }

  resolvePlate(input: { plate: string }): Promise<ResolvePlateResponse> {
    return this.request('/api/catalog/resolve-plate', resolvePlateResponseSchema, {
      method: 'POST',
      body: input,
    })
  }

  searchParts(input: { vin: string; query: string }): Promise<SearchPartsResponse> {
    return this.request('/api/catalog/search', searchPartsResponseSchema, {
      method: 'POST',
      body: input,
    })
  }

  offers(input: { oemNumber: string }): Promise<OffersResponse> {
    return this.request('/api/catalog/offers', offersResponseSchema, {
      method: 'POST',
      body: input,
    })
  }

  // --- Кабинет (требует авторизации) ---

  listVehicles(): Promise<GarageResponse> {
    return this.request('/api/vehicles', garageResponseSchema, { auth: true })
  }

  addVehicle(input: { vin: string; nickname?: string }): Promise<VehicleResponse> {
    return this.request('/api/vehicles', vehicleResponseSchema, {
      method: 'POST',
      body: input,
      auth: true,
    })
  }

  async removeVehicle(id: string): Promise<void> {
    await this.rawRequest('/api/vehicles/remove', { method: 'POST', body: { id }, auth: true })
  }

  getCart(): Promise<CartResponse> {
    return this.request('/api/cart', cartResponseSchema, { auth: true })
  }

  addCartItem(input: {
    oemNumber: string
    offerId: string
    partName: string
    tier?: string
    vehicleVin?: string
  }): Promise<OrderResponse> {
    return this.request('/api/cart/items', orderResponseSchema, {
      method: 'POST',
      body: input,
      auth: true,
    })
  }

  updateCartItem(input: { itemId: string; quantity: number }): Promise<OrderResponse> {
    return this.request('/api/cart/items/quantity', orderResponseSchema, {
      method: 'POST',
      body: input,
      auth: true,
    })
  }

  removeCartItem(itemId: string): Promise<OrderResponse> {
    return this.request('/api/cart/items/remove', orderResponseSchema, {
      method: 'POST',
      body: { itemId },
      auth: true,
    })
  }

  checkout(): Promise<OrderResponse> {
    return this.request('/api/cart/checkout', orderResponseSchema, { method: 'POST', auth: true })
  }

  listOrders(): Promise<OrdersResponse> {
    return this.request('/api/orders', ordersResponseSchema, { auth: true })
  }

  createPayment(orderId: string, method?: 'card' | 'sbp'): Promise<CreatePaymentResponse> {
    return this.request('/api/payments/create', createPaymentResponseSchema, {
      method: 'POST',
      body: { orderId, method },
      auth: true,
    })
  }

  async registerDevice(token: string, platform?: 'ios' | 'android'): Promise<void> {
    await this.rawRequest('/api/devices/register', {
      method: 'POST',
      body: { token, platform },
      auth: true,
    })
  }

  async unregisterDevice(token: string): Promise<void> {
    await this.rawRequest('/api/devices/unregister', {
      method: 'POST',
      body: { token },
      auth: true,
    })
  }

  private async request<TSchema extends z.ZodTypeAny>(
    path: string,
    schema: TSchema,
    options: RequestOptions,
  ): Promise<z.infer<TSchema>> {
    const response = await this.rawRequest(path, options)
    return schema.parse(await response.json())
  }

  private async rawRequest(
    path: string,
    options: RequestOptions,
    allowRefresh = true,
  ): Promise<Response> {
    const headers: Record<string, string> = { 'X-Client-Platform': 'mobile' }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    if (options.auth && this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`

    const response = await fetch(`${API_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })

    // Access-токен живёт минуты: по 401 на авторизованном запросе один раз
    // прозрачно обновляем токен и повторяем запрос.
    if (response.status === 401 && options.auth && allowRefresh && this.sessionHooks) {
      if (await this.ensureRefreshed()) {
        return this.rawRequest(path, options, false)
      }
    }

    if (!response.ok) {
      throw await toApiError(response)
    }
    return response
  }

  /** Один общий refresh на все параллельные 401 — иначе гонки ротации токена. */
  private ensureRefreshed(): Promise<boolean> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.doRefresh().finally(() => {
        this.refreshInFlight = null
      })
    }
    return this.refreshInFlight
  }

  private async doRefresh(): Promise<boolean> {
    const hooks = this.sessionHooks
    if (!hooks) return false
    try {
      const refreshToken = await hooks.loadRefreshToken()
      if (!refreshToken) throw new Error('нет refresh-токена')
      const refreshed = await this.refresh(refreshToken)
      this.accessToken = refreshed.accessToken
      if (refreshed.refreshToken) await hooks.persistRefreshToken(refreshed.refreshToken)
      return true
    } catch {
      // Refresh протух/отозван — гасим сессию, вызывающий получит исходный 401.
      this.accessToken = null
      await hooks.persistRefreshToken(null)
      hooks.onSessionExpired()
      return false
    }
  }
}

async function toApiError(response: Response): Promise<ApiRequestError> {
  try {
    const parsed = apiErrorSchema.parse(await response.json())
    return new ApiRequestError(response.status, parsed.error.code, parsed.error.message)
  } catch {
    return new ApiRequestError(response.status, 'INTERNAL_ERROR', `Ошибка запроса (${response.status})`)
  }
}
