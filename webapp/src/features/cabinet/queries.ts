import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AddCartItemRequest,
  AddVehicleRequest,
  CartResponse,
  OrderDto,
  OrderStatus,
  PaymentMethod,
} from '@web-app-demo/contracts'

import { useAuth } from '@/lib/use-auth'

const garageKey = ['garage'] as const
const cartKey = ['cart'] as const
const ordersKey = ['orders'] as const

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
