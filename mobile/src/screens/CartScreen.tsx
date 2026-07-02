import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import { useAuth } from '../auth'
import type { CartResponse, OrderItemDto } from '../contracts'
import { describeApiError } from '../errors'
import { formatMoney } from '../format'
import { theme } from '../theme'

export function CartScreen() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  const cart = useQuery({ queryKey: ['cart'], queryFn: () => api.getCart() })

  const setCart = (data: { order: CartResponse['order'] }) =>
    queryClient.setQueryData<CartResponse>(['cart'], data)

  const updateItem = useMutation({
    mutationFn: (input: { itemId: string; quantity: number }) => api.updateCartItem(input),
    onSuccess: (data) => setCart({ order: data.order }),
    onError: (error) => Alert.alert('Ошибка', describeApiError(error)),
  })
  const removeItem = useMutation({
    mutationFn: (itemId: string) => api.removeCartItem(itemId),
    onSuccess: (data) => setCart({ order: data.order }),
  })
  const checkout = useMutation({
    mutationFn: () => api.checkout(),
    onSuccess: (data) => {
      setCart({ order: null })
      void queryClient.invalidateQueries({ queryKey: ['orders'] })
      Alert.alert('Заказ', `Оформлен на ${formatMoney(data.order.total)}. Оплатить — во вкладке «Заказы».`)
    },
    onError: (error) => Alert.alert('Ошибка', describeApiError(error)),
  })

  const order = cart.data?.order ?? null

  return (
    <ScrollView style={styles.safe} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Корзина</Text>

      {cart.isPending ? (
        <ActivityIndicator color={theme.accent} />
      ) : !order || order.items.length === 0 ? (
        <Text style={styles.muted}>Корзина пуста. Найдите запчасть во вкладке «Поиск».</Text>
      ) : (
        <>
          {order.items.map((item: OrderItemDto) => (
            <CartRow
              key={item.id}
              item={item}
              busy={updateItem.isPending || removeItem.isPending}
              onQuantity={(quantity) => updateItem.mutate({ itemId: item.id, quantity })}
              onRemove={() => removeItem.mutate(item.id)}
            />
          ))}

          <View style={styles.totalRow}>
            <Text style={styles.muted}>Итого ({order.itemCount} шт.)</Text>
            <Text style={styles.total}>{formatMoney(order.total)}</Text>
          </View>

          <Pressable
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
            onPress={() => checkout.mutate()}
            disabled={checkout.isPending}
          >
            {checkout.isPending ? (
              <ActivityIndicator color={theme.primaryText} />
            ) : (
              <Text style={styles.buttonText}>Оформить заказ</Text>
            )}
          </Pressable>
        </>
      )}
    </ScrollView>
  )
}

function CartRow({
  item,
  busy,
  onQuantity,
  onRemove,
}: {
  item: OrderItemDto
  busy: boolean
  onQuantity: (quantity: number) => void
  onRemove: () => void
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.partName}>{item.partName}</Text>
      <Text style={styles.muted}>
        {item.brand} · {item.oemNumber}
      </Text>
      <View style={styles.rowBetween}>
        <View style={styles.qtyRow}>
          <Pressable
            style={styles.qtyButton}
            disabled={busy || item.quantity <= 1}
            onPress={() => onQuantity(item.quantity - 1)}
          >
            <Text style={styles.qtyButtonText}>−</Text>
          </Pressable>
          <Text style={styles.qty}>{item.quantity}</Text>
          <Pressable
            style={styles.qtyButton}
            disabled={busy || item.quantity >= 99}
            onPress={() => onQuantity(item.quantity + 1)}
          >
            <Text style={styles.qtyButtonText}>+</Text>
          </Pressable>
        </View>
        <Text style={styles.lineTotal}>{formatMoney(item.lineTotal)}</Text>
      </View>
      <Pressable onPress={onRemove} disabled={busy}>
        <Text style={styles.remove}>Удалить</Text>
      </Pressable>
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
  partName: { fontSize: 15, fontWeight: '600', color: theme.text },
  muted: { color: theme.muted, fontSize: 13 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  qtyButton: {
    width: 34,
    height: 34,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyButtonText: { fontSize: 18, color: theme.text },
  qty: { fontSize: 16, fontWeight: '600', color: theme.text, minWidth: 24, textAlign: 'center' },
  lineTotal: { fontSize: 16, fontWeight: '700', color: theme.text },
  remove: { color: theme.danger, fontWeight: '600', marginTop: 4 },
  totalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  total: { fontSize: 22, fontWeight: '800', color: theme.text },
  button: {
    backgroundColor: theme.primary,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  pressed: { opacity: 0.85 },
  buttonText: { color: theme.primaryText, fontSize: 16, fontWeight: '600' },
})
