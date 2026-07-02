import { z } from 'zod'

/** Ответ на запрос кода привязки Telegram. */
export const telegramLinkCodeResponseSchema = z.object({
  code: z.string(),
  /** Готовая ссылка t.me/<bot>?start=<code>; null, если имя бота не задано. */
  deepLink: z.string().nullable(),
  expiresAt: z.string().datetime(),
})

export const telegramStatusResponseSchema = z.object({
  linked: z.boolean(),
})

export type TelegramLinkCodeResponse = z.infer<typeof telegramLinkCodeResponseSchema>
export type TelegramStatusResponse = z.infer<typeof telegramStatusResponseSchema>
