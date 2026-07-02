import { plateSchema, type TierPick } from '@web-app-demo/contracts'

import type { CatalogService } from '../catalog/service'
import type { OrdersService } from '../orders/service'
import type { TelegramLinkService } from '../telegram/service'
import {
  cartMessage,
  formatVehicle,
  offersMessage,
  ordersMessage,
  partsMessage,
  tierAddKeyboard,
  WELCOME,
} from './formatters'
import type { TelegramClient, TgCallbackQuery, TgMessage, TgUpdate } from './telegram'

const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/

type ChatSession = {
  vin?: string
  /** Карта oemNumber → название запчасти из последнего поиска. */
  parts?: Record<string, string>
  /**
   * Контекст выдачи предложений по каждому OEM (для кнопок «в корзину»).
   * Ключ — oemNumber, поэтому нажатие кнопки на старом сообщении добавит именно
   * ту запчасть, а не последнюю показанную.
   */
  offers?: Record<string, { oemNumber: string; partName: string; picks: TierPick[] }>
}

/** Сервисы кабинета — доступны боту, когда аккаунт привязан. */
export type BotCabinet = {
  link: TelegramLinkService
  orders: OrdersService
}

/**
 * Telegram-бот: поиск по VIN/госномеру + кабинет (корзина, заказы) после
 * привязки аккаунта. Переиспользует CatalogService и OrdersService напрямую.
 */
export class TelegramBot {
  private readonly sessions = new Map<number, ChatSession>()

  constructor(
    private readonly client: TelegramClient,
    private readonly catalog: CatalogService,
    private readonly cabinet?: BotCabinet,
  ) {}

  async handleUpdate(update: TgUpdate): Promise<void> {
    if (update.message?.text) {
      await this.handleMessage(update.message)
    } else if (update.callback_query) {
      await this.handleCallback(update.callback_query)
    }
  }

  private session(chatId: number): ChatSession {
    let session = this.sessions.get(chatId)
    if (!session) {
      session = {}
      this.sessions.set(chatId, session)
    }
    return session
  }

  private async handleMessage(message: TgMessage): Promise<void> {
    const chatId = message.chat.id
    const telegramUserId = message.from?.id ?? chatId
    const text = (message.text ?? '').trim()

    if (text.startsWith('/start')) {
      const payload = text.slice('/start'.length).trim()
      if (payload) {
        await this.handleLink(chatId, telegramUserId, payload)
      } else {
        await this.client.sendMessage(chatId, WELCOME, { parseMode: 'HTML' })
      }
      return
    }

    if (text === '/help') {
      await this.client.sendMessage(chatId, WELCOME, { parseMode: 'HTML' })
      return
    }

    const command = text.toLowerCase()
    if (command === '/cart' || command === 'корзина') {
      await this.handleCart(chatId, telegramUserId)
      return
    }
    if (command === '/orders' || command === 'заказы') {
      await this.handleOrders(chatId, telegramUserId)
      return
    }
    if (command === '/checkout' || command === 'оформить') {
      await this.handleCheckout(chatId, telegramUserId)
      return
    }

    const vinCandidate = text.toUpperCase().replace(/\s+/g, '')
    if (VIN_PATTERN.test(vinCandidate)) {
      await this.handleVin(chatId, vinCandidate)
      return
    }

    const plate = plateSchema.safeParse(text)
    if (plate.success) {
      await this.handlePlate(chatId, plate.data)
      return
    }

    await this.handlePartQuery(chatId, text)
  }

  private async handleVin(chatId: number, vin: string): Promise<void> {
    try {
      const { vehicle } = await this.catalog.decodeVin(vin)
      this.session(chatId).vin = vin
      await this.client.sendMessage(chatId, formatVehicle(vehicle), { parseMode: 'HTML' })
    } catch {
      await this.client.sendMessage(
        chatId,
        'Не удалось распознать этот VIN. Проверьте номер (17 символов) и пришлите снова.',
      )
    }
  }

  private async handlePlate(chatId: number, plate: string): Promise<void> {
    try {
      const { vehicle } = await this.catalog.resolvePlate(plate)
      this.session(chatId).vin = vehicle.vin
      await this.client.sendMessage(chatId, formatVehicle(vehicle), { parseMode: 'HTML' })
    } catch {
      await this.client.sendMessage(
        chatId,
        'Автомобиль по этому госномеру не найден. Попробуйте VIN (17 символов).',
      )
    }
  }

  private async handlePartQuery(chatId: number, query: string): Promise<void> {
    const session = this.session(chatId)
    if (!session.vin) {
      await this.client.sendMessage(
        chatId,
        'Сначала пришлите VIN или госномер автомобиля, затем — название запчасти.',
      )
      return
    }

    const { parts } = await this.catalog.searchParts(session.vin, query)
    if (parts.length === 0) {
      await this.client.sendMessage(
        chatId,
        'По этому запросу ничего не найдено. Попробуйте другое название запчасти.',
      )
      return
    }

    session.parts = Object.fromEntries(parts.map((part) => [part.oemNumber, part.name]))
    const { text, keyboard } = partsMessage(parts)
    await this.client.sendMessage(chatId, text, { replyMarkup: keyboard })
  }

