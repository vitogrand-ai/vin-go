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

  /** «Печатает…» на время долгого поиска — в утверждениях тестов не участвует. */
  async sendChatAction(): Promise<void> {}

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

  /**
   * Живой случай пилота: мастер ищет «фара», получает схему узла и видит на ней
   * нужный жгут проводов под номером 9. Названия жгута он не знает — присылает
   * номер.
   */
  describe('номер с картинки вместо названия', () => {
    const vehicle: Vehicle = {
      vin: DEMO_VIN,
      make: 'Skoda',
      model: 'Kodiaq',
      year: 2020,
      engine: null,
      bodyType: null,
    }
    const headlight: Part = {
      oemNumber: '566941015F',
      name: 'Фара головного света',
      category: 'Светодиодные фары',
      brand: 'Skoda',
      imageUrl: 'https://img.example.com/schema.png',
      position: '1',
      schemeId: 'GROUP-LIGHT',
    }
    const harness: Part = {
      oemNumber: '565941813F',
      name: 'Жгут проводов освещения',
      category: 'Отдельные детали',
      brand: 'Skoda',
      imageUrl: 'https://img.example.com/schema.png',
      position: '9',
      schemeId: 'GROUP-LIGHT',
    }

    function botWithScheme(schemeParts: () => Promise<Part[]>) {
      const catalog = new CatalogService(
        {
          decodeVin: async () => vehicle,
          searchParts: async () => [headlight],
          schemeParts: async () => schemeParts(),
        },
        new MockSupplierProvider(),
        new MockPlateProvider(),
      )
      return new TelegramBot(client, catalog)
    }

    test('«9» после схемы открывает деталь этой позиции', async () => {
      const numberBot = botWithScheme(async () => [headlight, harness])

      await numberBot.handleUpdate(messageUpdate(DEMO_VIN))
      await numberBot.handleUpdate(messageUpdate('фара'))
      await numberBot.handleUpdate(messageUpdate('9'))

      const last = client.sent.at(-1)
      expect(last?.text).toContain('Позиция 9')
      const keyboard = last?.options?.replyMarkup?.inline_keyboard
      expect(keyboard?.[0]?.[0]?.text).toContain('Жгут проводов освещения')
      expect(keyboard?.[0]?.[0]?.callback_data).toBe('oem:565941813F')
    })

    test('пятизначный номер позиции (Ford) тоже открывает деталь схемы', async () => {
      // Живьём 2026-09: у Ford Mondeo АКБ на схеме — позиция 10655, бот искал её как название.
      const battery: Part = { ...harness, oemNumber: '2014807', name: 'Батарея аккумуляторная', position: '10655' }
      const numberBot = botWithScheme(async () => [headlight, battery])

      await numberBot.handleUpdate(messageUpdate(DEMO_VIN))
      await numberBot.handleUpdate(messageUpdate('фара'))
      await numberBot.handleUpdate(messageUpdate('10655'))

      const last = client.sent.at(-1)
      expect(last?.text).toContain('Позиция 10655')
      expect(last?.options?.replyMarkup?.inline_keyboard?.[0]?.[0]?.text).toContain('Батарея')
    })

    test('такой позиции на схеме нет — говорим об этом, а не «ничего не найдено»', async () => {
      const numberBot = botWithScheme(async () => [headlight, harness])

      await numberBot.handleUpdate(messageUpdate(DEMO_VIN))
      await numberBot.handleUpdate(messageUpdate('фара'))
      await numberBot.handleUpdate(messageUpdate('77'))

      expect(client.sent.at(-1)?.text).toContain('нет позиции 77')
    })

    test('в выдаче со схемой бот подсказывает, что можно прислать номер', async () => {
      const numberBot = botWithScheme(async () => [])

      await numberBot.handleUpdate(messageUpdate(DEMO_VIN))
      await numberBot.handleUpdate(messageUpdate('фара'))

      expect(client.sentPhotos.at(-1)?.options?.caption).toContain('номер со схемы')
    })

    test('без показанной схемы число идёт в обычный поиск', async () => {
      await bot.handleUpdate(messageUpdate(DEMO_VIN))
      await bot.handleUpdate(messageUpdate('9'))

      // Мок-каталог по «9» ничего не знает — это обычная выдача поиска.
      expect(client.sent.at(-1)?.text).toContain('ничего не найдено')
    })
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

/**
 * Одна машина — один подбор. Мастер работает с несколькими машинами подряд, и
 * без явной границы схема и кнопки прошлой машины «продолжают» разговор:
 * живьём «9» после нового VIN искал позицию чужого узла.
 */
describe('TelegramBot — граница между машинами', () => {
  const OTHER_VIN = 'XW8ZZZ5NZLG123456'
  const headlight: Part = {
    oemNumber: '566941015F',
    name: 'Фара головного света',
    category: 'Светодиодные фары',
    brand: 'Skoda',
    imageUrl: 'https://img.example.com/schema.png',
    position: '1',
    schemeId: 'GROUP-LIGHT',
  }
  const harness: Part = { ...headlight, oemNumber: '565941813F', name: 'Жгут проводов освещения', position: '9' }

  function carBot(client: FakeTelegramClient) {
    const catalog = new CatalogService(
      {
        decodeVin: async (vin) => ({
          vin,
          make: vin === OTHER_VIN ? 'Skoda' : 'Volkswagen',
          model: vin === OTHER_VIN ? 'Kodiaq' : 'Golf',
          year: 2020,
          engine: null,
          bodyType: null,
        }),
        searchParts: async () => [headlight],
        schemeParts: async () => [headlight, harness],
      },
      new MockSupplierProvider(),
      new MockPlateProvider(),
    )
    return new TelegramBot(client, catalog)
  }

  test('новый VIN закрывает прошлый подбор: номер со схемы больше не открывает чужой узел', async () => {
    const client = new FakeTelegramClient()
    const bot = carBot(client)

    await bot.handleUpdate(messageUpdate(DEMO_VIN))
    await bot.handleUpdate(messageUpdate('фара'))
    await bot.handleUpdate(messageUpdate(OTHER_VIN))

    const card = client.sent.at(-1)?.text ?? ''
    expect(card).toContain('Другая машина')
    expect(card).toContain('Skoda')

    // Схема прошлой машины закрыта: число уходит в обычный поиск, а не в её узел.
    const photosBefore = client.sentPhotos.length
    await bot.handleUpdate(messageUpdate('9'))
    // Выдача со схемой уходит фотографией — значит, это обычный поиск, а не узел.
    expect(client.sentPhotos.length).toBe(photosBefore + 1)
    expect(client.sentPhotos.at(-1)?.options?.caption).toContain('Найдено запчастей')
    expect(client.sent.at(-1)?.text).not.toContain('Позиция 9')
  })

  test('повтор того же VIN контекст не сбрасывает', async () => {
    const client = new FakeTelegramClient()
    const bot = carBot(client)

    await bot.handleUpdate(messageUpdate(DEMO_VIN))
    await bot.handleUpdate(messageUpdate('фара'))
    await bot.handleUpdate(messageUpdate(DEMO_VIN))

    expect(client.sent.at(-1)?.text).not.toContain('Другая машина')

    await bot.handleUpdate(messageUpdate('9'))
    expect(client.sent.at(-1)?.text).toContain('Позиция 9')
  })

  test('первая машина в чате — без пометки о переключении', async () => {
    const client = new FakeTelegramClient()
    await carBot(client).handleUpdate(messageUpdate(DEMO_VIN))
    expect(client.sent[0]?.text).not.toContain('Другая машина')
  })
})

describe('неопознанный VIN', () => {
  /** Каталог, который ни одну машину не знает (все источники ответили «нет»). */
  function emptyCatalog(): CatalogService {
    return new CatalogService(
      { decodeVin: async () => null, searchParts: async () => [] },
      new MockSupplierProvider(),
      new MockPlateProvider(),
    )
  }

  test('обычный VIN → просьба проверить номер', async () => {
    const client = new FakeTelegramClient()
    const bot = new TelegramBot(client, emptyCatalog())
    await bot.handleUpdate(messageUpdate('JHMCM56557C404453'))
    expect(client.sent[0]?.text).toContain('Проверьте VIN')
  })

  test('УАЗ (WMI XTT) → честная причина и официальный каталог завода', async () => {
    const client = new FakeTelegramClient()
    const bot = new TelegramBot(client, emptyCatalog())
    await bot.handleUpdate(messageUpdate('XTT316300F1234567'))

    const text = client.sent[0]?.text ?? ''
    expect(text).toContain('УАЗ')
    expect(text).toContain('uaz.ru')
    // Мастера не отправляем перепроверять правильный номер.
    expect(text).not.toContain('Проверьте VIN')
  })
})

describe('поиск детали глазами по дереву каталога', () => {
  const vehicle: Vehicle = { vin: DEMO_VIN, make: 'Skoda', model: 'Kodiaq', year: 2020, engine: null, bodyType: null }
  const roller: Part = {
    oemNumber: '04E145299K',
    name: 'Ролик натяжной',
    category: 'Привод вспомогательных агрегатов',
    brand: 'Skoda',
    position: '7',
    schemeId: 'g-belt',
  }

  function treeBot(client: FakeTelegramClient): TelegramBot {
    const catalog = new CatalogService(
      {
        decodeVin: async () => vehicle,
        searchParts: async () => [],
        catalogTree: async () => [
          { id: '1', name: 'Двигатель', parentId: null, leaf: false },
          { id: '11', name: 'Привод ременный навесных агрегатов ДВС', parentId: '1', leaf: true },
          { id: '2', name: 'Кузов', parentId: null, leaf: true },
        ],
        branchSchemes: async (_vehicle, branchId) =>
          branchId === '11'
            ? [
                { schemeId: 'g-belt', name: 'Привод вспомогательных агрегатов', imageUrl: 'https://img.example.com/belt.png' },
                { schemeId: 'g-gen', name: 'Кронштейн генератора', imageUrl: null },
              ]
            : [],
        schemeParts: async (_vehicle, schemeId) => (schemeId === 'g-belt' ? [roller] : []),
      },
      new MockSupplierProvider(),
      new MockPlateProvider(),
    )
    return new TelegramBot(client, catalog)
  }

  test('пустая выдача предлагает найти деталь на схеме каталога', async () => {
    const client = new FakeTelegramClient()
    const bot = treeBot(client)
    await bot.handleUpdate(messageUpdate(DEMO_VIN))
    await bot.handleUpdate(messageUpdate('обводной ролик'))

    const buttons = client.sent.at(-1)?.options?.replyMarkup?.inline_keyboard.flat() ?? []
    expect(buttons.map((button) => button.callback_data)).toContain('tree:top')
  })

  test('дерево → лист → схема → номер с картинки → деталь с номером из каталога', async () => {
    const client = new FakeTelegramClient()
    const bot = treeBot(client)
    await bot.handleUpdate(messageUpdate(DEMO_VIN))

    await bot.handleUpdate(callbackUpdate('tree:top'))
    let keyboard = client.sent.at(-1)?.options?.replyMarkup?.inline_keyboard ?? []
    expect(keyboard.map((row) => row[0]?.text)).toEqual(['Двигатель', 'Кузов'])

    await bot.handleUpdate(callbackUpdate('tree:0')) // Двигатель
    expect(client.sent.at(-1)?.text).toContain('Двигатель')
    keyboard = client.sent.at(-1)?.options?.replyMarkup?.inline_keyboard ?? []
    expect(keyboard[0]?.[0]?.text).toBe('Привод ременный навесных агрегатов ДВС')

    await bot.handleUpdate(callbackUpdate('tree:0')) // лист → две схемы на выбор
    keyboard = client.sent.at(-1)?.options?.replyMarkup?.inline_keyboard ?? []
    expect(keyboard.map((row) => row[0]?.callback_data)).toEqual(['sch:0', 'sch:1', 'tree:here'])

    await bot.handleUpdate(callbackUpdate('sch:0'))
    expect(client.sentPhotos.at(-1)?.photoUrl).toBe('https://img.example.com/belt.png')
    expect(client.sentPhotos.at(-1)?.options?.caption).toContain('Пришлите номер детали')

    await bot.handleUpdate(messageUpdate('7'))
    const answer = client.sent.at(-1)
    expect(answer?.text).toContain('Позиция 7')
    const button = answer?.options?.replyMarkup?.inline_keyboard[0]?.[0]
    expect(button?.text).toContain('Ролик натяжной')
    expect(button?.callback_data).toBe('oem:04E145299K')
  })

  test('«назад» из схем листа возвращает к тому же уровню, а не выше', async () => {
    const client = new FakeTelegramClient()
    const bot = treeBot(client)
    await bot.handleUpdate(messageUpdate(DEMO_VIN))
    await bot.handleUpdate(callbackUpdate('tree:top'))
    await bot.handleUpdate(callbackUpdate('tree:0'))
    await bot.handleUpdate(callbackUpdate('tree:0'))
    await bot.handleUpdate(callbackUpdate('tree:here'))

    const keyboard = client.sent.at(-1)?.options?.replyMarkup?.inline_keyboard ?? []
    expect(keyboard[0]?.[0]?.text).toBe('Привод ременный навесных агрегатов ДВС')
  })

  test('карточка машины сразу даёт вход в узлы каталога', async () => {
    const client = new FakeTelegramClient()
    await treeBot(client).handleUpdate(messageUpdate(DEMO_VIN))
    expect(client.sent[0]?.options?.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data).toBe('tree:top')
  })

  test('лист без схем — честно говорит об этом', async () => {
    const client = new FakeTelegramClient()
    const bot = treeBot(client)
    await bot.handleUpdate(messageUpdate(DEMO_VIN))
    await bot.handleUpdate(callbackUpdate('tree:top'))
    await bot.handleUpdate(callbackUpdate('tree:1')) // Кузов — лист без схем
    expect(client.sent.at(-1)?.text).toContain('схем нет')
  })

  test('без дерева у каталога кнопки нет', async () => {
    const client = new FakeTelegramClient()
    const catalog = new CatalogService(
      { decodeVin: async () => vehicle, searchParts: async () => [] },
      new MockSupplierProvider(),
      new MockPlateProvider(),
    )
    const bot = new TelegramBot(client, catalog)
    await bot.handleUpdate(messageUpdate(DEMO_VIN))
    await bot.handleUpdate(messageUpdate('обводной ролик'))
    expect(client.sent.at(-1)?.options?.replyMarkup).toBeUndefined()
  })
})
