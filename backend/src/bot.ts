import 'dotenv/config'

import { createCatalogProviders } from './catalog/factory'
import { CatalogService } from './catalog/service'
import { createPrisma } from './db'
import { loadEnv } from './env'
import { OrdersService } from './orders/service'
import { TelegramLinkService } from './telegram/service'
import { TelegramBot } from './bot/bot'
import { HttpTelegramClient } from './bot/telegram'

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
  const providers = createCatalogProviders(env)
  const catalog = new CatalogService(providers.catalog, providers.suppliers, providers.plates)
  const orders = new OrdersService(prisma, providers.suppliers, undefined, providers.offerResolver)
  const link = new TelegramLinkService(prisma, env.TELEGRAM_BOT_USERNAME)

  const client = new HttpTelegramClient(env.TELEGRAM_BOT_TOKEN)
  const bot = new TelegramBot(client, catalog, { link, orders })

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
