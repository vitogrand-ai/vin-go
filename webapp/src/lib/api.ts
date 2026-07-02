import {
  addCartItemRequestSchema,
  addVehicleRequestSchema,
  apiErrorSchema,
  authResponseSchema,
  cartResponseSchema,
  confirmMockPaymentRequestSchema,
  createPaymentRequestSchema,
  createPaymentResponseSchema,
  decodeVinRequestSchema,
  decodeVinResponseSchema,
  garageResponseSchema,
  loginRequestSchema,
  logoutRequestSchema,
  meResponseSchema,
  offersRequestSchema,
  offersResponseSchema,
  orderResponseSchema,
  ordersResponseSchema,
  refreshRequestSchema,
  refundRequestSchema,
  refundResponseSchema,
  resolvePlateRequestSchema,
  resolvePlateResponseSchema,
  refreshResponseSchema,
  registerRequestSchema,
  removeCartItemRequestSchema,
  removeVehicleRequestSchema,
  searchPartsRequestSchema,
  searchPartsResponseSchema,
  setCartVehicleRequestSchema,
  telegramLinkCodeResponseSchema,
  telegramStatusResponseSchema,
  updateCartItemRequestSchema,
  updateOrderNotesRequestSchema,
  updateOrderStatusRequestSchema,
  vehicleResponseSchema,
  type AddCartItemRequest,
  type AddVehicleRequest,
  type AuthResponse,
  type CartResponse,
  type ConfirmMockPaymentRequest,
  type CreatePaymentRequest,
  type CreatePaymentResponse,
  type DecodeVinRequest,
  type DecodeVinResponse,
  type GarageResponse,
  type LoginRequest,
  type LogoutRequest,
  type MeResponse,
  type OffersRequest,
  type OffersResponse,
  type OrderResponse,
  type OrdersResponse,
  type RefreshRequest,
  type RefreshResponse,
  type RefundRequest,
  type RefundResponse,
  type RegisterRequest,
  type RemoveCartItemRequest,
  type ResolvePlateRequest,
  type ResolvePlateResponse,
  type RemoveVehicleRequest,
  type SearchPartsRequest,
  type SearchPartsResponse,
  type SetCartVehicleRequest,
  type TelegramLinkCodeResponse,
  type TelegramStatusResponse,
  type UpdateCartItemRequest,
  type UpdateOrderNotesRequest,
  type UpdateOrderStatusRequest,
  type VehicleResponse,
} from '@web-app-demo/contracts'
import type { z } from 'zod'

const apiBaseUrl = (import.meta.env?.VITE_API_URL ?? 'http://localhost:3000').replace(/\/$/, '')

type ApiClientOptions = {
  getAccessToken: () => string | null
  setAccessToken: (accessToken: string | null) => void
  onAuthExpired?: () => void | Promise<void>
}

type RequestOptions = {
  method?: 'GET' | 'POST'
  body?: unknown
  auth?: boolean
  retryOnUnauthorized?: boolean
  accessTokenOverride?: string
}

export class ApiRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export class ApiClient {
  private readonly options: ApiClientOptions
  private refreshPromise: Promise<RefreshResponse> | null = null

  constructor(options: ApiClientOptions) {
    this.options = options
  }

  register(input: RegisterRequest): Promise<AuthResponse> {
    const payload = registerRequestSchema.parse(input)
    return this.request('/api/auth/register', authResponseSchema, {
      method: 'POST',
      body: payload,
      auth: false,
    })
  }

  login(input: LoginRequest): Promise<AuthResponse> {
    const payload = loginRequestSchema.parse(input)
    return this.request('/api/auth/login', authResponseSchema, {
      method: 'POST',
      body: payload,
      auth: false,
    })
  }

  refresh(input: RefreshRequest = {}): Promise<RefreshResponse> {
    const payload = refreshRequestSchema.parse(input)
    return this.request('/api/auth/refresh', refreshResponseSchema, {
      method: 'POST',
      body: payload,
      auth: false,
      retryOnUnauthorized: false,
    })
  }

  me(): Promise<MeResponse> {
    return this.request('/api/auth/me', meResponseSchema, {
      auth: true,
    })
  }

