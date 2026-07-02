import { useEffect, useState } from 'react'
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native'

import { useAuth } from './auth'
import { registerForPush } from './push'
import { CartScreen } from './screens/CartScreen'
import { GarageScreen } from './screens/GarageScreen'
import { OrdersScreen } from './screens/OrdersScreen'
import { SearchScreen } from './screens/SearchScreen'
import { theme } from './theme'

type Tab = 'search' | 'garage' | 'cart' | 'orders'

const TABS: { key: Tab; label: string }[] = [
  { key: 'search', label: 'Поиск' },
  { key: 'garage', label: 'Гараж' },
  { key: 'cart', label: 'Корзина' },
  { key: 'orders', label: 'Заказы' },
]

export function AppShell() {
  const { api, logout } = useAuth()
  const [tab, setTab] = useState<Tab>('search')

  // Регистрируем устройство для push после входа.
  useEffect(() => {
    void registerForPush(api)
  }, [api])

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.topbar}>
        <Text style={styles.brand}>VIN GO</Text>
        <Pressable onPress={() => void logout()} hitSlop={8}>
          <Text style={styles.logout}>Выйти</Text>
        </Pressable>
      </View>

      <View style={styles.body}>
        {tab === 'search' ? <SearchScreen /> : null}
        {tab === 'garage' ? <GarageScreen /> : null}
        {tab === 'cart' ? <CartScreen /> : null}
        {tab === 'orders' ? <OrdersScreen /> : null}
      </View>

      <View style={styles.tabbar}>
        {TABS.map((item) => (
          <Pressable key={item.key} style={styles.tabItem} onPress={() => setTab(item.key)}>
            <Text style={[styles.tabText, tab === item.key && styles.tabTextActive]}>
              {item.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
    backgroundColor: theme.surface,
  },
  brand: { fontSize: 20, fontWeight: '800', color: theme.text },
  logout: { color: theme.accent, fontSize: 14, fontWeight: '600' },
  body: { flex: 1 },
  tabbar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: theme.border,
    backgroundColor: theme.surface,
  },
  tabItem: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  tabText: { color: theme.muted, fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: theme.accent },
})
