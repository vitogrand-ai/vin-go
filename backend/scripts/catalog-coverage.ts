/**
 * Замер покрытия каталога: по скольким реальным VIN продукт вообще находит
 * деталь. Отвечает на вопрос «хватает ли одного источника или нужен второй»
 * цифрой, а не ощущением — и потому запускается заново на каждом новом
 * каталоге (ACAT, PartsIndex), чтобы сравнивать их на ОДНИХ И ТЕХ ЖЕ машинах.
 *
 * Запуск:
 *   bun run --cwd backend catalog:coverage -- <VIN> [<VIN> ...]
 *   bun run --cwd backend catalog:coverage -- --file vins.txt
 *
 * Деньги: каждый НОВЫЙ VIN у 17vin стоит $0.15; повторы по тому же VIN
 * три месяца бесплатны, поэтому перезапуск на том же списке ничего не стоит.
 */
import 'dotenv/config'

import { loadEnv } from '../src/env'
import { VIN17_DEFAULT_BASE_URL, Vin17CatalogProvider } from '../src/catalog/vin17-provider'
import type { Part, Vehicle } from '@web-app-demo/contracts'

/**
 * Корзина запросов — то, что механик спрашивает чаще всего. Намеренно на
 * русском: замеряем весь путь целиком, включая словарь RU→ZH, а не только
 * каталог. Переопределяется через --queries "а,б,в".
 */
const DEFAULT_QUERIES = [
  'колодки тормозные',
  'масляный фильтр',
  'амортизатор',
  'ремень ГРМ',
  'фара',
]

type VinResult = {
  vin: string
  vehicle: Vehicle | null
  error: string | null
  found: Map<string, number>
}

async function main() {
  const { vins, queries, source } = parseArgs(Bun.argv.slice(2))

  if (vins.length === 0) {
    console.error(
      'Не переданы VIN.\n' +
        '  bun run --cwd backend catalog:coverage -- LFMGJE720DS070251 WBAJP51070BJ28779\n' +
        '  bun run --cwd backend catalog:coverage -- --file vins.txt\n\n' +
        'Замер имеет смысл только на реальных VIN — лучше всего на машинах пилотного автосервиса.',
    )
    process.exit(1)
  }

  const env = loadEnv(Bun.env)
  if (!env.VIN17_USER || !env.VIN17_PASSWORD) {
    console.error('VIN17_USER и VIN17_PASSWORD не заданы в backend/.env — замерять нечем.')
    process.exit(1)
  }

  const provider = new Vin17CatalogProvider({
    user: env.VIN17_USER,
    password: env.VIN17_PASSWORD,
    baseUrl: env.VIN17_BASE_URL ?? VIN17_DEFAULT_BASE_URL,
  })

  console.log(`Каталог: 17vin · VIN: ${vins.length} (${source}) · запросов на VIN: ${queries.length}`)
  console.log(`Новые VIN тарифицируются по $0.15; повторы три месяца бесплатны.\n`)

  const results: VinResult[] = []
  for (const [index, vin] of vins.entries()) {
    process.stdout.write(`[${index + 1}/${vins.length}] ${vin} ... `)
    const result = await measureVin(provider, vin, queries)
    results.push(result)
    console.log(describeResult(result, queries))
  }

  printSummary(results, queries)
}

/** Один автомобиль: расшифровка VIN, затем корзина запросов по нему. */
async function measureVin(
  provider: Vin17CatalogProvider,
  vin: string,
  queries: string[],
): Promise<VinResult> {
  const found = new Map<string, number>()

  let vehicle: Vehicle | null
  try {
    vehicle = await provider.decodeVin(vin)
  } catch (error) {
    return { vin, vehicle: null, error: message(error), found }
  }

  if (!vehicle) return { vin, vehicle: null, error: 'VIN не распознан', found }

  for (const query of queries) {
    let parts: Part[] = []
    try {
      parts = await provider.searchParts(vehicle, query)
    } catch (error) {
      // Отказ по одному запросу не отменяет остальные: считаем его нулём и идём дальше.
      console.error(`\n    ! «${query}»: ${message(error)}`)
    }
    found.set(query, parts.length)
  }

  return { vin, vehicle, error: null, found }
}

function describeResult(result: VinResult, queries: string[]): string {
  if (result.error) return `— ${result.error}`

  const hits = queries.filter((query) => (result.found.get(query) ?? 0) > 0).length
  const car = result.vehicle
    ? `${result.vehicle.make} ${result.vehicle.model} ${result.vehicle.year}`
    : 'авто не определено'
  return `${car} · нашлось по ${hits} из ${queries.length}`
}

function printSummary(results: VinResult[], queries: string[]) {
  const decoded = results.filter((result) => result.vehicle !== null)
  const withParts = decoded.filter((result) =>
    queries.some((query) => (result.found.get(query) ?? 0) > 0),
  )

  console.log('\n' + '─'.repeat(64))
  console.log('ИТОГО')
  console.log('─'.repeat(64))
  console.log(`VIN расшифровано:        ${decoded.length} из ${results.length} (${percent(decoded.length, results.length)})`)
  console.log(`Хоть одна деталь нашлась: ${withParts.length} из ${results.length} (${percent(withParts.length, results.length)})`)

  console.log('\nПо запросам (в скольких машинах нашлось):')
  for (const query of queries) {
    const hits = decoded.filter((result) => (result.found.get(query) ?? 0) > 0).length
    console.log(`  ${query.padEnd(20)} ${String(hits).padStart(3)} из ${decoded.length}  ${bar(hits, decoded.length)}`)
  }

  const byMake = new Map<string, { total: number; ok: number }>()
  for (const result of results) {
    const make = result.vehicle?.make ?? 'не распознано'
    const entry = byMake.get(make) ?? { total: 0, ok: 0 }
    entry.total += 1
    if (queries.some((query) => (result.found.get(query) ?? 0) > 0)) entry.ok += 1
    byMake.set(make, entry)
  }

  console.log('\nПо маркам:')
  for (const [make, entry] of [...byMake.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${make.padEnd(20)} ${entry.ok} из ${entry.total}`)
  }

  const failed = results.filter((result) => result.error)
  if (failed.length > 0) {
    console.log('\nНе получилось:')
    for (const result of failed) console.log(`  ${result.vin} — ${result.error}`)
  }
}

function parseArgs(argv: string[]) {
  const vins: string[] = []
  let queries = DEFAULT_QUERIES
  let source = 'аргументы'

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--file') {
      const path = argv[++index]
      if (!path) throw new Error('После --file нужен путь к файлу')
      const lines = require('node:fs').readFileSync(path, 'utf8') as string
      vins.push(...lines.split(/\r?\n/))
      source = path
      continue
    }
    if (arg === '--queries') {
      const value = argv[++index]
      if (!value) throw new Error('После --queries нужен список через запятую')
      queries = value.split(',').map((query) => query.trim()).filter(Boolean)
      continue
    }
    vins.push(arg)
  }

  const normalized = vins
    .map((vin) => vin.trim().toUpperCase())
    .filter((vin) => /^[A-HJ-NPR-Z0-9]{17}$/.test(vin))

  return { vins: [...new Set(normalized)], queries, source }
}

function percent(part: number, total: number): string {
  if (total === 0) return '0%'
  return `${Math.round((part / total) * 100)}%`
}

function bar(part: number, total: number): string {
  if (total === 0) return ''
  const width = Math.round((part / total) * 20)
  return '█'.repeat(width) + '·'.repeat(20 - width)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

await main()
