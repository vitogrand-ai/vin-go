import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import { ApiRequestError } from '../api'
import { useAuth } from '../auth'
import type { Offer, Part, TierPick, Vehicle } from '../contracts'
import { formatDelivery, formatMoney, TIER_META } from '../format'
import { theme } from '../theme'

const DEMO_VIN = 'WVWZZZ1JZ3W386752'
const DEMO_PLATE = 'А123ВС777'

type SearchMode = 'vin' | 'plate'

export function SearchScreen() {
  const { api } = useAuth()
  const [mode, setMode] = useState<SearchMode>('vin')
  const [vin, setVin] = useState('')
  const [plate, setPlate] = useState('')
  const [query, setQuery] = useState('')
  const [selectedPart, setSelectedPart] = useState<Part | null>(null)

  const search = useMutation({
    mutationFn: (resolvedVin: string) => api.searchParts({ vin: resolvedVin, query }),
    onSuccess: () => setSelectedPart(null),
  })

  const plateLookup = useMutation({
    mutationFn: () => api.resolvePlate({ plate }),
    onSuccess: (data) => {
      setVin(data.vehicle.vin)
      search.mutate(data.vehicle.vin)
    },
  })

  const isBusy = search.isPending || plateLookup.isPending

  const submit = () => {
    if (!query.trim()) return
    if (mode === 'vin') {
      if (vin.trim()) search.mutate(vin)
    } else if (plate.trim()) {
      plateLookup.mutate()
    }
  }

  const vehicle = search.data?.vehicle ?? null
  const parts = search.data?.parts ?? []
  const error = search.error ?? plateLookup.error

  return (
    <ScrollView
      style={styles.safe}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
        <View style={styles.card}>
          <View style={styles.toggle}>
            {(['vin', 'plate'] as const).map((value) => (
              <Pressable
                key={value}
                style={[styles.toggleItem, mode === value && styles.toggleItemActive]}
                onPress={() => setMode(value)}
              >
                <Text style={[styles.toggleText, mode === value && styles.toggleTextActive]}>
                  {value === 'vin' ? 'По VIN' : 'По госномеру'}
                </Text>
              </Pressable>
            ))}
          </View>

          {mode === 'vin' ? (
            <>
              <Text style={styles.label}>VIN</Text>
              <TextInput
                style={[styles.input, styles.mono]}
                value={vin}
                onChangeText={(text) => setVin(text.toUpperCase())}
                autoCapitalize="characters"
                maxLength={17}
                placeholder="WVWZZZ1JZ3W386752"
                placeholderTextColor={theme.muted}
              />
              <Pressable onPress={() => setVin(DEMO_VIN)}>
                <Text style={styles.demoHint}>Подставить демо-VIN</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.label}>Госномер</Text>
              <TextInput
                style={[styles.input, styles.mono]}
                value={plate}
                onChangeText={(text) => setPlate(text.toUpperCase())}
                autoCapitalize="characters"
                maxLength={9}
                placeholder="А123ВС777"
                placeholderTextColor={theme.muted}
              />
              <Pressable onPress={() => setPlate(DEMO_PLATE)}>
                <Text style={styles.demoHint}>Подставить демо-номер</Text>
              </Pressable>
            </>
          )}

          <Text style={styles.label}>Запчасть</Text>
          <TextInput
            style={styles.input}
            value={query}
            onChangeText={setQuery}
            placeholder="тормозные колодки"
            placeholderTextColor={theme.muted}
          />

          <Pressable
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
            onPress={submit}
            disabled={isBusy}
          >
            {isBusy ? (
              <ActivityIndicator color={theme.primaryText} />
            ) : (
              <Text style={styles.buttonText}>Найти</Text>
            )}
          </Pressable>
        </View>

        {error ? <Text style={styles.error}>{describeError(error)}</Text> : null}

        {vehicle ? <VehicleCard vehicle={vehicle} /> : null}

        {search.isSuccess ? (
          <PartsList parts={parts} selected={selectedPart} onSelect={setSelectedPart} />
        ) : null}

        {selectedPart ? <OffersSection part={selectedPart} vehicleVin={vehicle?.vin} /> : null}
      </ScrollView>
  )
}

function VehicleCard({ vehicle }: { vehicle: Vehicle }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>
        {vehicle.make} {vehicle.model}
      </Text>
      <Text style={[styles.mono, styles.muted]}>{vehicle.vin}</Text>
      <Text style={styles.muted}>
        {vehicle.year}
        {vehicle.engine ? ` · ${vehicle.engine}` : ''}
      </Text>
    </View>
  )
}

