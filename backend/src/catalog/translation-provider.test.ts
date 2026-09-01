import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, test } from 'bun:test'

import {
  AnthropicTranslationProvider,
  parseTranslations,
  supportsEffort,
} from './translation-provider'

/** Клиент-заглушка: отдаёт заданный ответ и запоминает параметры запроса. */
function providerWith(response: Partial<Anthropic.Message>) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = []
  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParamsNonStreaming) => {
        requests.push(params)
        return { stop_reason: 'end_turn', content: [], ...response } as Anthropic.Message
      },
    },
  } as unknown as Pick<Anthropic, 'messages'>

  return {
    requests,
    provider: new AnthropicTranslationProvider({ apiKey: 'test-key', model: 'test-model', client }),
  }
}

function textMessage(text: string): Partial<Anthropic.Message> {
  return { content: [{ type: 'text', text, citations: null } as Anthropic.TextBlock] }
}

describe('AnthropicTranslationProvider.translate', () => {
  test('возвращает переводы в порядке запроса', async () => {
    const { provider, requests } = providerWith(
      textMessage('["Масляный фильтр","Тормозной диск"]'),
    )

    const result = await provider.translate(['OIL FILTER', 'BRAKE DISC'])

    expect(result).toEqual(['Масляный фильтр', 'Тормозной диск'])
    expect(requests[0]?.model).toBe('test-model')
    expect(requests[0]?.messages[0]?.content).toBe('["OIL FILTER","BRAKE DISC"]')
  })

  test('пустой запрос не идёт в API', async () => {
    const { provider, requests } = providerWith(textMessage('[]'))

    expect(await provider.translate([])).toEqual([])
    expect(requests).toEqual([])
  })

  test('обрыв по лимиту токенов — отказ, а не половина переводов', async () => {
    const { provider } = providerWith({
      stop_reason: 'max_tokens',
      ...textMessage('["Масляный фильтр"'),
    })

    expect(await provider.translate(['OIL FILTER', 'BRAKE DISC'])).toBeNull()
  })

  test('сбой запроса не пробрасывается наружу', async () => {
    const client = {
      messages: {
        create: async () => {
          throw new Error('сеть недоступна')
        },
      },
    } as unknown as Pick<Anthropic, 'messages'>
    const provider = new AnthropicTranslationProvider({ apiKey: 'test-key', client })

    expect(await provider.translate(['OIL FILTER'])).toBeNull()
  })
})

describe('parseTranslations', () => {
  test('разбирает массив, обёрнутый пояснением модели', () => {
    expect(parseTranslations('Вот перевод: ["Крышка"] — готово', 1)).toEqual(['Крышка'])
  })

  test('несовпадение длины — отказ (иначе переводы сдвинутся по деталям)', () => {
    expect(parseTranslations('["Крышка"]', 2)).toBeNull()
  })

  test('не-JSON — отказ', () => {
    expect(parseTranslations('перевода не будет', 1)).toBeNull()
  })

  test('массив не из строк — отказ', () => {
    expect(parseTranslations('[1,2]', 2)).toBeNull()
  })
})

describe('supportsEffort', () => {
  test('пятое поколение и 4.6+ принимают effort', () => {
    expect(supportsEffort('claude-sonnet-5')).toBe(true)
    expect(supportsEffort('claude-opus-5')).toBe(true)
    expect(supportsEffort('claude-opus-4-8')).toBe(true)
  })

  test('Haiku 4.5 и прочие старые — без effort, иначе 400', () => {
    expect(supportsEffort('claude-haiku-4-5')).toBe(false)
    expect(supportsEffort('claude-sonnet-4-5')).toBe(false)
  })
})
