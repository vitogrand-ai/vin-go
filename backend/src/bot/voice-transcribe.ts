/**
 * Расшифровка голосовых сообщений Telegram.
 *
 * Зачем: в яме или с грязными руками надиктовать «передние колодки на приору»
 * быстрее, чем набрать. Прототип VINGO (`bot/services/voice_transcribe.py`)
 * показал, что голосом пользуются охотно.
 *
 * Реализация — OpenAI Whisper: у Anthropic нет аудио-API, а Whisper понимает
 * русскую речь с шумом мастерской. Это единственное место в проекте, где нужен
 * `OPENAI_API_KEY`; без ключа модуль отключён, и бот просто просит написать
 * текстом — остальные функции не страдают.
 */

export interface VoiceTranscriber {
  /**
   * Возвращает текст голосового или null, если расшифровать не удалось.
   * Не бросает: сбой распознавания не должен ронять обработку сообщения.
   */
  transcribe(audio: Uint8Array): Promise<string | null>
}

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions'

/** Лимит Whisper API на размер файла. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024

export type WhisperConfig = {
  apiKey: string
  /** Язык распознавания — подсказка модели, повышает точность. */
  language?: string
  /**
   * Подмена сетевого слоя в тестах. Тип уже, чем `typeof fetch`: нужен только
   * вызов, а не сопутствующие поля рантайма вроде `preconnect`.
   */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
}

export class WhisperVoiceTranscriber implements VoiceTranscriber {
  private readonly apiKey: string
  private readonly language: string
  private readonly fetchImpl: (url: string, init: RequestInit) => Promise<Response>

  constructor(config: WhisperConfig) {
    this.apiKey = config.apiKey
    this.language = config.language ?? 'ru'
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  async transcribe(audio: Uint8Array): Promise<string | null> {
    if (audio.length === 0) return null
    if (audio.length > MAX_AUDIO_BYTES) {
      console.warn(`[voice] файл ${audio.length} Б больше лимита Whisper (${MAX_AUDIO_BYTES} Б)`)
      return null
    }

    // Telegram отдаёт голосовые как opus в контейнере ogg — Whisper их принимает.
    // Копируем в собственный буфер: Blob не принимает представление над
    // SharedArrayBuffer, а тип входа этого не гарантирует.
    const buffer = new ArrayBuffer(audio.byteLength)
    new Uint8Array(buffer).set(audio)

    const form = new FormData()
    form.append('file', new Blob([buffer], { type: 'audio/ogg' }), 'voice.ogg')
    form.append('model', 'whisper-1')
    form.append('language', this.language)
    form.append('response_format', 'text')

    try {
      const response = await this.fetchImpl(WHISPER_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        // Живой пользователь ждёт в чате; десяти секунд хватает на голосовое.
        signal: AbortSignal.timeout(20_000),
      })

      if (!response.ok) {
        console.warn(`[voice] Whisper вернул ${response.status}`)
        return null
      }

      const text = (await response.text()).trim()
      return text.length > 0 ? text : null
    } catch (error) {
      console.warn('[voice] запрос к Whisper не удался', error)
      return null
    }
  }
}