  private async handleCallback(callback: TgCallbackQuery): Promise<void> {
    await this.client.answerCallbackQuery(callback.id)
    const chatId = callback.message?.chat.id
    const data = callback.data
    if (chatId === undefined || !data) return

    if (data.startsWith('oem:')) {
      await this.showOffers(chatId, data.slice('oem:'.length))
      return
    }
    if (data.startsWith('add:')) {
      // Формат callback: add:<tier>:<oem>. OEM в кнопке защищает от добавления
      // не той запчасти при нажатии на старое сообщение.
      const rest = data.slice('add:'.length)
      const separator = rest.indexOf(':')
      const tier = separator === -1 ? rest : rest.slice(0, separator)
      const oemNumber = separator === -1 ? undefined : rest.slice(separator + 1)
      await this.addToCart(chatId, callback.from.id, tier, oemNumber)
    }
  }

  private async showOffers(chatId: number, oemNumber: string): Promise<void> {
    const session = this.session(chatId)
    const { picks, offers } = await this.catalog.getOffers(oemNumber)
    const partName = session.parts?.[oemNumber] ?? oemNumber
    ;(session.offers ??= {})[oemNumber] = { oemNumber, partName, picks }
    await this.client.sendMessage(chatId, offersMessage(oemNumber, picks, offers), {
      parseMode: 'HTML',
      replyMarkup: picks.length > 0 ? tierAddKeyboard(picks, oemNumber) : undefined,
    })
  }

  private async addToCart(
    chatId: number,
    telegramUserId: number,
    tier: string,
    oemNumber: string | undefined,
  ): Promise<void> {
    const userId = await this.requireUser(chatId, telegramUserId)
    if (!userId) return

    const offerContext = oemNumber ? this.session(chatId).offers?.[oemNumber] : undefined
    const pick = offerContext?.picks.find((candidate) => candidate.tier === tier)
    if (!offerContext || !pick) {
      await this.client.sendMessage(chatId, 'Сначала выберите запчасть и откройте предложения.')
      return
    }

    await this.cabinet!.orders.addItem(userId, {
      oemNumber: offerContext.oemNumber,
      offerId: pick.offer.id,
      partName: offerContext.partName,
      tier: pick.tier,
      vehicleVin: this.session(chatId).vin,
    })
    await this.client.sendMessage(
      chatId,
      `✅ «${offerContext.partName}» добавлено в корзину. Открыть: /cart`,
    )
  }

  private async handleLink(
    chatId: number,
    telegramUserId: number,
    code: string,
  ): Promise<void> {
    if (!this.cabinet) {
      await this.client.sendMessage(chatId, 'Функции кабинета сейчас недоступны.')
      return
    }
    const userId = await this.cabinet.link.consumeCode(code, BigInt(telegramUserId))
    if (userId) {
      await this.client.sendMessage(
        chatId,
        '✅ Аккаунт привязан! Теперь доступны корзина (/cart) и заказы (/orders).',
      )
    } else {
      await this.client.sendMessage(
        chatId,
        'Код неверный или истёк. Сгенерируйте новый в личном кабинете на сайте.',
      )
    }
  }

  private async handleCart(chatId: number, telegramUserId: number): Promise<void> {
    const userId = await this.requireUser(chatId, telegramUserId)
    if (!userId) return
    const { order } = await this.cabinet!.orders.getCart(userId)
    await this.client.sendMessage(chatId, cartMessage(order), { parseMode: 'HTML' })
  }

  private async handleOrders(chatId: number, telegramUserId: number): Promise<void> {
    const userId = await this.requireUser(chatId, telegramUserId)
    if (!userId) return
    // Пользователь бота — всегда клиент: показываем только его заказы.
    const { orders } = await this.cabinet!.orders.listOrders(userId, 'USER')
    await this.client.sendMessage(chatId, ordersMessage(orders), { parseMode: 'HTML' })
  }

  private async handleCheckout(chatId: number, telegramUserId: number): Promise<void> {
    const userId = await this.requireUser(chatId, telegramUserId)
    if (!userId) return
    try {
      const { order } = await this.cabinet!.orders.checkout(userId)
      await this.client.sendMessage(
        chatId,
        `✅ Заказ оформлен. Оплата — в личном кабинете на сайте.\nСумма: ${formatTotal(order.total)}`,
      )
    } catch {
      await this.client.sendMessage(chatId, 'Корзина пуста — оформлять нечего.')
    }
  }

  /** Возвращает userId привязанного аккаунта или подсказывает привязаться. */
  private async requireUser(chatId: number, telegramUserId: number): Promise<string | null> {
    if (!this.cabinet) {
      await this.client.sendMessage(chatId, 'Функции кабинета сейчас недоступны.')
      return null
    }
    const userId = await this.cabinet.link.resolveUser(BigInt(telegramUserId))
    if (!userId) {
      await this.client.sendMessage(
        chatId,
        'Сначала привяжите аккаунт: в личном кабинете на сайте нажмите «Подключить Telegram» и пришлите сюда /start <код>.',
      )
      return null
    }
    return userId
  }

  /**
   * Запускает long-polling. Обрабатывает обновления по одному; ошибка одного
   * обновления не роняет цикл. Завершается по сигналу abort.
   */
  async runPolling(signal: AbortSignal, pollTimeoutSeconds = 30): Promise<void> {
    let offset = 0
    while (!signal.aborted) {
      let updates: TgUpdate[]
      try {
        updates = await this.client.getUpdates(offset, pollTimeoutSeconds)
      } catch (error) {
        if (signal.aborted) break
        console.error('Ошибка getUpdates:', error)
        await delay(2000)
        continue
      }

      for (const update of updates) {
        offset = update.update_id + 1
        try {
          await this.handleUpdate(update)
        } catch (error) {
          console.error('Ошибка обработки обновления:', error)
        }
      }
    }
  }
}

function formatTotal(total: { amount: number; currency: string }): string {
  const rub = Math.round(total.amount / 100)
  return `${rub.toLocaleString('ru-RU')} ₽`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
