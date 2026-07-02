import { beforeEach, describe, expect, test } from 'bun:test'

import { createMockCatalogService } from '../catalog/service'
import { TelegramBot } from './bot'
import type { SendMessageOptions, TelegramClient, TgUpdate } from './telegram'

type SentMessage = { chatId: number; text: string; options?: SendMessageOptions }

class FakeTelegramClient implements TelegramClient {
  readonly sent: SentMessage[] = []
  readonly answered: string[] = []

  async getUpdates(): Promise<TgUpdate[]> {
    return []
  }

  async sendMessage(chatId: number, text: string, options?: SendMessageOptions): Promise<void> {
    this.sent.push({ chatId, text, options })
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    this.answered.push(callbackQueryId)
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
})
