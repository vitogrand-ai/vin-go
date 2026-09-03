import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { MockCatalogProvider, MockSupplierProvider } from '../catalog/mock-providers'
import { createMockCatalogService } from '../catalog/service'
import { createPrisma } from '../db'
import { ExpertsService } from '../experts/service'
import { GarageService } from '../garage/service'
import { OrdersService } from '../orders/service'
import { TelegramLinkService } from '../telegram/service'
import { TelegramBot } from './bot'
import { PrismaSessionStore } from './session-store'
import type { InlineKeyboard, SendMessageOptions, TelegramClient, TgUpdate } from './telegram'

const databaseUrl = process.env.TEST_DATABASE_URL
const maybeDescribe = databaseUrl ? describe : describe.skip

const CHAT = 778899
const DEMO_VIN = 'WVWZZZ1JZ3W386752'

class FakeTelegramClient implements TelegramClient {
  readonly sent: { chatId: number; text: string; keyboard?: InlineKeyboard }[] = []
  async getUpdates(): Promise<TgUpdate[]> {
    return []
  }
  async sendMessage(chatId: number, text: string, options?: SendMessageOptions): Promise<void> {
    this.sent.push({ chatId, text, keyboard: options?.replyMarkup })
  }
  /** В сценариях кабинета схемы не шлются — фото учитывается как обычный текст. */
  async sendPhoto(chatId: number, _photoUrl: string): Promise<void> {
    this.sent.push({ chatId, text: '[фото]' })
  }
  async answerCallbackQuery(): Promise<void> {}
  /** Вложения в сценариях кабинета не используются. */
  async downloadFile(): Promise<Uint8Array | null> {
    return null
  }
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
    await prisma.expertRequest.deleteMany()
    await prisma.vehicle.deleteMany()
    await prisma.botSession.deleteMany()
    await prisma.telegramLinkCode.deleteMany()
    await prisma.telegramAccount.deleteMany()
    await prisma.authSession.deleteMany()
    await prisma.user.deleteMany()
    await prisma.organization.deleteMany()
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

    // В корзину (эконом-тир) — callback несёт OEM.
    await bot.handleUpdate(cb('add:ECONOMY:1J0698151'))
    expect(client.lastText()).toContain('добавлено в корзину')

    // Пользователь заведён без организации — бот создал её при первом обращении.
    const actor = (await link.resolveActor(BigInt(CHAT)))!
    expect(actor.userId).toBe(user.id)
    const cart = await orders.getCart(actor)
    expect(cart.order?.items).toHaveLength(1)

    // /cart показывает позицию.
    await bot.handleUpdate(msg('/cart'))
    expect(client.lastText()).toContain('Корзина')

    // /checkout оформляет заказ.
    await bot.handleUpdate(msg('/checkout'))
    expect(client.lastText()).toContain('оформлен')

    // /orders показывает заказ.
    await bot.handleUpdate(msg('/orders'))
    expect(client.lastText()).toContain('№')
  })

  test('кнопка «в корзину» на старом сообщении добавляет свою запчасть, а не последнюю', async () => {
    const user = await prisma.user.create({
      data: { email: 'stale@example.com', passwordHash: 'x' },
    })
    const { code } = await link.createLinkCode(user.id)
    const { client } = makeBot()
    const bot = new TelegramBot(client, createMockCatalogService(), { link, orders })
    await bot.handleUpdate(msg(`/start ${code}`))

    // Показываем предложения по двум разным запчастям (последняя — диск).
    await bot.handleUpdate(cb('oem:1J0698151')) // колодки
    await bot.handleUpdate(cb('oem:1K0615301AA')) // диск

    // Нажимаем «в корзину» на кнопке ПЕРВОЙ запчасти (старое сообщение).
    await bot.handleUpdate(cb('add:ECONOMY:1J0698151'))

    const cart = await orders.getCart((await link.resolveActor(BigInt(CHAT)))!)
    expect(cart.order?.items).toHaveLength(1)
    expect(cart.order?.items[0]?.oemNumber).toBe('1J0698151')
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

  test('сессия чата переживает перезапуск бота: VIN не нужно присылать заново', async () => {
    const store = new PrismaSessionStore(prisma)

    const first = new TelegramBot(new FakeTelegramClient(), createMockCatalogService(), undefined, {}, store)
    await first.handleUpdate(msg(DEMO_VIN))

    // «Новый процесс»: другой экземпляр бота с пустой памятью, но тем же хранилищем.
    const client = new FakeTelegramClient()
    const second = new TelegramBot(client, createMockCatalogService(), undefined, {}, store)
    await second.handleUpdate(msg('колодки'))
    expect(client.lastText()).toContain('Найдено запчастей')
  })

  test('/garage показывает машины автосервиса кнопками, выбор подставляет VIN', async () => {
    const user = await prisma.user.create({ data: { email: 'garage@example.com', passwordHash: 'x' } })
    const { code } = await link.createLinkCode(user.id)
    const garage = new GarageService(prisma, new MockCatalogProvider())
    const { client } = makeBot()
    const bot = new TelegramBot(client, createMockCatalogService(), { link, orders, garage })
    await bot.handleUpdate(msg(`/start ${code}`))

    const actor = (await link.resolveActor(BigInt(CHAT)))!
    await garage.add(actor, { vin: DEMO_VIN, plate: 'а123вс777', nickname: 'Гольф Петрова' })

    await bot.handleUpdate(msg('/garage'))
    const buttons = client.sent.at(-1)?.keyboard?.inline_keyboard.flat() ?? []
    expect(buttons.map((button) => button.text)).toContain('А123ВС777 · Гольф Петрова')
    expect(buttons[0]?.callback_data).toBe(`car:${DEMO_VIN}`)

    await bot.handleUpdate(cb(`car:${DEMO_VIN}`))
    expect(client.lastText()).toContain('Volkswagen')

    // VIN в сессии — поиск детали работает без повторного ввода.
    await bot.handleUpdate(msg('колодки'))
    expect(client.lastText()).toContain('Найдено запчастей')
  })

  test('пустая выдача предлагает спросить эксперта и создаёт заявку', async () => {
    const user = await prisma.user.create({ data: { email: 'expert@example.com', passwordHash: 'x' } })
    const { code } = await link.createLinkCode(user.id)
    const experts = new ExpertsService(prisma, new MockCatalogProvider())
    const { client } = makeBot()
    const bot = new TelegramBot(client, createMockCatalogService(), { link, orders, experts })
    await bot.handleUpdate(msg(`/start ${code}`))

    await bot.handleUpdate(msg(DEMO_VIN))
    await bot.handleUpdate(msg('квазитрон'))
    expect(client.lastText()).toContain('эксперту')
    const buttons = client.sent.at(-1)?.keyboard?.inline_keyboard.flat() ?? []
    expect(buttons[0]?.callback_data).toBe('expert:ask')

    await bot.handleUpdate(cb('expert:ask'))
    expect(client.lastText()).toContain('отправлена эксперту')

    const requests = await prisma.expertRequest.findMany()
    expect(requests).toHaveLength(1)
    expect(requests[0]?.query).toBe('квазитрон')
    expect(requests[0]?.vin).toBe(DEMO_VIN)
  })
})
