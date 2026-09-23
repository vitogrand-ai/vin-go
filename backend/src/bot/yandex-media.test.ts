import { describe, expect, test } from 'bun:test'

import {
  YANDEX_OCR_URL,
  YANDEX_STT_URL,
  YandexVinOcrProvider,
  YandexVoiceTranscriber,
  findVinInText,
} from './yandex-media'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])

type Call = { url: string; init: RequestInit }

function recording(respond: (call: Call) => Response) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init: RequestInit) => {
    const call = { url, init }
    calls.push(call)
    return respond(call)
  }
  return { calls, fetchImpl }
}

/** Ответ Vision OCR: полный текст снимка в textAnnotation.fullText. */
function ocrAnswer(fullText: string): Response {
  return new Response(JSON.stringify({ result: { textAnnotation: { fullText }, page: '0' } }), { status: 200 })
}

describe('findVinInText', () => {
  test('VIN с таблички среди прочего текста', () => {
    expect(findVinInText('SKODA AUTO\nVIN XW8LD6NS2LH410128\n2020 1500 kg')).toBe('XW8LD6NS2LH410128')
  })

  test('VIN, разбитый пробелами на группы, собирается', () => {
    expect(findVinInText('VIN: WVW ZZZ 1JZ 3W 386752')).toBe('WVWZZZ1JZ3W386752')
  })

  test('буквы I, O, Q в VIN — это 1, 0 и 0: так их путает распознавание', () => {
    expect(findVinInText('VIN JF1SK7LL5MG129305'.replace('129305', 'I293O5'))).toBe('JF1SK7LL5MG129305')
  })

  test('номер кузова японца без VIN', () => {
    expect(findVinInText('FRAME No.\nSXA10-0012345\nTOYOTA')).toBe('SXA10-0012345')
  })

  test('два разных VIN — неоднозначно, лучше null, чем чужая машина', () => {
    expect(findVinInText('XW8LD6NS2LH410128\nWVWZZZ1JZ3W386752')).toBeNull()
  })

  test('два кандидата, один подписан «VIN» — берётся подписанный', () => {
    expect(findVinInText('Шасси WVWZZZ1JZ3W386752\nVIN XW8LD6NS2LH410128')).toBe('XW8LD6NS2LH410128')
  })

  test('одна и та же строка дважды (СТС) — не неоднозначность', () => {
    expect(findVinInText('VIN XW8LD6NS2LH410128\nКузов XW8LD6NS2LH410128')).toBe('XW8LD6NS2LH410128')
  })

  test('нет ничего похожего — null', () => {
    expect(findVinInText('Масса 1500 кг\nТип двигателя CZDA')).toBeNull()
  })
})

describe('YandexVinOcrProvider', () => {
  test('шлёт снимок в Vision OCR и достаёт VIN из текста', async () => {
    const { calls, fetchImpl } = recording(() => ocrAnswer('VIN XW8LD6NS2LH410128'))
    const ocr = new YandexVinOcrProvider({ apiKey: 'KEY', folderId: 'FOLDER', fetchImpl })

    const vin = await ocr.extractVin({ bytes: JPEG, mediaType: 'image/jpeg' })

    expect(vin).toBe('XW8LD6NS2LH410128')
    expect(calls[0]!.url).toBe(YANDEX_OCR_URL)
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Api-Key KEY')
    expect(headers['x-folder-id']).toBe('FOLDER')
    // Фото документов (СТС) не должны оседать в журналах Яндекса.
    expect(headers['x-data-logging-enabled']).toBe('false')
    const body = JSON.parse(String(calls[0]!.init.body))
    expect(body.mimeType).toBe('JPEG')
    expect(body.content).toBe(Buffer.from(JPEG).toString('base64'))
  })

  test('без каталога в настройках заголовок x-folder-id не шлётся', async () => {
    const { calls, fetchImpl } = recording(() => ocrAnswer('VIN XW8LD6NS2LH410128'))
    await new YandexVinOcrProvider({ apiKey: 'KEY', fetchImpl }).extractVin({ bytes: JPEG, mediaType: 'image/jpeg' })
    expect((calls[0]!.init.headers as Record<string, string>)['x-folder-id']).toBeUndefined()
  })

  test('формат, которого Vision не читает (webp), в API не уходит', async () => {
    const { calls, fetchImpl } = recording(() => ocrAnswer(''))
    const vin = await new YandexVinOcrProvider({ apiKey: 'KEY', fetchImpl }).extractVin({
      bytes: JPEG,
      mediaType: 'image/webp',
    })
    expect(vin).toBeNull()
    expect(calls).toHaveLength(0)
  })

  test('отказ API — null без исключения и без ключа в журнале', async () => {
    const { fetchImpl } = recording(() => new Response('{"message":"denied"}', { status: 403 }))
    const vin = await new YandexVinOcrProvider({ apiKey: 'SECRET-KEY', fetchImpl }).extractVin({
      bytes: JPEG,
      mediaType: 'image/jpeg',
    })
    expect(vin).toBeNull()
  })

  test('сетевой сбой — null', async () => {
    const ocr = new YandexVinOcrProvider({
      apiKey: 'KEY',
      fetchImpl: async () => {
        throw new Error('ECONNRESET')
      },
    })
    expect(await ocr.extractVin({ bytes: JPEG, mediaType: 'image/jpeg' })).toBeNull()
  })
})

describe('YandexVoiceTranscriber', () => {
  test('шлёт голосовое ogg/opus в SpeechKit и возвращает текст', async () => {
    const { calls, fetchImpl } = recording(() => new Response(JSON.stringify({ result: 'передние колодки' })))
    const voice = new YandexVoiceTranscriber({ apiKey: 'KEY', folderId: 'FOLDER', fetchImpl })

    expect(await voice.transcribe(new Uint8Array([1, 2, 3]))).toBe('передние колодки')

    const url = new URL(calls[0]!.url)
    expect(`${url.origin}${url.pathname}`).toBe(YANDEX_STT_URL)
    expect(url.searchParams.get('lang')).toBe('ru-RU')
    expect(url.searchParams.get('format')).toBe('oggopus')
    expect(url.searchParams.get('folderId')).toBe('FOLDER')
    expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe('Api-Key KEY')
  })

  test('лимит SpeechKit — 30 секунд, бот узнаёт его заранее', () => {
    expect(new YandexVoiceTranscriber({ apiKey: 'KEY' }).maxSeconds).toBe(30)
  })

  test('файл больше 1 МБ в API не уходит', async () => {
    const { calls, fetchImpl } = recording(() => new Response(JSON.stringify({ result: 'x' })))
    const voice = new YandexVoiceTranscriber({ apiKey: 'KEY', fetchImpl })
    expect(await voice.transcribe(new Uint8Array(1024 * 1024 + 1))).toBeNull()
    expect(calls).toHaveLength(0)
  })

  test('тишина (пустой результат) и отказ API — null', async () => {
    const empty = recording(() => new Response(JSON.stringify({ result: '' })))
    expect(await new YandexVoiceTranscriber({ apiKey: 'KEY', fetchImpl: empty.fetchImpl }).transcribe(new Uint8Array([1]))).toBeNull()
    const denied = recording(() => new Response('{}', { status: 401 }))
    expect(await new YandexVoiceTranscriber({ apiKey: 'KEY', fetchImpl: denied.fetchImpl }).transcribe(new Uint8Array([1]))).toBeNull()
  })
})
