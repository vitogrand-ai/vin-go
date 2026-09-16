import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AddCartItemRequest,
  AddOrderWorkRequest,
  AddVehicleRequest,
  AnswerExpertRequest,
  CartResponse,
  CreateCustomerRequest,
  CreateExpertRequest,
  OrderDto,
  OrderResponse,
  OrderStatus,
  OrganizationResponse,
  PaymentMethod,
  UpdateCustomerRequest,
  UpdateOrderReceptionRequest,
  UpdateOrganizationRequest,
  UpdateVehicleRequest,
} from '@web-app-demo/contracts'

import { publicApi } from '@/lib/public-api'
import { useAuth } from '@/lib/use-auth'

const garageKey = ['garage'] as const
const cartKey = ['cart'] as const
const ordersKey = ['orders'] as const
const orgKey = ['org'] as const
const customersKey = ['customers'] as const
const expertsKey = ['experts'] as const

/** Заявки эксперту: автосервису — свои, оператору платформы — общая очередь. */
export function useExpertRequests() {
  const { api, isAuthenticated } = useAuth()
  return useQuery({
    queryKey: expertsKey,
    enabled: isAuthenticated,
    queryFn: () => api.listExpertRequests(),
  })
}

export function useCreateExpertRequest() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateExpertRequest) => api.createExpertRequest(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: expertsKey }),
  })
}

export function useAnswerExpertRequest() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: AnswerExpertRequest) => api.answerExpertRequest(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: expertsKey }),
  })
}

/** Подключённые источники данных (публично): для честного индикатора демо-режима. */
export function useCatalogStatus() {
  return useQuery({
    queryKey: ['catalog', 'status'],
    queryFn: () => publicApi.catalogStatus(),
    staleTime: 5 * 60_000,
  })
}

/** Автосервис пользователя. */
export function useOrganization() {
  const { api, isAuthenticated } = useAuth()
  return useQuery({
    queryKey: orgKey,
    enabled: isAuthenticated,
    queryFn: () => api.getOrganization(),
  })
}

export function useUpdateOrganization() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: UpdateOrganizationRequest) => api.updateOrganization(input),
    onSuccess: (data) => queryClient.setQueryData<OrganizationResponse>(orgKey, data),
  })
}

export function useRotateInviteCode() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.rotateInviteCode(),
    onSuccess: (data) => queryClient.setQueryData<OrganizationResponse>(orgKey, data),
  })
}

/** Переход в другой автосервис: меняется всё, что видит пользователь. */
export function useJoinOrganization() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (inviteCode: string) => api.joinOrganization({ inviteCode }),
    onSuccess: (data) => {
      queryClient.setQueryData<OrganizationResponse>(orgKey, data)
      void queryClient.invalidateQueries()
    },
  })
}

/** Клиенты автосервиса. */
export function useCustomers() {
  const { api, isAuthenticated } = useAuth()
  return useQuery({
    queryKey: customersKey,
    enabled: isAuthenticated,
    queryFn: () => api.listCustomers(),
  })
}

export function useCreateCustomer() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateCustomerRequest) => api.createCustomer(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: customersKey }),
  })
}

export function useUpdateCustomer() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: UpdateCustomerRequest) => api.updateCustomer(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: customersKey })
      void queryClient.invalidateQueries({ queryKey: garageKey })
    },
  })
}

export function useRemoveCustomer() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.removeCustomer({ id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: customersKey })
      void queryClient.invalidateQueries({ queryKey: garageKey })
    },
  })
}

/** Правка карточки авто: госномер, пробег, клиент, название. */
export function useUpdateVehicle() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: UpdateVehicleRequest) => api.updateVehicle(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: garageKey })
      void queryClient.invalidateQueries({ queryKey: customersKey })
    },
  })
}

/** Гараж пользователя. */
export function useGarage() {
  const { api, isAuthenticated } = useAuth()
  return useQuery({
    queryKey: garageKey,
    enabled: isAuthenticated,
    queryFn: () => api.listVehicles(),
  })
}

export function useAddVehicle() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: AddVehicleRequest) => api.addVehicle(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: garageKey }),
  })
}

export function useRemoveVehicle() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.removeVehicle({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: garageKey }),
  })
}

/** Текущая корзина (черновик заказа). */
export function useCart() {
  const { api, isAuthenticated } = useAuth()
  return useQuery({
    queryKey: cartKey,
    enabled: isAuthenticated,
    queryFn: () => api.getCart(),
  })
}

export function useAddCartItem() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: AddCartItemRequest) => api.addCartItem(input),
    onSuccess: (data) => queryClient.setQueryData<CartResponse>(cartKey, { order: data.order }),
  })
}

export function useUpdateCartItem() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { itemId: string; quantity: number }) => api.updateCartItem(input),
    onSuccess: (data) => queryClient.setQueryData<CartResponse>(cartKey, { order: data.order }),
  })
}

/** Ручная цена для клиента по позиции корзины. */
export function useUpdateCartItemSalePrice() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { itemId: string; saleAmount: number }) =>
      api.updateCartItemSalePrice(input),
    onSuccess: (data) => queryClient.setQueryData<CartResponse>(cartKey, { order: data.order }),
  })
}

/** Клиент автосервиса для корзины (null — отвязать). */
export function useSetCartCustomer() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (customerId: string | null) => api.setCartCustomer({ customerId }),
    onSuccess: (data) => queryClient.setQueryData<CartResponse>(cartKey, { order: data.order }),
  })
}

