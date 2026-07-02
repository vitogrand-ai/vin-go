import type { OrderPaymentStatus, OrderStatus } from '@web-app-demo/contracts'

export type BadgeVariant = 'default' | 'secondary' | 'destructive'

export const STATUS_LABEL: Record<OrderStatus, { label: string; variant: BadgeVariant }> = {
  DRAFT: { label: 'Черновик', variant: 'secondary' },
  PLACED: { label: 'Оформлен', variant: 'secondary' },
  PAID: { label: 'Оплачен', variant: 'default' },
  PROCESSING: { label: 'В работе', variant: 'default' },
  READY: { label: 'Готов к выдаче', variant: 'default' },
  COMPLETED: { label: 'Выдан', variant: 'default' },
  CANCELLED: { label: 'Отменён', variant: 'destructive' },
  REFUNDED: { label: 'Возврат', variant: 'destructive' },
}

export const PAYMENT_LABEL: Record<OrderPaymentStatus, { label: string; variant: BadgeVariant } | null> = {
  NONE: null,
  PENDING: { label: 'Ожидает оплаты', variant: 'secondary' },
  SUCCEEDED: { label: 'Оплачен', variant: 'default' },
  CANCELED: { label: 'Оплата отменена', variant: 'destructive' },
}

/** Подпись кнопки перехода в целевой статус. */
export const TRANSITION_LABEL: Record<OrderStatus, string> = {
  DRAFT: 'Черновик',
  PLACED: 'Оформить',
  PAID: 'Оплачен',
  PROCESSING: 'В работу',
  READY: 'Готов к выдаче',
  COMPLETED: 'Выдан',
  CANCELLED: 'Отменить',
  REFUNDED: 'Возврат',
}
