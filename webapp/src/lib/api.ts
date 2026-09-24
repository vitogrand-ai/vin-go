import {
  addCartItemRequestSchema,
  addOrderWorkRequestSchema,
  addVehicleRequestSchema,
  answerExpertRequestSchema,
  apiErrorSchema,
  createExpertRequestSchema,
  expertRequestResponseSchema,
  expertRequestsResponseSchema,
  authResponseSchema,
  cartResponseSchema,
  catalogStatusResponseSchema,
  confirmMockPaymentRequestSchema,
  createCustomerRequestSchema,
  createPaymentRequestSchema,
  createPaymentResponseSchema,
  customerResponseSchema,
  customersResponseSchema,
  decodeVinRequestSchema,
  decodeVinResponseSchema,
  garageResponseSchema,
  joinOrganizationRequestSchema,
  organizationResponseSchema,
  removeCustomerRequestSchema,
  setCartCustomerRequestSchema,
  updateCartItemSalePriceRequestSchema,
  updateCustomerRequestSchema,
  updateOrganizationRequestSchema,
  updateVehicleRequestSchema,
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
  removeOrderWorkRequestSchema,
  removeVehicleRequestSchema,
  schemePartsRequestSchema,
  branchSchemesRequestSchema,
  branchSchemesResponseSchema,
  catalogTreeRequestSchema,
  catalogTreeResponseSchema,
  searchPartsRequestSchema,
  searchPartsResponseSchema,
  setCartVehicleRequestSchema,
  telegramLinkCodeResponseSchema,
  telegramStatusResponseSchema,
  updateCartItemRequestSchema,
  updateOrderNotesRequestSchema,
  updateOrderReceptionRequestSchema,
  updateOrderStatusRequestSchema,
  vehicleResponseSchema,
  type AddCartItemRequest,
  type AddOrderWorkRequest,
  type AddVehicleRequest,
  type AnswerExpertRequest,
  type AuthResponse,
  type CartResponse,
  type CatalogStatusResponse,
  type CreateExpertRequest,
  type ExpertRequestResponse,
  type ExpertRequestsResponse,
  type ConfirmMockPaymentRequest,
  type CreateCustomerRequest,
  type CustomerResponse,
  type CustomersResponse,
  type JoinOrganizationRequest,
  type OrganizationResponse,
  type RemoveCustomerRequest,
  type SetCartCustomerRequest,
  type UpdateCartItemSalePriceRequest,
  type UpdateCustomerRequest,
  type UpdateOrganizationRequest,
  type UpdateVehicleRequest,
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
  type RemoveOrderWorkRequest,
  type ResolvePlateRequest,
  type ResolvePlateResponse,
  type RemoveVehicleRequest,
  type SchemePartsRequest,
  type BranchSchemesRequest,
  type BranchSchemesResponse,
  type CatalogTreeResponse,
  type SearchPartsRequest,
  type SearchPartsResponse,
  type SetCartVehicleRequest,
  type TelegramLinkCodeResponse,
  type TelegramStatusResponse,
  type UpdateCartItemRequest,
  type UpdateOrderNotesRequest,
  type UpdateOrderReceptionRequest,
  type UpdateOrderStatusRequest,
  type VehicleResponse,
} from '@web-app-demo/contracts'
import type { z } from 'zod'

