import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { MockSupplierProvider } from '../catalog/mock-providers'
import { createPrisma } from '../db'
import { OrdersService } from '../orders/service'
import { NotificationService, type PushSend, type TelegramSend } from './service'

const databaseUrl = process.env.TEST_DATABASE_URL
const maybeDescribe = databaseUrl ? describe : describe.skip

maybeDescribe('NotificationService', () => {
  const prisma = createPrisma(databaseUrl!)

  const pushCalls: { tokens: string[]; title: string }[] = []
  const tgCalls: { chatId: string; text: string }[] = []
  const pushSend: PushSend = async (tokens, title) => {
    pushCalls.push({ tokens, title })
  }
  const telegramSend: TelegramSend = async (chatId, text) => {
    tgCalls.push({ chatId, text })
  }

  async function reset() {
    pushCalls.length = 0
    tgCalls.length = 0
    await prisma.payment.deleteMany()
    await prisma.orderItem.deleteMany()
    await prisma.order.deleteMany()
    await prisma.deviceToken.deleteMany()
    await prisma.telegramAccount.deleteMany()
    await prisma.authSession.deleteMany()
    await prisma.user.deleteMany()
  }

  beforeEach(reset)
  afterAll(reset)

  test('notifyUser шлёт в Telegram и на устройства пользователя', async () => {
    const user = await prisma.user.create({ data: { email: 'n@example.com', passwordHash: 'x' } })
    await prisma.telegramAccount.create({
      data: { userId: user.id, telegramUserId: BigInt(424242) },
    })
    await prisma.deviceToken.create({ data: { userId: user.id, token: 'ExponentPushToken[abc]' } })

    const notifications = new NotificationService(prisma, { pushSend, telegramSend })
    await notifications.notifyUser(user.id, 'Заголовок', 'Текст')

    expect(tgCalls).toHaveLength(1)
    expect(tgCalls[0]?.chatId).toBe('424242')
    expect(tgCalls[0]?.text).toBe('Заголовок\nТекст')
    expect(pushCalls).toHaveLength(1)
    expect(pushCalls[0]?.tokens).toEqual(['ExponentPushToken[abc]'])
  })

  test('без каналов notifyUser ничего не шлёт и не падает', async () => {
    const user = await prisma.user.create({ data: { email: 'q@example.com', passwordHash: 'x' } })
    const notifications = new NotificationService(prisma, { pushSend, telegramSend })
    await notifications.notifyUser(user.id, 'A', 'B')
    expect(tgCalls).toHaveLength(0)
    expect(pushCalls).toHaveLength(0)
  })

  test('смена статуса заказа триггерит уведомление', async () => {
    const user = await prisma.user.create({ data: { email: 's@example.com', passwordHash: 'x' } })
    await prisma.deviceToken.create({ data: { userId: user.id, token: 'ExponentPushToken[xyz]' } })
    const order = await prisma.order.create({
      data: { userId: user.id, status: 'PAID', currency: 'RUB' },
    })

    const notifications = new NotificationService(prisma, { pushSend, telegramSend })
    const orders = new OrdersService(prisma, new MockSupplierProvider(), notifications)
    // Переход PAID → PROCESSING — операторский.
    await orders.updateStatus(user.id, 'OPERATOR', order.id, 'PROCESSING')

    expect(pushCalls).toHaveLength(1)
    expect(pushCalls[0]?.title).toBe('Статус заказа изменён')
  })
})
