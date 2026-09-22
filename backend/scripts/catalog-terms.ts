/**
 * Замер словаря `part-terms` по каталогу 17vin: сколько терминов молчит на
 * конкретной машине.
 *
 * Зачем: словарь собирался и проверялся на Toyota Prado, и из этого молча
 * следовало, что база 17vin китайская. У импортных марок она английская —
 * `机油滤清器` на Jaguar XF отвечал нулём, деталь зовётся `Oil filter`. Жалоба
 * пришла про масляный фильтр, но молчали 36 терминов из 68: по такой машине
 * поиск не работал почти никогда, и по одной жалобе этого было не видно.
 *
 * Поэтому здесь два правила, которых не было раньше:
 *   • новый термин проверяется не на одной машине, а на эталонах РАЗНЫХ
 *     каталогов (`--only <стем>` прогонит одну запись по всем эталонам);
 *   • доля молчащих записей — сама по себе сигнал. Выше MAX_SILENT_SHARE это
 *     не «редкие запчасти», а чужой язык базы, и прогон валится ненулевым кодом.
 *
 * Запуск (локально, ключ 17vin по IP не привязан):
 *   bun run --cwd backend catalog:terms
 *   bun run --cwd backend catalog:terms -- --only масл
 *   bun run --cwd backend catalog:terms -- --vin SAJAA04M6FPU46282
 *
 * Деньги: поиск 5107 баланс не трогает, а эталонные VIN уже оплачены (повтор по
 * тому же VIN бесплатен три месяца). Латинская выгрузка каталога тоже бесплатна.
 */
import 'dotenv/config'

import { PART_TERM_ENTRIES, type DictEntry } from '../src/catalog/part-terms'
import {
  VIN17_DEFAULT_BASE_URL,
  Vin17CatalogProvider,
  buildVin17Token,
  filterByTerms,
  mapParts,
  safeBase64,
} from '../src/catalog/vin17-provider'
import type { Part, Vehicle } from '@web-app-demo/contracts'

/**
 * Эталоны: по машине на каждый язык базы 17vin. Список не сокращается —
 * термин, проверенный на одной строке, на другой может молчать.
 */
const REFERENCE_CARS: { vin: string; label: string }[] = [
  { vin: 'LFMGJE720DS070251', label: 'Toyota Prado — китайская база' },
  { vin: 'SAJAA04M6FPU46282', label: 'Jaguar XF — английская база' },
  { vin: 'JF1SK7LL5MG129305', label: 'Subaru Forester — английская база' },
]

/** Выше этой доли молчащих записей каталог считается непокрытым словарём. */
const MAX_SILENT_SHARE = 1 / 3

/** Сколько запросов терминов держим в полёте: хост в Китае, ответы неспешные. */
const CONCURRENCY = 6

/** Латинское слово, которым берётся выгрузка каталога (фильтра по ней нет). */
const DUMP_QUERY = 'zzzq'

type EntryResult = { entry: DictEntry; zh: number; en: number }

async function main(): Promise<void> {
  const user = process.env.VIN17_USER
  const password = process.env.VIN17_PASSWORD
  if (!user || !password) {
    console.error('Нужны VIN17_USER и VIN17_PASSWORD в backend/.env')
    process.exit(2)
  }

  const only = argValue('--only')
  const entries = only
    ? PART_TERM_ENTRIES.filter((entry) => entry.stems.some((stem) => stem.includes(only.toLowerCase())))
    : PART_TERM_ENTRIES
  if (entries.length === 0) {
    console.error(`По «${only}» в словаре ничего не нашлось`)
    process.exit(2)
  }

  const vin = argValue('--vin')
  const cars = vin ? [{ vin: vin.toUpperCase(), label: 'машина из аргумента' }] : REFERENCE_CARS

  const provider = new Vin17CatalogProvider({ user, password })
  let failed = false

  for (const car of cars) {
    const vehicle = await provider.decodeVin(car.vin).catch((error: unknown) => {
      console.error(`\n${car.label} (${car.vin}): расшифровка упала — ${(error as Error).message}`)
      return null
    })
    if (!vehicle) {
      console.error(`${car.label} (${car.vin}): каталог машину не узнал`)
      failed = true
      continue
    }
    failed = (await measureCar(vehicle, car.label, entries, { user, password })) || failed
  }

  process.exit(failed ? 1 : 0)
}

