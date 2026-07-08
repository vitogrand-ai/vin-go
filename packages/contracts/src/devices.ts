import { z } from 'zod'

/** Регистрация push-токена устройства (Expo). */
export const registerDeviceRequestSchema = z.object({
  token: z.string().trim().min(1).max(255),
  platform: z.enum(['ios', 'android']).optional(),
})

export type RegisterDeviceRequest = z.infer<typeof registerDeviceRequestSchema>

/** Отзыв push-токена (при выходе из аккаунта на устройстве). */
export const unregisterDeviceRequestSchema = z.object({
  token: z.string().trim().min(1).max(255),
})

export type UnregisterDeviceRequest = z.infer<typeof unregisterDeviceRequestSchema>
