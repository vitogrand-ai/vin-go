import { beforeEach, describe, expect, test } from 'bun:test'

import { createMockCatalogService } from '../catalog/service'
import { parseServiceCommand, TelegramBot } from './bot'
import type { SendMessageOptions, TelegramClient, TgUpdate } from './telegram'
import { detectImageMediaType, parseVinAnswer, type VinOcrProvider, type VinPhoto } from './vin-ocr'
import { MAX_AUDIO_BYTES, WhisperVoiceTranscriber, type VoiceTranscriber } from './voice-transcribe'

const CHAT_ID = 42
const DEMO_VIN = 'WVWZZZ1JZ3W386752'

type SentMessage = { chatId: number; text: string; options?: SendMessageOptions }

class FakeTelegramClient implements TelegramClient {
  readonly sent: SentMessage[] = []
  /** Что отдавать на downloadFile; null — файл недоступен. */
  file: Uint8Array | null = null
  readonly downloaded: string[] = []

  async getUpdates(): Promise<TgUpdate[]> {
    return []
  }
  async sendMessage(chatId: number, text: string, options?: SendMessageOptions): Promise<void> {
    this.sent.push({ chatId, text, options })
  }
  async answerCallbackQuery(): Promise<void> {}
  async downloadFile(fileId: string): Promise<Uint8Array | null> {
    this.downloaded.push(fileId)
    return this.file
  }

  texts(): string {
    return this.sent.map((message) => message.text).join('\n')
  }
}

/** Минимальный валидный JPEG-заголовок — распознаётся как image/jpeg. */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])

class FakeVinOcr implements VinOcrProvider {
  readonly seen: VinPhoto[] = []
  constructor(private readonly result: string | null) {}
  async extractVin(image: VinPhoto): Promise<string | null> {
    this.seen.push(image)
    return this.result
  }
}

class FakeVoice implements VoiceTranscriber {
  constructor(private readonly result: string | null) {}
  async transcribe(): Promise<string | null> {
    return this.result
  }
}

function photoUpdate(): TgUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: CHAT_ID },
      photo: [
        { file_id: 'small', width: 90, height: 60, file_size: 900 },
        { file_id: 'large', width: 1280, height: 960, file_size: 240_000 },
      ],
    },
  }
}

function voiceUpdate(): TgUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: CHAT_ID },
      voice: { file_id: 'voice-1', duration: 3, file_size: 12_000 },
    },
  }
}

describe('detectImageMediaType', () => {
  test('узнаёт форматы по сигнатуре файла', () => {
    expect(detectImageMediaType(JPEG_BYTES)).toBe('image/jpeg')
    expect(
      detectImageMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13])),
    ).toBe('image/png')
    expect(
      detectImageMediaType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0])),
    ).toBe('image/gif')
    // RIFF....WEBP — метка формата на 8-м байте, а не сразу за RIFF.
    expect(
      detectImageMediaType(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 40, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe('image/webp')
  })

  test('неподдерживаемый формат и обрезок дают null', () => {
    // HEIC с айфона: контейнер ISO-BMFF, Claude Vision его не принимает.
    expect(
      detectImageMediaType(
        new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]),
      ),
    ).toBeNull()
    expect(detectImageMediaType(new Uint8Array([0xff, 0xd8]))).toBeNull()
  })
})

describe('parseVinAnswer', () => {
  test('достаёт VIN из ответа модели', () => {
    expect(parseVinAnswer(`{"vin": "${DEMO_VIN}"}`)).toBe(DEMO_VIN)
  })

  test('терпит обёртку из markdown и пояснений', () => {
    expect(parseVinAnswer(`Вот результат:\n\`\`\`json\n{"vin":"${DEMO_VIN}"}\n\`\`\``)).toBe(DEMO_VIN)
  })

  test('приводит к верхнему регистру и убирает пробелы', () => {
    expect(parseVinAnswer('{"vin": "wvwzzz1jz3w 386752"}')).toBe(DEMO_VIN)
  })

  test('понимает номер кузова японца без VIN', () => {
    expect(parseVinAnswer('{"vin": "SXA10-0012345"}')).toBe('SXA10-0012345')
  })

  test('честное «не вижу» превращается в null', () => {
    expect(parseVinAnswer('{"vin": null}')).toBeNull()
  })

  test('недо-VIN отбрасывается, а не идёт в поиск', () => {
    // 16 символов и запрещённая буква O: искать по такому — вести мастера
    // к чужой машине. Контракт отсекает это до запроса в каталог.
    expect(parseVinAnswer('{"vin": "WVWZZZ1JZ3W38675"}')).toBeNull()
    expect(parseVinAnswer('{"vin": "WVWZZZ1JZ3W38675O"}')).toBeNull()
  })

  test('мусор вместо JSON не роняет разбор', () => {
    expect(parseVinAnswer('Извините, не могу помочь')).toBeNull()
    expect(parseVinAnswer('{сломанный json')).toBeNull()
    expect(parseVinAnswer('')).toBeNull()
  })
})

