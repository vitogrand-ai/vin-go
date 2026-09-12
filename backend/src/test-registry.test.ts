/**
 * Реестр тестов: каждый файл `*.test.ts` должен кем-то запускаться.
 *
 * `bun test <список>` в `test:unit` перечисляет файлы поимённо (целиком папку
 * запускать нельзя — интеграционные тесты требуют поднятой базы). Поимённый
 * список молча устаревает: новый тест лежит в репозитории, зелёный локально, а
 * в общем прогоне его нет. Так четыре набора (`vin-year`, `catalog-translator`,
 * `translating-catalog`, `translation-provider`) не запускались вовсе — именно
 * вокруг перевода и года машины потом всплывали живые дефекты.
 *
 * Этот тест падает, когда файл забыли зарегистрировать, и говорит куда его
 * добавить: юнит — в `test:unit` (package.json), интеграционный — в
 * `scripts/test-integration.mjs`.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const backendRoot = resolve(import.meta.dir, '..')

/** Файлы тестов на диске — путями от корня backend, всегда через `/`. */
function testFilesOnDisk(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'generated' || entry.name === 'node_modules') continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...testFilesOnDisk(full))
      continue
    }
    if (entry.name.endsWith('.test.ts')) {
      found.push(full.slice(backendRoot.length + 1).replaceAll('\\', '/'))
    }
  }
  return found
}

const files = testFilesOnDisk(join(backendRoot, 'src'))
const unitScript = JSON.parse(readFileSync(join(backendRoot, 'package.json'), 'utf8')).scripts[
  'test:unit'
] as string
const integrationRunner = readFileSync(join(backendRoot, 'scripts/test-integration.mjs'), 'utf8')

describe('реестр тестов', () => {
  it('находит тесты на диске', () => {
    expect(files.length).toBeGreaterThan(30)
  })

  it('каждый тест запускается прогоном', () => {
    const orphans = files.filter(
      (file) => !unitScript.includes(file) && !integrationRunner.includes(file),
    )
    expect(
      orphans,
      'Эти тесты не запускаются ни одним прогоном. Юнит — добавьте в "test:unit" в backend/package.json, ' +
        'интеграционный (нужна база) — в backend/scripts/test-integration.mjs',
    ).toEqual([])
  })

  it('в прогонах нет исчезнувших файлов', () => {
    const listed = unitScript
      .split(/\s+/)
      .filter((token) => token.endsWith('.test.ts'))
      .map((token) => token.replaceAll('\\', '/'))
    const ghosts = listed.filter((file) => !files.includes(file))
    expect(ghosts, 'Этих файлов больше нет — уберите их из "test:unit"').toEqual([])
  })
})
