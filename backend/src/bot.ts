import 'dotenv/config'

import { createCatalogProviders } from './catalog/factory'
import { CatalogService } from './catalog/service'
import { createPrisma } from './db'
import { loadEnv } from './env'
import { OrdersService } from './orders/service'
import { TelegramLinkService } from './telegram/service'
import { TelegramBot, type BotMedia } from './bot/bot'
import { HttpTelegramClient } from './bot/telegram'
import { AnthropicVinOcrProvider } from './bot/vin-ocr'
import { WhisperVoiceTranscriber } from './bot/voice-transcribe'

export async function main() {
  const env = loadEnv(Bun.env)

  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error(
      'TELEGRAM_BOT_TOKEN не задан. Создайте бота через @BotFather, добавьте токен в backend/.env и перезапустите.',
    )
    process.exit(1)
  }

  const prisma = createPrisma(env.DATABASE_URL)
  // Единый набор провайдеров (те же, что у API) — один инстанс поставщиков на
  // каталог и корзину, чтобы будущие кэш/лимиты реального API не расходились.
  const providers = createCatalogProviders(env, prisma)
  const catalog = new CatalogService(providers.catalog, providers.suppliers, providers.plates)
  const orders = new OrdersService(prisma, providers.suppliers, undefined, providers.offerResolver)
  const link = new TelegramLinkService(prisma, env.TELEGRAM_BOT_USERNAME)

  // Распознавание вложений включается ключами; без них бот работает как раньше
  // и просто просит прислать данные текстом.
  const media: BotMedia = {
    vinOcr: env.ANTHROPIC_API_KEY
      ? new AnthropicVinOcrProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.VIN_OCR_MODEL })
      : undefined,
    voice: env.OPENAI_API_KEY
      ? new WhisperVoiceTranscriber({ apiKey: env.OPENAI_API_KEY })
      : undefined,
  }
  console.log(
    `Фото-VIN: ${media.vinOcr ? 'включено' : 'выключено (нет ANTHROPIC_API_KEY)'}; ` +
      `голосовые: ${media.voice ? 'включены' : 'выключены (нет OPENAI_API_KEY)'}.`,
  )

  const client = new HttpTelegramClient(env.TELEGRAM_BOT_TOKEN)
  const bot = new TelegramBot(client, catalog, { link, orders }, media)

  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  console.log('Telegram-бот запущен (long-polling). Остановка: Ctrl+C.')
  await bot.runPolling(controller.signal)
  await prisma.$disconnect()
  console.log('Telegram-бот остановлен.')
}

if (import.meta.main) {
  await main()
}
