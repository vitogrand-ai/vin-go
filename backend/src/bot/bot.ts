import { plateSchema, vinOrFrameSchema, type Part, type TierPick } from '@web-app-demo/contracts'

import type { Actor } from '../auth/actor'
import type { CatalogService } from '../catalog/service'
import type { ExpertsService } from '../experts/service'
import type { GarageService } from '../garage/service'
import { AppError } from '../http/errors'
import type { OrdersService } from '../orders/service'
import type { TelegramLinkService } from '../telegram/service'
import { computeServiceIntervals } from '../garage/service-intervals'
import {
  cartMessage,
  formatVehicle,
  garageMessage,
  offersMessage,
  ordersMessage,
  partsMessage,
  serviceIntervalsMessage,
  tierAddKeyboard,
  WELCOME,
} from './formatters'
import type { SessionStore } from './session-store'
import { describeNetworkError, type TelegramClient, type TgCallbackQuery, type TgMessage, type TgUpdate } from './telegram'
import { detectImageMediaType, type VinOcrProvider } from './vin-ocr'
import type { VoiceTranscriber } from './voice-transcribe'

export type ChatSession = {
  vin?: string
  /** Карта oemNumber → название запчасти из последнего поиска. */
  parts?: Record<string, string>
  /**
   * Контекст выдачи предложений по каждому OEM (для кнопок «в корзину»).
   * Ключ — oemNumber, поэтому нажатие кнопки на старом сообщении добавит именно
   * ту запчасть, а не последнюю показанную.
   */
  offers?: Record<string, { oemNumber: string; partName: string; picks: TierPick[] }>
  /** Последний запрос детали — уходит эксперту по кнопке «Спросить эксперта». */
  lastQuery?: string
  /**
   * Схема узла из последней выдачи. Хранится здесь, а не в callback_data:
   * там лимит 64 байта, в который адрес картинки не помещается.
   */
  scheme?: string
  /**
   * Идентификатор того же узла в каталоге. По нему открывается деталь, номер
   * которой мастер прочитал на картинке: «9» — жгут проводов освещения.
   */
  schemeId?: string
}

/** Сервисы кабинета — доступны боту, когда аккаунт привязан. */
export type BotCabinet = {
  link: TelegramLinkService
  orders: OrdersService
  /** Заявки эксперту по кнопке в пустой выдаче. */
  experts?: ExpertsService
  /** Гараж автосервиса: /garage выбирает машину без ввода VIN. */
  garage?: GarageService
}

/**
 * Распознавание вложений. Каждый пункт включается своим ключом в env и
 * отсутствует по умолчанию: без них бот работает как раньше, просто просит
 * прислать данные текстом.
 */
export type BotMedia = {
  /** Фото шильдика → VIN. */
  vinOcr?: VinOcrProvider
  /** Голосовое → текст запроса. */
  voice?: VoiceTranscriber
}

