import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'

import type { ApiClient } from './api'

// Показываем уведомления и когда приложение открыто (по умолчанию Expo глушит
// их на переднем плане). Ставится один раз при импорте модуля.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
})

const ANDROID_CHANNEL_ID = 'default'

// projectId нужен getExpoPushTokenAsync вне EAS-сборки. В EAS-сборке и
// залинкованном Expo Go он берётся из app.json (extra.eas.projectId, см.
// README). Для дев-клиента без линковки задайте EXPO_PUBLIC_PROJECT_ID.
const PROJECT_ID = process.env.EXPO_PUBLIC_PROJECT_ID?.trim() || undefined

// Кешируем полученный Expo push-токен, чтобы отзыв при выходе не делал лишний
// сетевой запрос к серверам Expo.
let cachedPushToken: string | null = null

/**
 * Запрашивает разрешение на уведомления, настраивает Android-канал, получает
 * Expo push-токен и регистрирует его в бэкенде. Любые сбои (эмулятор,
 * ограничения Expo Go, отсутствие projectId) проглатываются — push не критичен
 * для работы приложения.
 */
export async function registerForPush(api: ApiClient): Promise<void> {
  try {
    await ensureAndroidChannel()

    const existing = await Notifications.getPermissionsAsync()
    let status = existing.status
    if (status !== 'granted') {
      const requested = await Notifications.requestPermissionsAsync()
      status = requested.status
    }
    if (status !== 'granted') return

    const token = await fetchPushToken()
    cachedPushToken = token
    await api.registerDevice(token, Platform.OS === 'ios' ? 'ios' : 'android')
  } catch {
    // Устройство/окружение без поддержки push — пропускаем молча.
  }
}

/**
 * Отзывает push-токен устройства в бэкенде (при выходе из аккаунта), чтобы на
 * это устройство не приходили уведомления вышедшего пользователя. Сбои
 * проглатываются — выход не должен падать из-за push.
 */
export async function unregisterForPush(api: ApiClient): Promise<void> {
  try {
    const token = cachedPushToken ?? (await fetchPushToken())
    await api.unregisterDevice(token)
    cachedPushToken = null
  } catch {
    // Нет токена/сети — отзыв не критичен.
  }
}

async function fetchPushToken(): Promise<string> {
  const tokenData = await Notifications.getExpoPushTokenAsync(
    PROJECT_ID ? { projectId: PROJECT_ID } : undefined,
  )
  return tokenData.data
}

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return
  // Без канала Android не покажет уведомление с нужной важностью.
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
    name: 'Уведомления',
    importance: Notifications.AndroidImportance.DEFAULT,
  })
}
