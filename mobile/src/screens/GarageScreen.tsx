import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'

import { useAuth } from '../auth'
import type { SavedVehicle } from '../contracts'
import { describeApiError } from '../errors'
import { theme } from '../theme'

export function GarageScreen() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  const garage = useQuery({ queryKey: ['vehicles'], queryFn: () => api.listVehicles() })
  const [vin, setVin] = useState('')
  const [nickname, setNickname] = useState('')

  const add = useMutation({
    mutationFn: () => api.addVehicle({ vin, nickname: nickname.trim() || undefined }),
    onSuccess: () => {
      setVin('')
      setNickname('')
      void queryClient.invalidateQueries({ queryKey: ['vehicles'] })
      Alert.alert('Гараж', 'Автомобиль добавлен')
    },
    onError: (error) => Alert.alert('Ошибка', describeApiError(error)),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.removeVehicle(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['vehicles'] }),
    onError: (error) => Alert.alert('Ошибка', describeApiError(error)),
  })

  const vehicles = garage.data?.vehicles ?? []

  return (
    <ScrollView style={styles.safe} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Гараж</Text>

      <View style={styles.card}>
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
        <Text style={styles.label}>Название (необязательно)</Text>
        <TextInput
          style={styles.input}
          value={nickname}
          onChangeText={setNickname}
          placeholder="Моя Гольф"
          maxLength={60}
          placeholderTextColor={theme.muted}
        />
        <Pressable
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
          onPress={() => vin.trim() && add.mutate()}
          disabled={add.isPending}
        >
          {add.isPending ? <ActivityIndicator color={theme.primaryText} /> : <Text style={styles.buttonText}>Добавить</Text>}
        </Pressable>
      </View>

      {garage.isPending ? (
        <ActivityIndicator color={theme.accent} />
      ) : vehicles.length === 0 ? (
        <Text style={styles.muted}>Гараж пуст. Добавьте первый автомобиль по VIN.</Text>
      ) : (
        vehicles.map((vehicle: SavedVehicle) => (
          <View key={vehicle.id} style={styles.card}>
            <Text style={styles.vehicleTitle}>{vehicle.nickname ?? `${vehicle.make} ${vehicle.model}`}</Text>
            <Text style={[styles.mono, styles.muted]}>{vehicle.vin}</Text>
            <Text style={styles.muted}>
              {vehicle.make} {vehicle.model}, {vehicle.year}
            </Text>
            <Pressable onPress={() => remove.mutate(vehicle.id)} disabled={remove.isPending}>
              <Text style={styles.remove}>Удалить</Text>
            </Pressable>
          </View>
        ))
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 16, gap: 14, paddingBottom: 40 },
  title: { fontSize: 24, fontWeight: '800', color: theme.text },
  card: {
    backgroundColor: theme.surface,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: theme.border,
    gap: 6,
  },
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
  mono: { fontFamily: 'monospace' },
  button: {
    backgroundColor: theme.primary,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 12,
  },
  pressed: { opacity: 0.85 },
  buttonText: { color: theme.primaryText, fontSize: 16, fontWeight: '600' },
  muted: { color: theme.muted, fontSize: 13 },
  vehicleTitle: { fontSize: 16, fontWeight: '700', color: theme.text },
  remove: { color: theme.danger, fontWeight: '600', marginTop: 6 },
})