/** Больше 20 МБ Bot API не отдаёт — не тратим вызов getFile впустую. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/** Как часто обновляется «печатает…»: Telegram гасит статус через ~5 секунд. */
const TYPING_REFRESH_MS = 4000

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
    private readonly media: BotMedia = {},
    /** Персистентность сессий между рестартами; без него — только память. */
    private readonly store?: SessionStore,
  ) {}

  async handleUpdate(update: TgUpdate): Promise<void> {
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id
    if (chatId !== undefined) await this.restoreSession(chatId)

    const message = update.message
    if (message?.text) {
      await this.handleMessage(message)
    } else if (message?.voice) {
      await this.handleVoice(message)
    } else if (message?.photo?.length || isImageDocument(message?.document?.mime_type)) {
      await this.handlePhoto(message!)
    } else if (update.callback_query) {
      await this.handleCallback(update.callback_query)
    }

    if (chatId !== undefined) await this.persistSession(chatId)
  }

  /** Первое обращение чата после рестарта — поднимаем контекст из хранилища. */
  private async restoreSession(chatId: number): Promise<void> {
    if (!this.store || this.sessions.has(chatId)) return
    const saved = await this.store.load(chatId)
    if (saved) this.sessions.set(chatId, saved)
  }

  private async persistSession(chatId: number): Promise<void> {
    const session = this.sessions.get(chatId)
    if (!this.store || !session) return
    await this.store.save(chatId, session)
  }

  /**
   * Голосовое → текст → обычная обработка. Расшифрованный текст проходит тот же
   * путь, что и набранный: он может оказаться и VIN-ом, и названием детали,
   * и командой, поэтому разбирать его отдельно не нужно.
   */
  private async handleVoice(message: TgMessage): Promise<void> {
    const chatId = message.chat.id
    if (!this.media.voice) {
      await this.client.sendMessage(
        chatId,
        'Голосовые я пока не разбираю — напишите текстом, пожалуйста.',
      )
      return
    }

    const audio = await this.downloadAttachment(message.voice!.file_id, message.voice!.file_size)
    if (!audio) {
      await this.client.sendMessage(chatId, 'Не смог скачать голосовое. Повторите текстом.')
      return
    }

    const text = await this.media.voice.transcribe(audio)
    if (!text) {
      await this.client.sendMessage(
        chatId,
        'Не разобрал голосовое. Попробуйте записать ещё раз или напишите текстом.',
      )
      return
    }

    await this.client.sendMessage(chatId, `🎤 Распознал: «${text}»`)
    await this.handleMessage({ ...message, text })
  }

  /**
   * Фото шильдика → VIN. Берётся самый крупный размер: на мелком превью
   * символы не читаются. Фото, присланное файлом («без сжатия»), — лучший
   * случай, оно приходит в document и не пережато мессенджером.
   */
  private async handlePhoto(message: TgMessage): Promise<void> {
    const chatId = message.chat.id
    if (!this.media.vinOcr) {
      await this.client.sendMessage(
        chatId,
        'Распознавание фото сейчас недоступно — пришлите VIN текстом (17 символов).',
      )
      return
    }

    const attachment = pickBestPhoto(message)
    if (!attachment) return

    const bytes = await this.downloadAttachment(attachment.fileId, attachment.fileSize)
    if (!bytes) {
      await this.client.sendMessage(chatId, 'Не смог скачать фото. Пришлите VIN текстом.')
      return
    }

    const mediaType = detectImageMediaType(bytes)
    if (!mediaType) {
      await this.client.sendMessage(
        chatId,
        'Этот формат снимка я не читаю. Пришлите обычное фото (JPG/PNG) или VIN текстом.',
      )
      return
    }

    const vin = await this.media.vinOcr.extractVin({ bytes, mediaType })
    if (!vin) {
      await this.client.sendMessage(
        chatId,
        'Не разобрал номер на фото. Снимите табличку крупнее и без бликов — ' +
          'или пришлите VIN текстом (17 символов).',
      )
      return
    }

    await this.client.sendMessage(chatId, `📷 Распознал VIN: <code>${vin}</code>`, {
      parseMode: 'HTML',
    })
    await this.handleVin(chatId, vin)
  }

  /**
   * «Что пора менять на таком пробеге» — повод вернуться в бота между поломками
   * и готовая корзина расходников. Названия позиций канонические, поэтому
   * следующим сообщением мастер просто присылает нужное и получает артикулы.
   */
  private async handleServiceIntervals(chatId: number, mileageKm: number): Promise<void> {
    const statuses = computeServiceIntervals(mileageKm)
    await this.client.sendMessage(chatId, serviceIntervalsMessage(mileageKm, statuses), {
      parseMode: 'HTML',
    })
  }

  /** Скачивание вложения с проверкой лимита Bot API. */
  private async downloadAttachment(
    fileId: string,
    fileSize: number | undefined,
  ): Promise<Uint8Array | null> {
    if (fileSize !== undefined && fileSize > MAX_ATTACHMENT_BYTES) return null
    return this.client.downloadFile(fileId)
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
    if (command === '/garage' || command === 'гараж') {
      await this.handleGarage(chatId, telegramUserId)
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

    const mileage = parseServiceCommand(text)
    if (mileage !== null) {
      await this.handleServiceIntervals(chatId, mileage)
      return
    }
    // Команда без пробега — в любом написании: «/то», «/to», «ТО».
    if (/^\/?(?:то|to)$/i.test(command)) {
      await this.client.sendMessage(
        chatId,
        'Укажите пробег: например <code>/то 145000</code> — покажу, что пора менять.',
        { parseMode: 'HTML' },
      )
      return
    }

    // VIN (17 симв.) или frame-номер кузова JDM (SXA10-0012345) — общий контракт.
    const vinCandidate = vinOrFrameSchema.safeParse(text.replace(/\s+/g, ''))
    if (vinCandidate.success) {
      await this.handleVin(chatId, vinCandidate.data)
      return
    }

    const plate = plateSchema.safeParse(text)
    if (plate.success) {
      await this.handlePlate(chatId, plate.data)
      return
    }

    // Номер с картинки вместо названия: после схемы узла «9» — это выноска на
    // ней, а не поисковый запрос. Названия деталей числами не бывают, так что
    // спутать не с чем; без показанной схемы число уходит в обычный поиск.
    const position = parseSchemePosition(text)
    if (position !== null && this.session(chatId).schemeId) {
      await this.handleSchemePosition(chatId, position)
      return
    }

    await this.handlePartQuery(chatId, text)
  }

  private async handleVin(chatId: number, vin: string): Promise<void> {
    try {
      const { vehicle } = await this.catalog.decodeVin(vin)
      this.session(chatId).vin = vin
      await this.client.sendMessage(chatId, formatVehicle(vehicle), { parseMode: 'HTML' })
    } catch (error) {
      // «Не найден» и «каталог лежит» — разные ответы: сбой источника не должен
      // выглядеть так, будто мастер ошибся в VIN.
      await this.client.sendMessage(
        chatId,
        isNotFound(error)
          ? 'Автомобиль не найден в подключённых каталогах. Проверьте VIN (17 символов) или номер кузова (например SXA10-0012345) и пришлите снова.'
          : 'Каталог сейчас недоступен. Попробуйте ещё раз через пару минут.',
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

    let parts: Part[]
    let resolvedQuery: string | undefined
    try {
      ;({ parts, resolvedQuery } = await this.withTyping(chatId, () =>
        this.catalog.searchParts(session.vin!, query),
      ))
    } catch (error) {
      // Без этого ответа сбой источника выглядит как молчание бота.
      console.error('[bot] поиск запчасти упал:', error)
      await this.client.sendMessage(
        chatId,
        'Каталог сейчас недоступен. Попробуйте ещё раз через пару минут.',
      )
      return
    }
    if (parts.length === 0) {
      // Тупик «не найдено» превращаем в заявку живому подборщику: это и есть
      // ответ на неполное покрытие каталогов.
      session.lastQuery = query
      await this.client.sendMessage(
        chatId,
        'По этому запросу ничего не найдено. Попробуйте другое название запчасти' +
          (this.cabinet?.experts ? ' — или передайте запрос эксперту.' : '.'),
        this.cabinet?.experts
          ? {
              replyMarkup: {
                inline_keyboard: [
                  [{ text: '🧑‍🔧 Спросить эксперта', callback_data: 'expert:ask' }],
                ],
              },
            }
          : undefined,
      )
      return
    }

    session.parts = Object.fromEntries(parts.map((part) => [part.oemNumber, part.name]))

    // Схема узла из каталога — мастеру видно, ту ли деталь он выбирает.
    // Фото не критично: любой сбой (битый URL, недоступный хост картинок) —
    // и выдача уходит обычным текстом.
    const withScheme = parts.find((part) => part.imageUrl)
    const imageUrl = withScheme?.imageUrl
    session.scheme = imageUrl ?? undefined
    // Узел показанной схемы — по нему разбирается номер выноски с картинки.
    session.schemeId = withScheme?.schemeId ?? undefined
    const { text, keyboard } = partsMessage(parts, resolvedQuery, { hasScheme: Boolean(imageUrl) })

    if (imageUrl) {
      try {
        await this.client.sendPhoto(chatId, imageUrl, {
          caption: text,
          parseMode: 'HTML',
          replyMarkup: keyboard,
        })
        return
      } catch (error) {
        console.warn('[bot] схема не отправилась, шлём выдачу текстом', error)
      }
    }
    await this.client.sendMessage(chatId, text, { parseMode: 'HTML', replyMarkup: keyboard })
  }

  /**
   * Деталь по номеру выноски на показанной схеме.
   *
   * Мастер держит перед глазами картинку узла: там жгут проводов подписан
   * цифрой 9, а не словами — назвать его текстом он не может. Номер разбирается
   * по тому же узлу, схему которого бот только что прислал.
   */
  private async handleSchemePosition(chatId: number, position: string): Promise<void> {
    const session = this.session(chatId)
    if (!session.vin || !session.schemeId) return

    let parts: Part[]
    try {
      parts = (
        await this.withTyping(chatId, () =>
          this.catalog.schemeParts(session.vin!, session.schemeId!, position),
        )
      ).parts
    } catch (error) {
      console.error('[bot] узел по схеме не открылся:', error)
      await this.client.sendMessage(
        chatId,
        'Каталог сейчас недоступен. Попробуйте ещё раз через пару минут.',
      )
      return
    }

    if (parts.length === 0) {
      await this.client.sendMessage(
        chatId,
        `На схеме нет позиции ${position}. Проверьте номер на картинке ` +
          '(кнопка «🔍 Схема крупнее») или пришлите название запчасти.',
      )
      return
    }

    session.parts = Object.fromEntries(parts.map((part) => [part.oemNumber, part.name]))
    const { text, keyboard } = partsMessage(parts, undefined, { hasScheme: Boolean(session.scheme) })
    await this.client.sendMessage(chatId, `📍 Позиция ${position} на схеме.\n${text}`, {
      parseMode: 'HTML',
      replyMarkup: keyboard,
    })
  }

  /**
   * «Бот печатает…» на время долгого запроса. Поиск по каталогу — это цепочка
   * вызовов внешних API (живьём до 20 секунд), и без индикатора бот выглядит
   * умершим: мастер шлёт запрос ещё раз, очередь растёт. Статус живёт ~5 секунд,
   * поэтому обновляем его, пока идёт работа.
   */
  private async withTyping<T>(chatId: number, work: () => Promise<T>): Promise<T> {
    void this.client.sendChatAction(chatId, 'typing').catch(() => undefined)
    const timer = setInterval(() => {
      void this.client.sendChatAction(chatId, 'typing').catch(() => undefined)
    }, TYPING_REFRESH_MS)
    try {
      return await work()
    } finally {
      clearInterval(timer)
    }
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
    if (data === 'expert:ask') {
      await this.askExpert(chatId, callback.from.id)
      return
    }
    if (data === 'scheme') {
      await this.sendFullScheme(chatId)
      return
    }
    if (data.startsWith('car:')) {
      await this.pickGarageCar(chatId, callback.from.id, data.slice('car:'.length))
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

  /**
   * Схема узла файлом. Фото в Telegram пережимается, и номера позиций на схеме
   * плывут — а мастер открывает её именно ради них. Документ доходит без
   * пережатия, в исходном разрешении каталога.
   */
  private async sendFullScheme(chatId: number): Promise<void> {
    const scheme = this.session(chatId).scheme
    if (!scheme) {
      // Сессия могла истечь или бот перезапускался — просим повторить поиск.
      await this.client.sendMessage(chatId, 'Схема не найдена — повторите поиск запчасти.')
      return
    }

    try {
      await this.client.sendDocument(chatId, scheme, {
        caption: 'Схема узла в исходном размере — откройте файл, чтобы увеличить.',
      })
    } catch (error) {
      console.warn('[bot] схема файлом не отправилась', error)
      await this.client.sendMessage(chatId, 'Не удалось прислать схему файлом. Попробуйте ещё раз.')
    }
  }

  private async showOffers(chatId: number, oemNumber: string): Promise<void> {
    const session = this.session(chatId)
    const { picks, offers, source } = await this.catalog.getOffers(oemNumber)
    const partName = session.parts?.[oemNumber] ?? oemNumber
    ;(session.offers ??= {})[oemNumber] = { oemNumber, partName, picks }
    await this.client.sendMessage(chatId, offersMessage(oemNumber, picks, offers, source), {
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
    const actor = await this.requireActor(chatId, telegramUserId)
    if (!actor) return

    const offerContext = oemNumber ? this.session(chatId).offers?.[oemNumber] : undefined
    const pick = offerContext?.picks.find((candidate) => candidate.tier === tier)
    if (!offerContext || !pick) {
      await this.client.sendMessage(chatId, 'Сначала выберите запчасть и откройте предложения.')
      return
    }

    await this.cabinet!.orders.addItem(actor, {
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

  /** Заявка эксперту по последнему пустому запросу. */
  private async askExpert(chatId: number, telegramUserId: number): Promise<void> {
    const session = this.session(chatId)
    if (!this.cabinet?.experts || !session.vin || !session.lastQuery) {
      await this.client.sendMessage(chatId, 'Сначала пришлите VIN и название запчасти.')
      return
    }
    const actor = await this.requireActor(chatId, telegramUserId)
    if (!actor) return
    const { request } = await this.cabinet.experts.create(actor, {
      vin: session.vin,
      query: session.lastQuery,
    })
    await this.client.sendMessage(
      chatId,
      `📨 Заявка № ${request.number} отправлена эксперту: «${request.query}» для VIN <code>${request.vin}</code>. Ответ придёт сюда.`,
      { parseMode: 'HTML' },
    )
  }

  /** Гараж автосервиса: кнопки с машинами, выбор подставляет VIN в разговор. */
  private async handleGarage(chatId: number, telegramUserId: number): Promise<void> {
    if (!this.cabinet?.garage) {
      await this.client.sendMessage(chatId, 'Гараж в боте сейчас недоступен.')
      return
    }
    const actor = await this.requireActor(chatId, telegramUserId)
    if (!actor) return
    const { vehicles } = await this.cabinet.garage.list(actor)
    const { text, keyboard } = garageMessage(vehicles)
    await this.client.sendMessage(chatId, text, { parseMode: 'HTML', replyMarkup: keyboard })
  }

  private async pickGarageCar(chatId: number, telegramUserId: number, vin: string): Promise<void> {
    if (!this.cabinet?.garage) return
    const actor = await this.requireActor(chatId, telegramUserId)
    if (!actor) return
    // VIN берём только из гаража автосервиса — callback мог прийти со старой кнопки.
    const { vehicles } = await this.cabinet.garage.list(actor)
    const vehicle = vehicles.find((candidate) => candidate.vin === vin)
    if (!vehicle) {
      await this.client.sendMessage(chatId, 'Этой машины больше нет в гараже. Откройте /garage заново.')
      return
    }
    this.session(chatId).vin = vehicle.vin
    await this.client.sendMessage(chatId, formatVehicle(vehicle), { parseMode: 'HTML' })
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
    const actor = await this.requireActor(chatId, telegramUserId)
    if (!actor) return
    const { order } = await this.cabinet!.orders.getCart(actor)
    await this.client.sendMessage(chatId, cartMessage(order), { parseMode: 'HTML' })
  }

  private async handleOrders(chatId: number, telegramUserId: number): Promise<void> {
    const actor = await this.requireActor(chatId, telegramUserId)
    if (!actor) return
    // В чате показываем заказы автосервиса, а не очередь всей платформы —
    // даже если аккаунт оператора: длинный список в Telegram нечитаем.
    const { orders } = await this.cabinet!.orders.listOrders({ ...actor, role: 'USER' })
    await this.client.sendMessage(chatId, ordersMessage(orders), { parseMode: 'HTML' })
  }

  private async handleCheckout(chatId: number, telegramUserId: number): Promise<void> {
    const actor = await this.requireActor(chatId, telegramUserId)
    if (!actor) return
    try {
      const { order } = await this.cabinet!.orders.checkout(actor)
      await this.client.sendMessage(
        chatId,
        `✅ Заказ № ${order.number} оформлен. Оплата — в личном кабинете на сайте.\nСумма: ${formatTotal(order.total)}`,
      )
    } catch {
      await this.client.sendMessage(chatId, 'Корзина пуста — оформлять нечего.')
    }
  }

  /** Возвращает участника автосервиса по привязанному аккаунту или подсказывает привязаться. */
  private async requireActor(chatId: number, telegramUserId: number): Promise<Actor | null> {
    if (!this.cabinet) {
      await this.client.sendMessage(chatId, 'Функции кабинета сейчас недоступны.')
      return null
    }
    const actor = await this.cabinet.link.resolveActor(BigInt(telegramUserId))
    if (!actor) {
      await this.client.sendMessage(
        chatId,
        'Сначала привяжите аккаунт: в личном кабинете на сайте нажмите «Подключить Telegram» и пришлите сюда /start <код>.',
      )
      return null
    }
    return actor
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
        // Только сообщение: объект ошибки fetch содержит URL с токеном бота.
        console.error(
          'Ошибка getUpdates:',
          error instanceof Error ? error.message : describeNetworkError(error),
        )
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

/**
 * Номер выноски на схеме: короткое целое число и ничего больше. Три знака —
 * потолок нумерации узлов каталога; длинные числа (пробег, артикул) сюда не
 * попадают.
 */
export function parseSchemePosition(text: string): string | null {
  const match = /^(\d{1,3})$/.exec(text.trim())
  return match ? String(Number.parseInt(match[1]!, 10)) : null
}

/**
 * Пробег из команды ТО: «/то 145000», «/to 145 000», «ТО 145000».
 * Возвращает null, если это не команда ТО или пробег неправдоподобен —
 * миллион километров и «0» почти всегда опечатка, а не запрос.
 */
export function parseServiceCommand(text: string): number | null {
  const match = /^\/?(?:то|to)\s+([\d\s]+)$/i.exec(text.trim())
  if (!match) return null

  const mileage = Number.parseInt(match[1]!.replace(/\s+/g, ''), 10)
  if (!Number.isFinite(mileage) || mileage <= 0 || mileage > 2_000_000) return null
  return mileage
}

/** Честное «не найдено» от каталога — в отличие от сбоя источника (502 и т.п.). */
function isNotFound(error: unknown): boolean {
  return error instanceof AppError && error.status === 404
}

/** Прислан ли документ, который является изображением (фото «без сжатия»). */
function isImageDocument(mimeType: string | undefined): boolean {
  return mimeType?.startsWith('image/') ?? false
}

/**
 * Какой файл читать: документ-изображение приоритетнее — Telegram не жмёт его,
 * и мелкие символы VIN остаются различимыми. Иначе берётся самый крупный из
 * размеров сжатого фото (Telegram отдаёт их по возрастанию).
 */
function pickBestPhoto(
  message: TgMessage,
): { fileId: string; fileSize: number | undefined } | null {
  if (isImageDocument(message.document?.mime_type)) {
    return { fileId: message.document!.file_id, fileSize: message.document!.file_size }
  }
  const sizes = message.photo ?? []
  const largest = sizes[sizes.length - 1]
  return largest ? { fileId: largest.file_id, fileSize: largest.file_size } : null
}

function formatTotal(total: { amount: number; currency: string }): string {
  const rub = Math.round(total.amount / 100)
  return `${rub.toLocaleString('ru-RU')} ₽`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