function PartsList({
  parts,
  selected,
  onSelect,
}: {
  parts: Part[]
  selected: Part | null
  onSelect: (part: Part) => void
}) {
  if (parts.length === 0) {
    return <Text style={styles.muted}>Ничего не найдено. Попробуйте другой запрос.</Text>
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Найденные запчасти</Text>
      {parts.map((part) => {
        const active = selected?.oemNumber === part.oemNumber
        return (
          <Pressable
            key={part.oemNumber}
            style={[styles.partRow, active && styles.partRowActive]}
            onPress={() => onSelect(part)}
          >
            <Text style={styles.partName}>{part.name}</Text>
            <Text style={[styles.mono, styles.muted]}>
              {part.oemNumber} · {part.category}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function OffersSection({ part, vehicleVin }: { part: Part; vehicleVin?: string }) {
  const { api } = useAuth()
  const offersQuery = useQuery({
    queryKey: ['offers', part.oemNumber],
    queryFn: () => api.offers({ oemNumber: part.oemNumber }),
  })

  const addCart = useMutation({
    mutationFn: (vars: { offer: Offer; tier: string }) =>
      api.addCartItem({
        oemNumber: part.oemNumber,
        offerId: vars.offer.id,
        partName: part.name,
        tier: vars.tier,
        vehicleVin: vehicleVin && /^[A-HJ-NPR-Z0-9]{17}$/.test(vehicleVin) ? vehicleVin : undefined,
      }),
    onSuccess: () => Alert.alert('Корзина', `«${part.name}» добавлено`),
    onError: (error) => Alert.alert('Ошибка', describeError(error)),
  })

  if (offersQuery.isPending) {
    return (
      <View style={[styles.section, styles.row]}>
        <ActivityIndicator color={theme.accent} />
        <Text style={styles.muted}>Загружаем предложения…</Text>
      </View>
    )
  }

  if (offersQuery.isError) {
    return <Text style={styles.error}>{describeError(offersQuery.error)}</Text>
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{part.name}</Text>
      <Text style={[styles.mono, styles.muted]}>OEM {part.oemNumber}</Text>
      {offersQuery.data.picks.map((pick: TierPick) => (
        <TierCard
          key={pick.tier}
          pick={pick}
          adding={addCart.isPending}
          onAdd={() => addCart.mutate({ offer: pick.offer, tier: pick.tier })}
        />
      ))}
      <Text style={styles.muted}>Всего предложений: {offersQuery.data.offers.length}</Text>
    </View>
  )
}

function TierCard({
  pick,
  onAdd,
  adding,
}: {
  pick: TierPick
  onAdd: () => void
  adding: boolean
}) {
  const meta = TIER_META[pick.tier]
  const offer: Offer = pick.offer

  return (
    <View style={[styles.tierCard, { borderColor: meta.color }]}>
      <View style={styles.tierHeader}>
        <View style={[styles.badge, { backgroundColor: meta.color }]}>
          <Text style={styles.badgeText}>{meta.label}</Text>
        </View>
        <Text style={styles.tierPrice}>{formatMoney(offer.price)}</Text>
      </View>
      <Text style={styles.tierBrand}>
        {offer.brand} · {offer.supplierName}
      </Text>
      <Text style={styles.muted}>
        {offer.inStock ? `✅ В наличии (${offer.quantityAvailable})` : '⏳ Под заказ'} ·{' '}
        {formatDelivery(offer.deliveryDays)}
      </Text>
      <Text style={styles.tierReason}>{pick.reason}</Text>
      <Pressable
        style={({ pressed }) => [styles.addButton, pressed && styles.buttonPressed]}
        onPress={onAdd}
        disabled={adding}
      >
        <Text style={styles.addButtonText}>В корзину</Text>
      </Pressable>
    </View>
  )
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 404) return error.message
    if (error.status === 400) return 'Проверьте VIN, госномер и название запчасти.'
    return error.message
  }
  return 'Не удалось выполнить запрос. Проверьте сеть и адрес API.'
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
    backgroundColor: theme.surface,
  },
  brand: { fontSize: 20, fontWeight: '800', color: theme.text },
  userEmail: { fontSize: 12, color: theme.muted },
  logout: { color: theme.accent, fontSize: 14, fontWeight: '600' },
  content: { padding: 16, gap: 16, paddingBottom: 48 },
  card: {
    backgroundColor: theme.surface,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: theme.border,
    gap: 6,
  },
  cardTitle: { fontSize: 18, fontWeight: '700', color: theme.text },
  toggle: { flexDirection: 'row', backgroundColor: theme.bg, borderRadius: 10, padding: 3 },
  toggleItem: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8 },
  toggleItemActive: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  toggleText: { color: theme.muted, fontWeight: '600', fontSize: 14 },
  toggleTextActive: { color: theme.text },
  label: { fontSize: 13, color: theme.muted, marginTop: 6 },
  input: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: theme.text,
  },
  mono: { fontFamily: Platform.select({ ios: 'Courier', android: 'monospace', default: 'monospace' }) },
  demoHint: { color: theme.accent, fontSize: 13, marginTop: 2 },
  button: {
    backgroundColor: theme.primary,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 14,
  },
  buttonPressed: { opacity: 0.85 },
  buttonText: { color: theme.primaryText, fontSize: 16, fontWeight: '600' },
  error: { color: theme.danger, fontSize: 14 },
  muted: { color: theme.muted, fontSize: 13 },
  section: { gap: 8 },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: theme.text },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  partRow: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: theme.border,
    gap: 2,
  },
  partRowActive: { borderColor: theme.accent, backgroundColor: '#eff6ff' },
  partName: { fontSize: 15, fontWeight: '600', color: theme.text },
  tierCard: {
    backgroundColor: theme.surface,
    borderRadius: 14,
    padding: 16,
    borderWidth: 2,
    gap: 4,
  },
  tierHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  badgeText: { color: '#ffffff', fontSize: 12, fontWeight: '700' },
  tierPrice: { fontSize: 20, fontWeight: '800', color: theme.text },
  tierBrand: { fontSize: 15, fontWeight: '600', color: theme.text },
  tierReason: { fontSize: 12, color: theme.muted, fontStyle: 'italic' },
  addButton: {
    marginTop: 8,
    backgroundColor: theme.primary,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  addButtonText: { color: theme.primaryText, fontWeight: '600' },
})
