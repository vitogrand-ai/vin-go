import { z } from 'zod'

/** Регистрация push-токена устройства (Expo). */
export const registerDeviceRequestSchema = z.object({
  token: z.string().trim().min(1).max(255),
  platform: z.enum(['ios', 'android']).optional(),
})

export type RegisterDeviceRequest = z.infer<typeof registerDeviceRequestSchema>
