/**
 * Страховка от утечки доступов в журнал.
 *
 * Этот класс дефекта всплывал уже дважды: токен Telegram-бота в journald и
 * ключ PartsAPI в выводе при HTTP 401. Оба раза чинили точечно — добавляли имя
 * параметра в маску, — и оба раза следующий провайдер приносил своё имя:
 * ABCP носит доступ как `userlogin`+`userpsw`, VINqu — как `siteHash`+
 * `accessHash`, и общая маска их не знала.
 *
 * Тест смотрит на исходники провайдеров и сам находит параметры, похожие на
 * доступ (по имени или по тому, что в них подставляется), после чего требует,
 * чтобы `safeUrl` их скрывал. Новый провайдер со своим именем ключа роняет
 * тест ДО того, как ключ окажется в журнале боевого сервера.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { safeUrl } from './provider-http'

const catalogDir = resolve(import.meta.dir)

/** Имена и значения, за которыми обычно прячется доступ. */
const LOOKS_LIKE_SECRET = /key|token|user|pass|psw|secret|sign|auth|login|hash|cred/i

/** Имена, которые похожи на доступ только по написанию. */
const NOT_A_SECRET = new Set(['username', 'usermail', 'signature_version'])

function providerSources(): { file: string; code: string }[] {
  return readdirSync(catalogDir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ file: name, code: readFileSync(join(catalogDir, name), 'utf8') }))
}

/** Параметры запроса, в которые подставляется что-то похожее на доступ. */
function secretQueryParams(): Map<string, string> {
  const found = new Map<string, string>()
  const patterns = [
    // `...?user=${...}&token=${...}` — строка запроса собрана шаблоном.
    /[?&]([A-Za-z_]\w*)=\$\{([^}]*)\}/g,
    // `new URLSearchParams({ userlogin: this.login, ... })` — объектом.
    /([A-Za-z_]\w*):\s*(this\.[A-Za-z_]\w*[^,\n]*)/g,
    // `params.set('key', ...)` — по одному.
    /\.set\(\s*['"]([^'"]+)['"]\s*,\s*([^)]*)\)/g,
  ]

  for (const { file, code } of providerSources()) {
    for (const pattern of patterns) {
      for (const match of code.matchAll(pattern)) {
        const name = match[1]!
        const value = match[2] ?? ''
        if (NOT_A_SECRET.has(name.toLowerCase())) continue
        if (!LOOKS_LIKE_SECRET.test(name) && !LOOKS_LIKE_SECRET.test(value)) continue
        if (!found.has(name)) found.set(name, file)
      }
    }
  }

  return found
}

describe('доступы провайдеров не попадают в журнал', () => {
  const params = secretQueryParams()

  it('находит параметры доступа в исходниках провайдеров', () => {
    expect(params.size).toBeGreaterThan(3)
  })

  it('каждый такой параметр скрыт в адресе для журнала', () => {
    const leaked: string[] = []
    for (const [name, file] of params) {
      const masked = safeUrl(`https://example.com/method?${name}=SUPERSECRET&vin=X`)
      if (masked.includes('SUPERSECRET')) leaked.push(`${name} (${file})`)
    }
    expect(
      leaked,
      'Эти параметры несут доступ, но попадут в журнал открытым текстом. ' +
        'Добавьте их имена в SECRET_PARAMS (src/catalog/provider-http.ts)',
    ).toEqual([])
  })

  it('адрес остаётся читаемым: скрыто только значение', () => {
    const masked = safeUrl('https://example.com/search?userlogin=vasya&number=123')
    expect(masked).toContain('number=123')
    expect(masked).not.toContain('vasya')
  })
})