/** Базовый адрес API: пусто в сборке = same-origin (прод за Caddy), локально — :3000. */
export const apiBaseUrl = (import.meta.env?.VITE_API_URL ?? 'http://localhost:3000').replace(/\/$/, '')

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

  /** Узел схемы целиком (или одна выноска) — для выбора детали нажатием на схему. */
  schemeParts(input: SchemePartsRequest): Promise<SearchPartsResponse> {
    const payload = schemePartsRequestSchema.parse(input)
    return this.request('/api/catalog/scheme', searchPartsResponseSchema, {
      method: 'POST',
      body: payload,
      auth: false,
    })
  }

  /** Дерево узлов каталога машины — поиск детали глазами, когда по названию не нашлось. */
  catalogTree(input: { vin: string }): Promise<CatalogTreeResponse> {
    const payload = catalogTreeRequestSchema.parse(input)
    return this.request('/api/catalog/tree', catalogTreeResponseSchema, {
      method: 'POST',
      body: payload,
      auth: false,
    })
  }

  /** Схемы листа дерева узлов. */
  branchSchemes(input: BranchSchemesRequest): Promise<BranchSchemesResponse> {
    const payload = branchSchemesRequestSchema.parse(input)
    return this.request('/api/catalog/branch-schemes', branchSchemesResponseSchema, {
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

  /** Подключённые источники данных и признак демо-режима. */
  catalogStatus(): Promise<CatalogStatusResponse> {
    return this.request('/api/catalog/status', catalogStatusResponseSchema, { auth: false })
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

  updateVehicle(input: UpdateVehicleRequest): Promise<VehicleResponse> {
    const payload = updateVehicleRequestSchema.parse(input)
    return this.request('/api/vehicles/update', vehicleResponseSchema, {
      method: 'POST',
      body: payload,
      auth: true,
    })
  }

  // --- Автосервис и клиенты (требует авторизации) ---

  getOrganization(): Promise<OrganizationResponse> {
    return this.request('/api/org', organizationResponseSchema, { auth: true })
  }

  updateOrganization(input: UpdateOrganizationRequest): Promise<OrganizationResponse> {
    const payload = updateOrganizationRequestSchema.parse(input)
    return this.request('/api/org', organizationResponseSchema, {
      method: 'POST',
      body: payload,
      auth: true,
    })
  }

  rotateInviteCode(): Promise<OrganizationResponse> {
    return this.request('/api/org/invite/rotate', organizationResponseSchema, {
      method: 'POST',
      auth: true,
    })
  }

  joinOrganization(input: JoinOrganizationRequest): Promise<OrganizationResponse> {
    const payload = joinOrganizationRequestSchema.parse(input)
    return this.request('/api/org/join', organizationResponseSchema, {
      method: 'POST',
      body: payload,
      auth: true,
    })
  }

  // --- Заявки эксперту (требует авторизации) ---

  listExpertRequests(): Promise<ExpertRequestsResponse> {
    return this.request('/api/experts/requests', expertRequestsResponseSchema, { auth: true })
  }

  createExpertRequest(input: CreateExpertRequest): Promise<ExpertRequestResponse> {
    const payload = createExpertRequestSchema.parse(input)
    return this.request('/api/experts/requests', expertRequestResponseSchema, {
      method: 'POST',
      body: payload,
      auth: true,
    })
  }

  answerExpertRequest(input: AnswerExpertRequest): Promise<ExpertRequestResponse> {
    const payload = answerExpertRequestSchema.parse(input)
    return this.request('/api/experts/requests/answer', expertRequestResponseSchema, {
      method: 'POST',
      body: payload,
      auth: true,
    })
  }

  listCustomers(): Promise<CustomersResponse> {
    return this.request('/api/customers', customersResponseSchema, { auth: true })
  }

  createCustomer(input: CreateCustomerRequest): Promise<CustomerResponse> {
    const payload = createCustomerRequestSchema.parse(input)
    return this.request('/api/customers', customerResponseSchema, {
      method: 'POST',
      body: payload,
      auth: true,
    })
  }

  updateCustomer(input: UpdateCustomerRequest): Promise<CustomerResponse> {
    const payload = updateCustomerRequestSchema.parse(input)
    return this.request('/api/customers/update', customerResponseSchema, {
      method: 'POST',
      body: payload,
      auth: true,
    })
  }

  async removeCustomer(input: RemoveCustomerRequest): Promise<void> {
    const payload = removeCustomerRequestSchema.parse(input)
    await this.rawRequest('/api/customers/remove', { method: 'POST', body: payload, auth: true })
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

  updateCartItemSalePrice(input: UpdateCartItemSalePriceRequest): Promise<OrderResponse> {
    const payload = updateCartItemSalePriceRequestSchema.parse(input)
    return this.request('/api/cart/items/sale-price', orderResponseSchema, {
      method: 'POST',
      body: payload,
      auth: true,
    })
  }

  setCartCustomer(input: SetCartCustomerRequest): Promise<OrderResponse> {
    const payload = setCartCustomerRequestSchema.parse(input)
    return this.request('/api/cart/customer', orderResponseSchema, {
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

  // --- Заказ-наряд: работы и приём машины ---

  addOrderWork(input: AddOrderWorkRequest): Promise<OrderResponse> {
    const payload = addOrderWorkRequestSchema.parse(input)
    return this.request('/api/orders/works', orderResponseSchema, {
      method: 'POST',
      body: payload,
      auth: true,
    })
  }

  removeOrderWork(input: RemoveOrderWorkRequest): Promise<OrderResponse> {
    const payload = removeOrderWorkRequestSchema.parse(input)
    return this.request('/api/orders/works/remove', orderResponseSchema, {
      method: 'POST',
      body: payload,
      auth: true,
    })
  }

  updateOrderReception(input: UpdateOrderReceptionRequest): Promise<OrderResponse> {
    const payload = updateOrderReceptionRequestSchema.parse(input)
    return this.request('/api/orders/reception', orderResponseSchema, {
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