  decodeVin(input: DecodeVinRequest): Promise<DecodeVinResponse> {
    const payload = decodeVinRequestSchema.parse(input)
    return this.request('/api/catalog/decode-vin', decodeVinResponseSchema, {
      method: 'POST',
      body: payload,
      auth: false,
    })
  }

  resolvePlate(input: ResolvePlateRequest): Promise<ResolvePlateResponse> {
    const payload = resolvePlateRequestSchema.parse(input)
    return this.request('/api/catalog/resolve-plate', resolvePlateResponseSchema, {
      method: 'POST',
      body: payload,
      auth: false,
    })
  }

  searchParts(input: SearchPartsRequest): Promise<SearchPartsResponse> {
    const payload = searchPartsRequestSchema.parse(input)
    return this.request('/api/catalog/search', searchPartsResponseSchema, {
      method: 'POST',
      body: payload,
      auth: false,
    })
  }

  offers(input: OffersRequest): Promise<OffersResponse> {
    const payload = offersRequestSchema.parse(input)
    return this.request('/api/catalog/offers', offersResponseSchema, {
      method: 'POST',
      body: payload,
      auth: false,
    })
  }

  // --- Гараж (требует авторизации) ---

  listVehicles(): Promise<GarageResponse> {
    return this.request('/api/vehicles', garageResponseSchema, { auth: true })
  }

  addVehicle(input: AddVehicleRequest): Promise<VehicleResponse> {
    const payload = addVehicleRequestSchema.parse(input)
    return this.request('/api/vehicles', vehicleResponseSchema, {
      method: 'POST',
      body: payload,
      auth: true,
    })
  }

  async removeVehicle(input: RemoveVehicleRequest): Promise<void> {
    const payload = removeVehicleRequestSchema.parse(input)
    await this.rawRequest('/api/vehicles/remove', { method: 'POST', body: payload, auth: true })
  }

  // --- Корзина и заказы (требует авторизации) ---

  getCart(): Promise<CartResponse> {
    return this.request('/api/cart', cartResponseSchema, { auth: true })
  }

  addCartItem(input: AddCartItemRequest): Promise<OrderResponse> {
    const payload = addCartItemRequestSchema.parse(input)
    return this.request('/api/cart/items', orderResponseSchema, {
      method: 'POST',
      body: payload,
      auth: true,
    })
  }

  updateCartItem(input: UpdateCartItemRequest): Promise<OrderResponse> {
    const payload = updateCartItemRequestSchema.parse(input)
    return this.request('/api/cart/items/quantity', orderResponseSchema, {
      method: 'POST',
      body: payload,
      auth: true,
    })
  }

  removeCartItem(input: RemoveCartItemRequest): Promise<OrderResponse> {
    const payload = removeCartItemRequestSchema.parse(input)
    return this.request('/api/cart/items/remove', orderResponseSchema, {
      method: 'POST',
      body: payload,
      auth: true,
    })
  }

  async clearCart(): Promise<void> {
    await this.rawRequest('/api/cart/clear', { method: 'POST', auth: true })
  }

  checkout(): Promise<OrderResponse> {
    return this.request('/api/cart/checkout', orderResponseSchema, { method: 'POST', auth: true })
  }

  listOrders(): Promise<OrdersResponse> {
    return this.request('/api/orders', ordersResponseSchema, { auth: true })
  }

  getOrder(id: string): Promise<OrderResponse> {
    return this.request(`/api/orders/${encodeURIComponent(id)}`, orderResponseSchema, {
      auth: true,
    })
  }

  setCartVehicle(input: SetCartVehicleRequest): Promise<OrderResponse> {
    const payload = setCartVehicleRequestSchema.parse(input)
    return this.request('/api/cart/vehicle', orderResponseSchema, {
      method: 'POST',
      body: payload,
      auth: true,
    })
  }

  updateOrderNotes(input: UpdateOrderNotesRequest): Promise<OrderResponse> {
    const payload = updateOrderNotesRequestSchema.parse(input)
    return this.request('/api/orders/notes', orderResponseSchema, {
      method: 'POST',
      body: payload,
      auth: true,
    })
  }

