import { useMutation, useQuery } from '@tanstack/react-query'
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import { useAuth } from '../auth'
import type { OrderDto, OrderItemDto, OrderStatus } from '../contracts'
import { describeApiError } from '../errors'
import { formatMoney } from '../format'
import { theme } from '../theme'

const STATUS_LABEL: Record<OrderStatus, string> = {
  DRAFT: 'Черновик',
  PLACED: 'Оформлен',
  PAID: 'Оплачен',
  PROCESSING: 'В работе',
  READY: 'Готов к выдаче',
  COMPLETED: 'Выдан',
  CANCELLED: 'Отменён',
  REFUNDED: 'Возврат',
}

export function OrdersScreen() {
  const { api } = useAuth()
  const orders = useQuery({ queryKey: ['orders'], queryFn: () => api.listOrders() })

  const pay = useMutation({
    mutationFn: (orderId: string) => api.createPayment(orderId),
    onSuccess: async (data) => {
      if (data.payment.confirmationUrl) {
        await Linking.openURL(data.payment.confirmationUrl)
      } else {
        Alert.alert('Оплата', 'Провайдер не вернул ссылку на оплату')
      }
    },
    onError: (error) => Alert.alert('Ошибка', describeApiError(error)),
  })

  const list = orders.data?.orders ?? []

  return (
    <ScrollView style={styles.safe} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Заказы</Text>

      {orders.isPending ? (
        <ActivityIndicator color={theme.accent} />
      ) : list.length === 0 ? (
        <Text style={styles.muted}>Заказов пока нет.</Text>
      ) : (
        list.map((order: OrderDto) => (
          <OrderCard key={order.id} order={order} paying={pay.isPending} onPay={() => pay.mutate(order.id)} />
        ))
      )}
    </ScrollView>
  )
}

function OrderCard({
  order,
  paying,
  onPay,
}: {
  order: OrderDto
  paying: boolean
  onPay: () => void
}) {
  const canPay = order.status === 'PLACED' && order.paymentStatus !== 'SUCCEEDED'
  const placed = order.placedAt ?? order.createdAt

  return (
    <View style={styles.card}>
      <View style={styles.rowBetween}>
        <Text style={styles.orderNo}>№ {order.id.slice(0, 8).toUpperCase()}</Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{STATUS_LABEL[order.status]}</Text>
        </View>
      </View>
      <Text style={styles.muted}>
        {new Date(placed).toLocaleDateString('ru-RU')} · {order.itemCount} шт.
      </Text>
      {order.items.map((item: OrderItemDto) => (
        <Text key={item.id} style={styles.itemLine}>
          • {item.partName} ×{item.quantity} — {formatMoney(item.lineTotal)}
        </Text>
      ))}
      <View style={styles.rowBetween}>
        <Text style={styles.total}>{formatMoney(order.total)}</Text>
        {canPay ? (
          <Pressable
            style={({ pressed }) => [styles.payButton, pressed && styles.pressed]}
            onPress={onPay}
            disabled={paying}
          >
            <Text style={styles.payButtonText}>Оплатить</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  title: { fontSize: 24, fontWeight: '800', color: theme.text },
  card: {
    backgroundColor: theme.surface,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: theme.border,
    gap: 6,
  },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  orderNo: { fontSize: 16, fontWeight: '700', color: theme.text },
  badge: { backgroundColor: theme.bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  badgeText: { fontSize: 12, color: theme.text, fontWeight: '600' },
  muted: { color: theme.muted, fontSize: 13 },
  itemLine: { color: theme.text, fontSize: 14 },
  total: { fontSize: 18, fontWeight: '800', color: theme.text },
  payButton: { backgroundColor: theme.primary, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 },
  pressed: { opacity: 0.85 },
  payButtonText: { color: theme.primaryText, fontWeight: '600' },
})
