import { beforeEach, describe, expect, test } from 'bun:test'

import type { Part, Vehicle } from '@web-app-demo/contracts'

import { MockPlateProvider, MockSupplierProvider } from '../catalog/mock-providers'
import { CatalogService, createMockCatalogService } from '../catalog/service'
import { TelegramBot } from './bot'
import type { SendMessageOptions, SendPhotoOptions, TelegramClient, TgUpdate } from './telegram'

type SentMessage = { chatId: number; text: string; options?: SendMessageOptions }
type SentPhoto = { chatId: number; photoUrl: string; options?: SendPhotoOptions }
type SentDocument = { chatId: number; fileUrl: string; options?: SendPhotoOptions }

class FakeTelegramClient implements TelegramClient {
  readonly sent: SentMessage[] = []
  readonly sentPhotos: SentPhoto[] = []
  readonly sentDocuments: SentDocument[] = []
  readonly answered: string[] = []

  async getUpdates(): Promise<TgUpdate[]> {
    return []
  }

  async sendMessage(chatId: number, text: string, options?: SendMessageOptions): Promise<void> {
    this.sent.push({ chatId, text, options })
  }

  async sendPhoto(chatId: number, photoUrl: string, options?: SendPhotoOptions): Promise<void> {
    this.sentPhotos.push({ chatId, photoUrl, options })
  }

  /** Схема файлом по кнопке «крупнее» — учитываем отдельно от сжатого фото. */
  async sendDocument(chatId: number, fileUrl: string, options?: SendPhotoOptions): Promise<void> {
    this.sentDocuments.push({ chatId, fileUrl, options })
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    this.answered.push(callbackQueryId)
  }

  /** Файлы по умолчанию недоступны — тесты вложений подменяют этот метод. */
  async downloadFile(): Promise<Uint8Array | null> {
    return null
  }
}

const CHAT_ID = 42
const DEMO_VIN = 'WVWZZZ1JZ3W386752'

function messageUpdate(text: string): TgUpdate {
  return {
    update_id: 1,
    message: { message_id: 1, chat: { id: CHAT_ID }, text },
  }
}

/** Нажатие inline-кнопки в том же чате. */
function callbackUpdate(data: string): TgUpdate {
  return {
    update_id: 2,
    callback_query: {
      id: 'cb-1',
      from: { id: 555 },
      message: { message_id: 2, chat: { id: CHAT_ID } },
      data,
    },
  }
}