describe('WhisperVoiceTranscriber', () => {
  test('возвращает расшифровку', async () => {
    const transcriber = new WhisperVoiceTranscriber({
      apiKey: 'test-key',
      fetchImpl: async () => new Response('передние тормозные колодки\n', { status: 200 }),
    })
    expect(await transcriber.transcribe(new Uint8Array([1, 2, 3]))).toBe(
      'передние тормозные колодки',
    )
  })

  test('ошибка API — это null, а не исключение', async () => {
    const transcriber = new WhisperVoiceTranscriber({
      apiKey: 'test-key',
      fetchImpl: async () => new Response('nope', { status: 401 }),
    })
    expect(await transcriber.transcribe(new Uint8Array([1, 2, 3]))).toBeNull()
  })

  test('сетевой сбой — это null', async () => {
    const transcriber = new WhisperVoiceTranscriber({
      apiKey: 'test-key',
      fetchImpl: async () => {
        throw new Error('сеть недоступна')
      },
    })
    expect(await transcriber.transcribe(new Uint8Array([1, 2, 3]))).toBeNull()
  })

  test('слишком большой файл не отправляется в API', async () => {
    let called = false
    const transcriber = new WhisperVoiceTranscriber({
      apiKey: 'test-key',
      fetchImpl: async () => {
        called = true
        return new Response('', { status: 200 })
      },
    })
    const huge = new Uint8Array(MAX_AUDIO_BYTES + 1)
    expect(await transcriber.transcribe(huge)).toBeNull()
    expect(called).toBe(false)
  })
})

describe('TelegramBot — фото шильдика', () => {
  let client: FakeTelegramClient

  beforeEach(() => {
    client = new FakeTelegramClient()
    client.file = JPEG_BYTES
  })

  test('распознанный VIN определяет машину', async () => {
    const ocr = new FakeVinOcr(DEMO_VIN)
    const bot = new TelegramBot(client, createMockCatalogService(), undefined, { vinOcr: ocr })

    await bot.handleUpdate(photoUpdate())

    expect(client.texts()).toContain(DEMO_VIN)
    expect(client.texts()).toContain('Volkswagen')
    expect(ocr.seen[0]?.mediaType).toBe('image/jpeg')
  })

  test('берётся самый крупный размер — на превью символы не читаются', async () => {
    const bot = new TelegramBot(client, createMockCatalogService(), undefined, {
      vinOcr: new FakeVinOcr(DEMO_VIN),
    })

    await bot.handleUpdate(photoUpdate())

    expect(client.downloaded).toEqual(['large'])
  })

  test('фото «без сжатия» (документом) предпочтительнее сжатого', async () => {
    const bot = new TelegramBot(client, createMockCatalogService(), undefined, {
      vinOcr: new FakeVinOcr(DEMO_VIN),
    })

    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: CHAT_ID },
        photo: [{ file_id: 'compressed', width: 1280, height: 960 }],
        document: { file_id: 'original', mime_type: 'image/jpeg', file_size: 900_000 },
      },
    })

    expect(client.downloaded).toEqual(['original'])
  })

  test('нечитаемое фото — подсказка, как переснять', async () => {
    const bot = new TelegramBot(client, createMockCatalogService(), undefined, {
      vinOcr: new FakeVinOcr(null),
    })

    await bot.handleUpdate(photoUpdate())

    expect(client.texts()).toContain('Не разобрал номер')
  })

  test('неподдерживаемый формат снимка не уходит в модель', async () => {
    const ocr = new FakeVinOcr(DEMO_VIN)
    client.file = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])
    const bot = new TelegramBot(client, createMockCatalogService(), undefined, { vinOcr: ocr })

    await bot.handleUpdate(photoUpdate())

    expect(ocr.seen).toHaveLength(0)
    expect(client.texts()).toContain('формат')
  })

  test('без настроенного распознавания бот просит текст, а не молчит', async () => {
    const bot = new TelegramBot(client, createMockCatalogService())

    await bot.handleUpdate(photoUpdate())

    expect(client.texts()).toContain('VIN текстом')
    expect(client.downloaded).toHaveLength(0)
  })

  test('недоступный файл не роняет обработку', async () => {
    client.file = null
    const bot = new TelegramBot(client, createMockCatalogService(), undefined, {
      vinOcr: new FakeVinOcr(DEMO_VIN),
    })

    await bot.handleUpdate(photoUpdate())

    expect(client.texts()).toContain('Не смог скачать фото')
  })
})

