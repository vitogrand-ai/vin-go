import 'dotenv/config'

import { createCatalogProviders } from './catalog/factory'
import { CatalogService } from './catalog/service'
import { createPrisma } from './db'
import { loadEnv } from './env'
import { ExpertsService } from './experts/service'
import { GarageService } from './garage/service'
import { OrdersService } from './orders/service'
import { TelegramLinkService } from './telegram/service'
import { TelegramBot, type BotMedia } from './bot/bot'
import { PrismaSessionStore } from './bot/session-store'
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
  const catalog = new CatalogService(
    providers.catalog,
    providers.suppliers,
    providers.plates,
    providers.meta,
    providers.dealerPrices,
  )
  const orders = new OrdersService(prisma, providers.suppliers, undefined, providers.offerResolver)
  const link = new TelegramLinkService(prisma, env.TELEGRAM_BOT_USERNAME)
  // Ответ эксперта приходит из API-процесса (там же уведомления); бот только создаёт заявки.
  const experts = new ExpertsService(prisma, providers.catalog)
  const garage = new GarageService(prisma, providers.catalog)

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
  const bot = new TelegramBot(
    client,
    catalog,
    { link, orders, experts, garage },
    media,
    new PrismaSessionStore(prisma),
  )

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
