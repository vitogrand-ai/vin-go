import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'

import type { ApiClient } from './api'

/**
 * Запрашивает разрешение на уведомления, получает Expo push-токен и
 * регистрирует его в бэкенде. Любые сбои (эмулятор, ограничения Expo Go)
 * проглатываются — push не критичен для работы приложения.
 */
export async function registerForPush(api: ApiClient): Promise<void> {
  try {
    const existing = await Notifications.getPermissionsAsync()
    let status = existing.status
    if (status !== 'granted') {
      const requested = await Notifications.requestPermissionsAsync()
      status = requested.status
    }
    if (status !== 'granted') return

    const tokenData = await Notifications.getExpoPushTokenAsync()
    await api.registerDevice(tokenData.data, Platform.OS === 'ios' ? 'ios' : 'android')
  } catch {
    // Устройство/окружение без поддержки push — пропускаем молча.
  }
}