  telegramStatus(): Promise<TelegramStatusResponse> {
    return this.request('/api/telegram/status', telegramStatusResponseSchema, { auth: true })
  }

  telegramLinkCode(): Promise<TelegramLinkCodeResponse> {
    return this.request('/api/telegram/link-code', telegramLinkCodeResponseSchema, {
      method: 'POST',
      auth: true,
    })
  }

  updateOrderStatus(input: UpdateOrderStatusRequest): Promise<OrderResponse> {
    const payload = updateOrderStatusRequestSchema.parse(input)
    return this.request('/api/orders/status', orderResponseSchema, {
      method: 'POST',
      body: payload,
      auth: true,
    })
  }

  // --- Оплата (требует авторизации) ---

  createPayment(input: CreatePaymentRequest): Promise<CreatePaymentResponse> {
    const payload = createPaymentRequestSchema.parse(input)
    return this.request('/api/payments/create', createPaymentResponseSchema, {
      method: 'POST',
      body: payload,
      auth: true,
    })
  }

  refund(input: RefundRequest): Promise<RefundResponse> {
    const payload = refundRequestSchema.parse(input)
    return this.request('/api/payments/refund', refundResponseSchema, {
      method: 'POST',
      body: payload,
      auth: true,
    })
  }

  confirmMockPayment(input: ConfirmMockPaymentRequest): Promise<CreatePaymentResponse> {
    const payload = confirmMockPaymentRequestSchema.parse(input)
    return this.request('/api/payments/mock/confirm', createPaymentResponseSchema, {
      method: 'POST',
      body: payload,
      auth: true,
    })
  }

  async logout(input: LogoutRequest = {}) {
    const payload = logoutRequestSchema.parse(input)
    await this.rawRequest('/api/auth/logout', {
      method: 'POST',
      body: payload,
      auth: false,
      retryOnUnauthorized: false,
    })
  }

  async expireSession() {
    this.options.setAccessToken(null)
    await this.rawRequest('/api/auth/logout', {
      method: 'POST',
      body: {},
      auth: false,
      retryOnUnauthorized: false,
    }).catch(() => undefined)
    await this.options.onAuthExpired?.()
  }

  private async request<TSchema extends z.ZodType>(
    path: string,
    schema: TSchema,
    options: RequestOptions,
  ): Promise<z.infer<TSchema>> {
    const response = await this.rawRequest(path, options)
    const data = await response.json()
    return schema.parse(data)
  }

  private async rawRequest(path: string, options: RequestOptions): Promise<Response> {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method: options.method ?? 'GET',
      credentials: 'include',
      headers: this.headers(options),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })

    if (response.status === 401 && options.auth && options.retryOnUnauthorized !== false) {
      const refreshed = await this.refreshOnce().catch(async (error: unknown) => {
        await this.expireSession()
        throw error
      })
      this.options.setAccessToken(refreshed.accessToken)
      return this.rawRequest(path, {
        ...options,
        accessTokenOverride: refreshed.accessToken,
        retryOnUnauthorized: false,
      })
    }

    if (!response.ok) {
      throw await toApiError(response)
    }

    return response
  }

  private refreshOnce() {
    this.refreshPromise ??= this.refresh().finally(() => {
      this.refreshPromise = null
    })

    return this.refreshPromise
  }

  private headers(options: RequestOptions) {
    const headers = new Headers({
      'X-Client-Platform': 'web',
    })

    if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json')
    }

    if (options.auth) {
      const accessToken = options.accessTokenOverride ?? this.options.getAccessToken()
      if (accessToken) {
        headers.set('Authorization', `Bearer ${accessToken}`)
      }
    }

    return headers
  }
}

async function toApiError(response: Response) {
  const fallbackMessage = `Request failed with status ${response.status}`

  try {
    const parsed = apiErrorSchema.parse(await response.json())
    return new ApiRequestError(response.status, parsed.error.code, parsed.error.message)
  } catch {
    return new ApiRequestError(response.status, 'INTERNAL_ERROR', fallbackMessage)
  }
}
