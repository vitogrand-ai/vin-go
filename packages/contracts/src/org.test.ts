import { describe, expect, test } from 'bun:test'

import { innSchema, ogrnSchema, updateOrganizationRequestSchema } from './org'

describe('реквизиты автосервиса для заказ-наряда', () => {
  test('ИНН — 10 цифр у юрлица или 12 у ИП, пробелы вокруг терпим', () => {
    expect(innSchema.safeParse('7707083893').success).toBe(true)
    expect(innSchema.safeParse(' 500100732259 ').success).toBe(true)
    expect(innSchema.safeParse('77070838').success).toBe(false)
    expect(innSchema.safeParse('7707-083893').success).toBe(false)
  })

  test('ОГРН — 13 цифр, ОГРНИП — 15', () => {
    expect(ogrnSchema.safeParse('1027700132195').success).toBe(true)
    expect(ogrnSchema.safeParse('304500116000157').success).toBe(true)
    expect(ogrnSchema.safeParse('10277001321').success).toBe(false)
  })

  test('в запросе реквизиты необязательны, null очищает поле', () => {
    const parsed = updateOrganizationRequestSchema.parse({ inn: null, legalName: 'ООО «Сервис»' })
    expect(parsed.inn).toBeNull()
    expect(parsed.legalName).toBe('ООО «Сервис»')
    expect(parsed.ogrn).toBeUndefined()
  })
})