/** Прогон словаря по одной машине; true — доля молчащих записей выше порога. */
async function measureCar(
  vehicle: Vehicle,
  label: string,
  entries: readonly DictEntry[],
  auth: { user: string; password: string },
): Promise<boolean> {
  const car = [vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(' ')
  console.log(`\n=== ${label} — ${car} [epc ${vehicle.raw?.['epc'] ?? '?'}] ===`)

  // Английские термины меряются по одной выгрузке каталога: на латиницу 17vin
  // отдаёт весь подходящий VIN список, и все записи словаря проверяются локально.
  const dump = await searchRaw(vehicle, DUMP_QUERY, auth, Infinity)
  const results: EntryResult[] = []
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const chunk = entries.slice(i, i + CONCURRENCY)
    results.push(
      ...(await Promise.all(
        chunk.map(async (entry) => ({
          entry,
          zh: (await searchRaw(vehicle, entry.zh, auth).catch(() => [])).length,
          en: filterByTerms(dump, entry.en).length,
        })),
      )),
    )
  }

  const silent = results.filter((item) => item.zh === 0 && item.en === 0)
  const zhSilent = results.filter((item) => item.zh === 0)
  console.log(
    `записей: ${results.length} | молчит совсем: ${silent.length} | ` +
      `молчит по-китайски: ${zhSilent.length} | выгрузка каталога: ${dump.length} деталей`,
  )
  for (const item of silent) console.log(`  ПУСТО  ${item.entry.stems.join('+')} (${item.entry.zh})`)

  const share = results.length === 0 ? 0 : silent.length / results.length
  if (share > MAX_SILENT_SHARE) {
    console.error(
      `  ✗ словарь не покрывает этот каталог: молчит ${Math.round(share * 100)}% записей. ` +
        `Так выглядит чужой язык базы, а не редкие запчасти — см. docs/CATALOG_ADAPTERS.md`,
    )
    return true
  }
  console.log('  ✓ покрытие в норме')
  return false
}

/**
 * Один запрос 5107 без догрузки выносок: здесь меряется покрытие словаря, а
 * картинки и обводки на это не влияют и стоили бы сотен лишних вызовов.
 *
 * `limit` снимается для выгрузки: меряем весь каталог, а не первую сотню.
 */
async function searchRaw(
  vehicle: Vehicle,
  term: string,
  auth: { user: string; password: string },
  limit?: number,
): Promise<Part[]> {
  const epc = String(vehicle.raw?.['epc'] ?? '')
  if (!epc) return []

  const params = new URLSearchParams({
    action: 'search_epc_part_name',
    vin: vehicle.vin,
    query_match_type: 'inexact',
    query_part_name: safeBase64(term),
    query_part_name_is_safebase64: '1',
  })
  const path = `/${encodeURIComponent(epc)}?${params.toString()}`
  const token = buildVin17Token(auth.user, auth.password, path)
  const url = `${VIN17_DEFAULT_BASE_URL}${path}&user=${encodeURIComponent(auth.user)}&token=${token}`

  const response = await fetch(url)
  const envelope = (await response.json()) as { code?: number; data?: unknown }
  if (envelope.code !== 1 || typeof envelope.data !== 'object' || envelope.data === null) return []
  return mapParts(envelope.data as Record<string, unknown>, { brand: vehicle.make, epc, limit })
}

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? (process.argv[index + 1] ?? null) : null
}

await main()