describe('TelegramBot', () => {
  let client: FakeTelegramClient
  let bot: TelegramBot

  beforeEach(() => {
    client = new FakeTelegramClient()
    bot = new TelegramBot(client, createMockCatalogService())
  })

  test('/start присылает приветствие', async () => {
    await bot.handleUpdate(messageUpdate('/start'))
    expect(client.sent).toHaveLength(1)
    expect(client.sent[0]?.text).toContain('подобрать автозапчасти')
  })

  test('запрос запчасти без VIN просит сначала прислать VIN', async () => {
    await bot.handleUpdate(messageUpdate('колодки'))
    expect(client.sent[0]?.text).toContain('Сначала пришлите VIN')
  })

  test('VIN распознаётся и присылается карточка авто', async () => {
    await bot.handleUpdate(messageUpdate(DEMO_VIN))
    expect(client.sent[0]?.text).toContain('Volkswagen')
    expect(client.sent[0]?.text).toContain(DEMO_VIN)
  })

  test('после VIN запрос запчасти возвращает список с кнопками', async () => {
    await bot.handleUpdate(messageUpdate(DEMO_VIN))
    await bot.handleUpdate(messageUpdate('колодки'))

    const last = client.sent.at(-1)
    expect(last?.text).toContain('Найдено запчастей')
    const keyboard = last?.options?.replyMarkup?.inline_keyboard
    expect(keyboard?.length).toBeGreaterThan(0)
    expect(keyboard?.[0]?.[0]?.callback_data).toStartWith('oem:')
  })

  test('госномер распознаётся и присылается карточка авто', async () => {
    await bot.handleUpdate(messageUpdate('А123ВС777'))
    expect(client.sent[0]?.text).toContain('Volkswagen')
    expect(client.sent[0]?.text).toContain(DEMO_VIN)
  })

  test('callback с OEM-номером присылает три тира', async () => {
    await bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: 'cb1',
        from: { id: CHAT_ID },
        message: { message_id: 5, chat: { id: CHAT_ID } },
        data: 'oem:1J0698151',
      },
    })

    expect(client.answered).toContain('cb1')
    const last = client.sent.at(-1)?.text ?? ''
    expect(last).toContain('Эконом')
    expect(last).toContain('Оптимальный')
    expect(last).toContain('Оригинал')
  })

  test('некорректный VIN не сохраняется как авто', async () => {
    await bot.handleUpdate(messageUpdate('ABC123'))
    // 'ABC123' не VIN и трактуется как запрос запчасти без сохранённого VIN
    expect(client.sent[0]?.text).toContain('Сначала пришлите VIN')
  })

  test('деталь со схемой уходит фотографией с той же клавиатурой', async () => {
    const vehicle: Vehicle = {
      vin: DEMO_VIN,
      make: 'Volkswagen',
      model: 'Golf',
      year: 2003,
      engine: null,
      bodyType: null,
    }
    const part: Part = {
      oemNumber: '1J0698151',
      name: 'Колодки тормозные',
      category: 'Тормоза',
      brand: 'VW',
      imageUrl: 'https://img.example.com/schema.png',
    }
    const catalog = new CatalogService(
      {
        decodeVin: async () => vehicle,
        searchParts: async () => [part],
      },
      new MockSupplierProvider(),
      new MockPlateProvider(),
    )
    const photoBot = new TelegramBot(client, catalog)

    await photoBot.handleUpdate(messageUpdate(DEMO_VIN))
    await photoBot.handleUpdate(messageUpdate('колодки'))

    const photo = client.sentPhotos.at(-1)
    expect(photo?.photoUrl).toBe('https://img.example.com/schema.png')
    expect(photo?.options?.caption).toContain('Найдено запчастей')
    expect(photo?.options?.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe(
      'oem:1J0698151',
    )
  })

  /**
   * Схема приходит сжатым фото, а на ней подписаны номера позиций — ради них
   * мастер её и открывает. Кнопка шлёт ту же схему документом: Telegram его не пережимает.
   */
  test('кнопка «схема крупнее» шлёт её файлом, а не сжатым фото', async () => {
    const vehicle: Vehicle = {
      vin: DEMO_VIN,
      make: 'Volkswagen',
      model: 'Golf',
      year: 2003,
      engine: null,
      bodyType: null,
    }
    const part: Part = {
      oemNumber: '1J0698151',
      name: 'Колодки тормозные',
      category: 'Тормоза',
      brand: 'VW',
      imageUrl: 'https://img.example.com/schema.png',
    }
    const catalog = new CatalogService(
      { decodeVin: async () => vehicle, searchParts: async () => [part] },
      new MockSupplierProvider(),
      new MockPlateProvider(),
    )
    const schemeBot = new TelegramBot(client, catalog)

    await schemeBot.handleUpdate(messageUpdate(DEMO_VIN))
    await schemeBot.handleUpdate(messageUpdate('колодки'))
    await schemeBot.handleUpdate(callbackUpdate('scheme'))

    const document = client.sentDocuments.at(-1)
    expect(document?.fileUrl).toBe('https://img.example.com/schema.png')
    expect(document?.options?.caption).toContain('исходном размере')
  })

  test('без схемы в выдаче кнопки нет, а нажатие после перезапуска не падает', async () => {
    const vehicle: Vehicle = {
      vin: DEMO_VIN,
      make: 'Volkswagen',
      model: 'Golf',
      year: 2003,
      engine: null,
      bodyType: null,
    }
    const part: Part = {
      oemNumber: '1J0698151',
      name: 'Колодки тормозные',
      category: 'Тормоза',
      brand: 'VW',
      imageUrl: null,
    }
    const catalog = new CatalogService(
      { decodeVin: async () => vehicle, searchParts: async () => [part] },
      new MockSupplierProvider(),
      new MockPlateProvider(),
    )
    const plainBot = new TelegramBot(client, catalog)

    await plainBot.handleUpdate(messageUpdate(DEMO_VIN))
    await plainBot.handleUpdate(messageUpdate('колодки'))

    const listing = client.sent.at(-1)
    expect(listing?.options?.replyMarkup?.inline_keyboard?.length).toBe(1)

    // Сессия без схемы (истекла или бот перезапускался) — отвечаем подсказкой, не падаем.
    await plainBot.handleUpdate(callbackUpdate('scheme'))

    expect(client.sentDocuments).toHaveLength(0)
    expect(client.sent.at(-1)?.text).toContain('Схема не найдена')
  })

  test('сбой отправки фото не теряет выдачу — уходит текстом', async () => {
    const vehicle: Vehicle = {
      vin: DEMO_VIN,
      make: 'Volkswagen',
      model: 'Golf',
      year: 2003,
      engine: null,
      bodyType: null,
    }
    const part: Part = {
      oemNumber: '1J0698151',
      name: 'Колодки тормозные',
      category: 'Тормоза',
      brand: 'VW',
      imageUrl: 'https://img.example.com/broken.png',
    }
    client.sendPhoto = async () => {
      throw new Error('Telegram sendPhoto: wrong file identifier')
    }
    const catalog = new CatalogService(
      {
        decodeVin: async () => vehicle,
        searchParts: async () => [part],
      },
      new MockSupplierProvider(),
      new MockPlateProvider(),
    )
    const photoBot = new TelegramBot(client, catalog)

    await photoBot.handleUpdate(messageUpdate(DEMO_VIN))
    await photoBot.handleUpdate(messageUpdate('колодки'))

    const last = client.sent.at(-1)
    expect(last?.text).toContain('Найдено запчастей')
    // Деталь плюс кнопка схемы: сбой фото бывает разовым, и по кнопке схема всё равно доступна.
    expect(last?.options?.replyMarkup?.inline_keyboard?.length).toBe(2)
    expect(last?.options?.replyMarkup?.inline_keyboard?.at(-1)?.[0]?.callback_data).toBe('scheme')
  })
})
