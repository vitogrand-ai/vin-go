/**
 * Запрет на изменяющие запросы к поставщикам и каталогам.
 *
 * Правило пилота, поставленное ещё в старом прототипе VINGO (27.05.2026) и
 * НЕ снятое: «пока я не закончу тестирование, ни в коем случае ничего не
 * заказывай и не отправляй им никакую информацию. Бери только цены и сроки».
 * Оно пережило смену проекта, каталогов и поставщиков, поэтому живёт тестом, а
 * не устной договорённостью: цена нарушения — реальный заказ или платная
 * заявка от имени пилота.
 *
 * Исключение ровно одно: `vinqu-client.ts` — скелет биржи экспертов, где
 * создание заявки платное (51/34 ₽). Он допускается в коде, но не должен
 * вызываться из продуктового пути, пока Виктор не снимет запрет явно.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const catalogDir = resolve(import.meta.dir)
const srcDir = resolve(import.meta.dir, '..')

/** Файл со скелетом платной заявки: POST внутри него разрешён, вызовы — нет. */
const PAID_SKELETON = 'vinqu-client.ts'
const PAID_METHOD = 'createQuery'

const WRITE_METHOD = /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/

function sourceFiles(directory: string): { file: string; code: string }[] {
  const found: { file: string; code: string }[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'generated' || entry.name === 'node_modules') continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full))
      continue
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
    found.push({ file: full.slice(srcDir.length + 1).replaceAll('\\', '/'), code: readFileSync(full, 'utf8') })
  }
  return found
}

describe('к поставщикам ходим только за ценами', () => {
  it('в адаптерах каталога и поставщиков нет изменяющих запросов', () => {
    const writers = sourceFiles(catalogDir)
      .filter(({ file, code }) => !file.endsWith(PAID_SKELETON) && WRITE_METHOD.test(code))
      .map(({ file }) => file)
    expect(
      writers,
      'Изменяющий запрос к внешнему источнику. Пока пилот не закончен, разрешено только чтение ' +
        '(цены, сроки, наличие). Снимает запрет владелец продукта, не тест.',
    ).toEqual([])
  })

  it('платная заявка VINqu не вызывается из продуктового кода', () => {
    const callers = sourceFiles(srcDir)
      .filter(({ file, code }) => !file.endsWith(PAID_SKELETON) && code.includes(`${PAID_METHOD}(`))
      .map(({ file }) => file)
    expect(
      callers,
      `${PAID_METHOD} создаёт платную заявку на бирже экспертов от имени пилота. ` +
        'Подключать только после явного разрешения владельца продукта.',
    ).toEqual([])
  })
})
