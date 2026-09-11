/**
 * Проверка названий: что именно находит продукт по тому, как деталь называет
 * мастер. Отвечает на вопрос «ту ли деталь мы показали», которого замер
 * покрытия (`catalog-coverage.ts`) не задаёт — там считается, нашлось ли
 * хоть что-то.
 *
 * Нужен потому, что справочник каталога зовёт детали своими именами («Крышка
 * ГБЦ», а не «Крышка клапанная»; «Подшипник генератора» — это подшипник, а не
 * генератор), и промах словаря выглядит как успех: выдача не пустая, просто
 * деталь чужая. Глазами по таблице это видно сразу.
 *
 * Идёт полным боевым путём — словарь жаргона, синонимический ряд, ранжирование
 * подсказок, фильтр позиции, — поэтому показывает ровно то, что увидит мастер.
 *
 * Запуск (на сервере: ключ parts-catalogs привязан к IP VPS):
 *   bun run --cwd backend catalog:names -- <VIN>
 *   bun run --cwd backend catalog:names -- <VIN> --queries "клапанная крышка,помпа"
 *   bun run --cwd backend catalog:names -- <VIN> --json /tmp/names.json
 *
 * Деньги: один VIN на весь прогон (расшифровка кэшируется), дальше идут
 * вызовы поиска по каталогу.
 */
import 'dotenv/config'

import { writeFileSync } from 'node:fs'

import { createCatalogProviders } from '../src/catalog/factory'
import { CatalogService } from '../src/catalog/service'
import { loadEnv } from '../src/env'

/**
 * Корзина проверки — как деталь называют в чате СТО. Намеренно вперемешку:
 * канцелярит («головка блока цилиндров»), жаргон («гранатка», «воздухан») и
 * известные ловушки, где каталог норовит подсунуть соседа по узлу («крышка»,
 * «генератор», «глушитель»). Переопределяется через --queries.
 */
const DEFAULT_QUERIES = [
  'клапанная крышка',
  'крышка гбц',
  'головка блока цилиндров',
  'прокладка клапанной крышки',
  'колодки тормозные',
  'тормозные диски',
  'масляный фильтр',
  'воздухан',
  'салонный фильтр',
  'амортизатор передний',
  'гранатка',
  'пыльник шруса',
  'ступичный подшипник',
  'ремень грм',
  'помпа',
  'термостат',
  'радиатор',
  'генератор',
  'стартер',
  'свечи',
  'катушка зажигания',
  'форсунка',
  'глушитель',
  'лямбда',
  'фара',
  'дворники',
  'стойка стабилизатора',
  'шаровая',
  'рулевая рейка',
  'сцепление',
  'сальник коленвала',
  'турбина',
  'бензонасос',
  'суппорт',
  'крышка расширительного бачка',
]

type Row = {
  query: string
  resolvedQuery: string | null
  found: number
  name: string | null
  category: string | null
  oemNumber: string | null
  error: string | null
}

async function main() {
  const { vin, queries, json } = parseArgs(Bun.argv.slice(2))

  if (!vin) {
    console.error(
      'Не передан VIN.\n' +
        '  bun run --cwd backend catalog:names -- Z8TND5FEAGM016476\n\n' +
        'Проверять имеет смысл на машине пилотного автосервиса: справочник названий\n' +
        'у каждого каталога свой, и промахи словаря видны только на живой выдаче.',
    )
    process.exit(1)
  }

  const env = loadEnv(Bun.env)
  const providers = createCatalogProviders(env)
  if (providers.meta.catalog.demo) {
    console.error('Боевых каталогов нет — проверять нечего: мок отвечает выдуманными деталями.')
    process.exit(1)
  }

  const service = new CatalogService(
    providers.catalog,
    providers.suppliers,
    providers.plates,
    providers.meta,
  )
  console.log(`VIN ${vin} | каталоги: ${providers.meta.catalog.names.join('+')}\n`)

  const rows: Row[] = []
  for (const query of queries) {
    rows.push(await probe(service, vin, query))
    print(rows[rows.length - 1]!)
  }

  const missed = rows.filter((row) => row.found === 0 && !row.error)
  const failed = rows.filter((row) => row.error)
  console.log(
    `\nнайдено: ${rows.length - missed.length - failed.length} из ${rows.length}` +
      ` | пусто: ${missed.length} | сбой: ${failed.length}`,
  )
  if (missed.length > 0) {
    console.log(`пусто по запросам: ${missed.map((row) => row.query).join(', ')}`)
  }
  console.log('\nСверьте столбец «деталь» глазами: пустой результат честнее чужой детали.')

  if (json) {
    writeFileSync(json, JSON.stringify(rows, null, 2), 'utf8')
    console.log(`\nОтчёт: ${json}`)
  }
}

async function probe(service: CatalogService, vin: string, query: string): Promise<Row> {
  try {
    const result = await service.searchParts(vin, query)
    const first = result.parts[0] ?? null
    return {
      query,
      resolvedQuery: result.resolvedQuery ?? null,
      found: result.parts.length,
      name: first?.name ?? null,
      category: first?.category ?? null,
      oemNumber: first?.oemNumber ?? null,
      error: null,
    }
  } catch (error) {
    return {
      query,
      resolvedQuery: null,
      found: 0,
      name: null,
      category: null,
      oemNumber: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function print(row: Row): void {
  const asked = row.resolvedQuery ? ` (искали «${row.resolvedQuery}»)` : ''
  if (row.error) {
    console.log(`  ${row.query.padEnd(30)} — СБОЙ: ${row.error}`)
    return
  }
  if (row.found === 0) {
    console.log(`  ${row.query.padEnd(30)} — не найдено${asked}`)
    return
  }
  const node = row.category ? ` | узел: ${row.category}` : ''
  console.log(`  ${row.query.padEnd(30)} → ${row.name} [${row.oemNumber}]${node}  ×${row.found}${asked}`)
}

function parseArgs(argv: string[]) {
  let vin: string | null = null
  let queries = DEFAULT_QUERIES
  let json: string | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--queries') {
      const value = argv[++index]
      if (!value) throw new Error('После --queries нужен список через запятую')
      queries = value.split(',').map((query) => query.trim()).filter(Boolean)
      continue
    }
    if (arg === '--json') {
      const value = argv[++index]
      if (!value) throw new Error('После --json нужен путь к файлу')
      json = value
      continue
    }
    // VIN или frame-номер: адаптеры различают их сами.
    if (!vin) vin = arg.trim().toUpperCase()
  }

  return { vin, queries, json }
}

await main()