describe('TelegramBot — голосовые', () => {
  let client: FakeTelegramClient

  beforeEach(() => {
    client = new FakeTelegramClient()
    client.file = new Uint8Array([1, 2, 3])
  })

  test('распознанный VIN из голосового определяет машину', async () => {
    const bot = new TelegramBot(client, createMockCatalogService(), undefined, {
      voice: new FakeVoice(DEMO_VIN),
    })

    await bot.handleUpdate(voiceUpdate())

    expect(client.texts()).toContain('Распознал')
    expect(client.texts()).toContain('Volkswagen')
  })

  test('расшифровка проходит тот же путь, что и набранный текст', async () => {
    // Голосом называют деталь; без VIN бот обязан попросить его — ровно как
    // при вводе текстом, отдельной ветки для голоса быть не должно.
    const bot = new TelegramBot(client, createMockCatalogService(), undefined, {
      voice: new FakeVoice('передние колодки'),
    })

    await bot.handleUpdate(voiceUpdate())

    expect(client.texts()).toContain('Сначала пришлите VIN')
  })

  test('неразборчивое голосовое — просьба повторить', async () => {
    const bot = new TelegramBot(client, createMockCatalogService(), undefined, {
      voice: new FakeVoice(null),
    })

    await bot.handleUpdate(voiceUpdate())

    expect(client.texts()).toContain('Не разобрал голосовое')
  })

  test('без настроенной расшифровки бот просит написать текстом', async () => {
    const bot = new TelegramBot(client, createMockCatalogService())

    await bot.handleUpdate(voiceUpdate())

    expect(client.texts()).toContain('напишите текстом')
    expect(client.downloaded).toHaveLength(0)
  })
})

describe('parseServiceCommand', () => {
  test('понимает команду ТО в разных написаниях', () => {
    expect(parseServiceCommand('/то 145000')).toBe(145_000)
    expect(parseServiceCommand('/to 145000')).toBe(145_000)
    expect(parseServiceCommand('ТО 145 000')).toBe(145_000)
  })

  test('не путает с обычным запросом детали', () => {
    expect(parseServiceCommand('колодки')).toBeNull()
    expect(parseServiceCommand('/cart')).toBeNull()
  })

  test('неправдоподобный пробег отвергается', () => {
    // Ноль и миллионы километров — почти всегда опечатка.
    expect(parseServiceCommand('/то 0')).toBeNull()
    expect(parseServiceCommand('/то 9000000')).toBeNull()
  })
})

describe('TelegramBot — регламент ТО', () => {
  test('по пробегу показывает, что подходит к замене', async () => {
    const client = new FakeTelegramClient()
    const bot = new TelegramBot(client, createMockCatalogService())

    await bot.handleUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: CHAT_ID }, text: '/то 145000' },
    })

    expect(client.texts()).toContain('Регламент ТО')
    expect(client.texts()).toContain('Моторное масло')
  })

  test('команда без пробега подсказывает формат', async () => {
    const client = new FakeTelegramClient()
    const bot = new TelegramBot(client, createMockCatalogService())

    await bot.handleUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: CHAT_ID }, text: '/то' },
    })

    expect(client.texts()).toContain('Укажите пробег')
  })
})