export function useRemoveCartItem() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (itemId: string) => api.removeCartItem({ itemId }),
    onSuccess: (data) => queryClient.setQueryData<CartResponse>(cartKey, { order: data.order }),
  })
}

export function useClearCart() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.clearCart(),
    onSuccess: () => queryClient.setQueryData<CartResponse>(cartKey, { order: null }),
  })
}

export function useCheckout() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.checkout(),
    onSuccess: () => {
      queryClient.setQueryData<CartResponse>(cartKey, { order: null })
      void queryClient.invalidateQueries({ queryKey: ordersKey })
    },
  })
}

/** Статус привязки Telegram. */
export function useTelegramStatus() {
  const { api, isAuthenticated } = useAuth()
  return useQuery({
    queryKey: ['telegram', 'status'],
    enabled: isAuthenticated,
    queryFn: () => api.telegramStatus(),
  })
}

/** Сгенерировать код привязки Telegram. */
export function useTelegramLinkCode() {
  const { api } = useAuth()
  return useMutation({
    mutationFn: () => api.telegramLinkCode(),
  })
}

/** История заказов. */
export function useOrders() {
  const { api, isAuthenticated } = useAuth()
  return useQuery({
    queryKey: ordersKey,
    enabled: isAuthenticated,
    queryFn: () => api.listOrders(),
  })
}

/** Один заказ по id. */
export function useOrder(id: string) {
  const { api, isAuthenticated } = useAuth()
  return useQuery({
    queryKey: ['order', id],
    enabled: isAuthenticated && Boolean(id),
    queryFn: () => api.getOrder(id),
  })
}

/** Привязать корзину к авто из гаража. */
export function useSetCartVehicle() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (vin: string) => api.setCartVehicle({ vin }),
    onSuccess: (data) => queryClient.setQueryData<CartResponse>(cartKey, { order: data.order }),
  })
}

/** Заметка к заказу. */
export function useUpdateOrderNotes() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { orderId: string; notes: string }) => api.updateOrderNotes(input),
    onSuccess: (data) => {
      queryClient.setQueryData(['order', data.order.id], data)
      void queryClient.invalidateQueries({ queryKey: ordersKey })
    },
  })
}

/** Заказ-наряд: работа добавлена/удалена, приём сохранён — обновляем карточку, список и корзину. */
function useOrderMutation<TInput>(run: (api: ReturnType<typeof useAuth>['api'], input: TInput) => Promise<OrderResponse>) {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: TInput) => run(api, input),
    onSuccess: (data) => {
      queryClient.setQueryData(['order', data.order.id], data)
      void queryClient.invalidateQueries({ queryKey: ordersKey })
      void queryClient.invalidateQueries({ queryKey: cartKey })
    },
  })
}

export function useAddOrderWork() {
  return useOrderMutation((api, input: AddOrderWorkRequest) => api.addOrderWork(input))
}

export function useRemoveOrderWork() {
  return useOrderMutation((api, input: { orderId: string; workId: string }) =>
    api.removeOrderWork(input),
  )
}

export function useUpdateOrderReception() {
  return useOrderMutation((api, input: UpdateOrderReceptionRequest) =>
    api.updateOrderReception(input),
  )
}

/** Сменить статус заказа (оператором). */
export function useUpdateOrderStatus() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { orderId: string; status: OrderStatus }) => api.updateOrderStatus(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ordersKey }),
  })
}

/** Создать платёж по заказу (возвращает ссылку на оплату). */
export function useCreatePayment() {
  const { api } = useAuth()
  return useMutation({
    mutationFn: (input: { orderId: string; method?: PaymentMethod }) => api.createPayment(input),
  })
}

/** Возврат средств по заказу. */
export function useRefundOrder() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (orderId: string) => api.refund({ orderId }),
    onSuccess: (_data, orderId) => {
      void queryClient.invalidateQueries({ queryKey: ordersKey })
      void queryClient.invalidateQueries({ queryKey: ['order', orderId] })
    },
  })
}

/**
 * Повторный заказ: добавляет позиции прошлого заказа в корзину по актуальным
 * предложениям (цена авторитетна с сервера). Для каждой позиции берём свежие
 * предложения по OEM и сопоставляем по бренду+артикулу (иначе — первое доступное);
 * позиции, которых больше нет в выдаче, возвращаем как недоступные.
 */
export function useReorder() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (order: OrderDto) => {
      let added = 0
      const unavailable: string[] = []
      for (const item of order.items) {
        const { offers } = await api.offers({ oemNumber: item.oemNumber })
        const match =
          offers.find(
            (offer) => offer.brand === item.brand && offer.articleNumber === item.articleNumber,
          ) ?? offers[0]
        if (!match) {
          unavailable.push(item.partName)
          continue
        }
        await api.addCartItem({
          oemNumber: item.oemNumber,
          offerId: match.id,
          partName: item.partName,
          tier: item.tier ?? undefined,
          quantity: item.quantity,
        })
        added += 1
      }
      return { added, unavailable }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: cartKey })
    },
  })
}

/** Подтвердить мок-оплату (страница /pay). */
export function useConfirmMockPayment() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (paymentId: string) => api.confirmMockPayment({ paymentId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ordersKey }),
  })
}
