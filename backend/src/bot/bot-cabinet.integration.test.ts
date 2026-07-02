import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { MockSupplierProvider } from '../catalog/mock-providers'
import { createMockCatalogService } from '../catalog/service'
import { createPrisma } from '../db'
import { OrdersService } from '../orders/service'
import { TelegramLinkService } from '../telegram/service'
import { TelegramBot } from './bot'
import type { SendMessageOptions, TelegramClient, TgUpdate } from './telegram'

const databaseUrl = process.env.TEST_DATABASE_URL
const maybeDescribe = databaseUrl ? describe : describe.skip

const CHAT = 778899
const DEMO_VIN = 'WVWZZZ1JZ3W386752'

class FakeTelegramClient implements TelegramClient {
  readonly sent: { chatId: number; text: string }[] = []
  async getUpdates(): Promise<TgUpdate[]> {
    return []
  }
  async sendMessage(chatId: number, text: string, _options?: SendMessageOptions): Promise<void> {
    this.sent.push({ chatId, text })
  }
  async answerCallbackQuery(): Promise<void> {}
  lastText(): string {
    return this.sent.at(-1)?.text ?? ''
  }
}

let uid = 0
function msg(text: string, chat = CHAT): TgUpdate {
  uid += 1
  return { update_id: uid, message: { message_id: uid, chat: { id: chat }, from: { id: chat }, text } }
}
function cb(data: string, chat = CHAT): TgUpdate {
  uid += 1
  return {
    update_id: uid,
    callback_query: {
      id: `cb${uid}`,
      from: { id: chat },
      message: { message_id: uid, chat: { id: chat } },
      data,
    },
  }
}

maybeDescribe('Telegram-бот: привязка и кабинет', () => {
  const prisma = createPrisma(databaseUrl!)
  const link = new TelegramLinkService(prisma)
  const orders = new OrdersService(prisma, new MockSupplierProvider())

  async function reset() {
    await prisma.refund.deleteMany()
    await prisma.payment.deleteMany()
    await prisma.orderItem.deleteMany()
    await prisma.order.deleteMany()
    await prisma.telegramLinkCode.deleteMany()
    await prisma.telegramAccount.deleteMany()
    await prisma.authSession.deleteMany()
    await prisma.user.deleteMany()
  }

  function makeBot() {
    return { client: new FakeTelegramClient() }
  }

  beforeEach(reset)
  afterAll(reset)

  test('привязка по коду и полный путь: поиск → в корзину → /cart → /checkout → /orders', async () => {
    const user = await prisma.user.create({
      data: { email: 'tg@example.com', passwordHash: 'x' },
    })
    const { code } = await link.createLinkCode(user.id)

    const { client } = makeBot()
    const bot = new TelegramBot(client, createMockCatalogService(), { link, orders })

    // Привязка.
    await bot.handleUpdate(msg(`/start ${code}`))
    expect(client.lastText()).toContain('привязан')
    expect(await link.resolveUser(BigInt(CHAT))).toBe(user.id)

    // Поиск: VIN → запчасть → предложения.
    await bot.handleUpdate(msg(DEMO_VIN))
    await bot.handleUpdate(msg('колодки'))
    await bot.handleUpdate(cb('oem:1J0698151'))

    // В корзину (эконом-тир).
    await bot.handleUpdate(cb('add:ECONOMY'))
    expect(client.lastText()).toContain('добавлено в корзину')

    const cart = await orders.getCart(user.id)
    expect(cart.order?.items).toHaveLength(1)

    // /cart показывает позицию.
    await bot.handleUpdate(msg('/cart'))
    expect(client.lastText()).toContain('Корзина')

    // /checkout оформляет заказ.
    await bot.handleUpdate(msg('/checkout'))
    expect(client.lastText()).toContain('Заказ оформлен')

    // /orders показывает заказ.
    await bot.handleUpdate(msg('/orders'))
    expect(client.lastText()).toContain('№')
  })

  test('без привязки добавление в корзину просит привязать аккаунт', async () => {
    const { client } = makeBot()
    const bot = new TelegramBot(client, createMockCatalogService(), { link, orders })

    await bot.handleUpdate(cb('add:ECONOMY', 111222))
    expect(client.lastText()).toContain('привяжите аккаунт')
  })

  test('неверный код привязки отклоняется', async () => {
    const { client } = makeBot()
    const bot = new TelegramBot(client, createMockCatalogService(), { link, orders })

    await bot.handleUpdate(msg('/start WRONGCODE'))
    expect(client.lastText()).toContain('Код неверный')
  })
})
