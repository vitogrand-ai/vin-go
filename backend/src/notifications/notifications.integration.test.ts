import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { MockSupplierProvider } from '../catalog/mock-providers'
import { createPrisma } from '../db'
import { DeviceService } from '../devices/service'
import { OrdersService } from '../orders/service'
import { MockPaymentProvider } from '../payments/providers'
import { PaymentService } from '../payments/service'
import { NotificationService, type PushSend, type TelegramSend } from './service'

const databaseUrl = process.env.TEST_DATABASE_URL
const maybeDescribe = databaseUrl ? describe : describe.skip

maybeDescribe('NotificationService', () => {
  const prisma = createPrisma(databaseUrl!)

  const pushCalls: { tokens: string[]; title: string; body: string }[] = []
  const tgCalls: { chatId: string; text: string }[] = []
  const pushSend: PushSend = async (tokens, title, body) => {
    pushCalls.push({ tokens, title, body })
    return { invalidTokens: [] }
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
    await prisma.organization.deleteMany()
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
    const org = await prisma.organization.create({ data: { name: 'СТО', inviteCode: 'NOTIF001' } })
    const user = await prisma.user.create({
      data: { email: 's@example.com', passwordHash: 'x', orgId: org.id, orgRole: 'OWNER' },
    })
    await prisma.deviceToken.create({ data: { userId: user.id, token: 'ExponentPushToken[xyz]' } })
    const order = await prisma.order.create({
      data: { userId: user.id, orgId: org.id, status: 'PAID', currency: 'RUB' },
    })

    const notifications = new NotificationService(prisma, { pushSend, telegramSend })
    const orders = new OrdersService(prisma, new MockSupplierProvider(), notifications)
    // Переход PAID → PROCESSING — операторский (оператор платформы).
    await orders.updateStatus(
      { userId: user.id, orgId: org.id, role: 'OPERATOR', orgRole: 'OWNER' },
      order.id,
      'PROCESSING',
    )

    expect(pushCalls).toHaveLength(1)
    expect(pushCalls[0]?.title).toBe('Статус заказа изменён')
  })

  test('оплата заказа (PLACED → PAID) уведомляет владельца', async () => {
    const user = await prisma.user.create({ data: { email: 'pay@example.com', passwordHash: 'x' } })
    await prisma.deviceToken.create({ data: { userId: user.id, token: 'ExponentPushToken[pay]' } })
    const order = await prisma.order.create({
      data: { userId: user.id, status: 'PLACED', currency: 'RUB' },
    })
    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        userId: user.id,
        provider: 'mock',
        status: 'PENDING',
        amount: 1000,
        currency: 'RUB',
      },
    })

    const notifications = new NotificationService(prisma, { pushSend, telegramSend })
    const payments = new PaymentService(
      prisma,
      new MockPaymentProvider(),
      { webappOrigin: 'http://localhost:5173', returnUrl: 'http://localhost:5173/orders' },
      notifications,
    )
    // confirmMock двигает PLACED → PAID и должен уведомить владельца.
    await payments.confirmMock(user.id, payment.id)

    expect(pushCalls).toHaveLength(1)
    expect(pushCalls[0]?.title).toBe('Статус заказа изменён')
    expect(pushCalls[0]?.body).toContain('оплачен')
  })

  test('невалидный push-токен удаляется после отправки', async () => {
    const user = await prisma.user.create({ data: { email: 'dead@example.com', passwordHash: 'x' } })
    await prisma.deviceToken.create({
      data: { userId: user.id, token: 'ExponentPushToken[dead]' },
    })

    const notifications = new NotificationService(prisma, {
      pushSend: async () => ({ invalidTokens: ['ExponentPushToken[dead]'] }),
    })
    await notifications.notifyUser(user.id, 'Заголовок', 'Текст')

    const remaining = await prisma.deviceToken.count({ where: { userId: user.id } })
    expect(remaining).toBe(0)
  })

  test('unregister удаляет только указанный токен пользователя', async () => {
    const user = await prisma.user.create({ data: { email: 'unreg@example.com', passwordHash: 'x' } })
    await prisma.deviceToken.create({
      data: { userId: user.id, token: 'ExponentPushToken[keep]' },
    })
    await prisma.deviceToken.create({
      data: { userId: user.id, token: 'ExponentPushToken[drop]' },
    })

    const devices = new DeviceService(prisma)
    await devices.unregister(user.id, 'ExponentPushToken[drop]')

    const tokens = await prisma.deviceToken.findMany({
      where: { userId: user.id },
      select: { token: true },
    })
    expect(tokens.map((item) => item.token)).toEqual(['ExponentPushToken[keep]'])
  })
})
