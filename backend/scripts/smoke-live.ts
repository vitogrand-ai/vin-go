/**
 * Живой смоук боевого адреса — «три проверки после деплоя» из POSTMORTEM
 * (класс 1: «готово» без живой проверки), но машиной, а не по памяти.
 *
 * Что проверяет и что значит провал:
 *   1. `/health`            — служба `vingo-api` жива и отвечает через Caddy.
 *   2. `/`                  — страница вебаппа отдаётся (статика на месте).
 *   3. `/api/catalog/status` — каталог боевой, а не мок (ключи в .env на месте).
 *   4. живой поиск          — известная машина из корзины случаев даёт деталь со
 *                             схемой: ключи не протухли, цепочка поиска цела.
 *
 * Запуск (с любой машины; снаружи проверяется и Caddy):
 *   bun run --cwd backend smoke:live -- http://138.16.227.185
 *   bun run --cwd backend smoke:live -- http://127.0.0.1:3000 --api-only   # на сервере
 *
 * Запрос уходит из bun настоящим UTF-8 — это снимает грабли `curl` с Windows,
 * где кириллица в теле превращалась в «????» и выглядела как регрессия поиска.
 *
 * Деньги: VIN ниже уже есть в кэше vin_decodes прода (60 дней), квота
 * parts-catalogs на него не тратится. Ответ бота проверяется руками — polling
 * нельзя опросить снаружи, не отняв обновления у работающего бота.
 */

type Check = { name: string; ok: boolean; detail: string; next?: string }

/** Машина из корзины живых случаев: parts-catalogs знает, схема есть. */
const LIVE_CASE = { vin: 'LFV3B2FY2N3102396', query: 'колодки передние', car: 'VW Jetta (КНР)' }

const REQUEST_TIMEOUT_MS = 40_000

async function main() {
  const { base, apiOnly } = parseArgs(Bun.argv.slice(2))
  console.log(`Смоук ${base}${apiOnly ? ' (только API)' : ''}\n`)

  const checks: Check[] = []
  checks.push(await checkHealth(base))
  if (!apiOnly) checks.push(await checkPage(base))
  checks.push(await checkStatus(base))
  checks.push(await checkSearch(base))

  for (const check of checks) {
    console.log(`  ${check.ok ? 'OK     ' : 'ПРОВАЛ '} ${check.name.padEnd(28)} ${check.detail}`)
    if (!check.ok && check.next) console.log(`         → ${check.next}`)
  }

  const failed = checks.filter((check) => !check.ok)
  console.log(
    failed.length === 0
      ? '\nВсё отвечает. Осталось руками: пришлите боту VIN и название детали — ответ должен прийти со схемой.'
      : `\nПровалов: ${failed.length}. Деплой не считается законченным.`,
  )
  process.exit(failed.length === 0 ? 0 : 1)
}

async function checkHealth(base: string): Promise<Check> {
  const name = 'GET /health'
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    const body = (await res.json().catch(() => null)) as { status?: string } | null
    if (res.ok && body?.status === 'ok') return { name, ok: true, detail: `HTTP ${res.status}, status ok` }
    return {
      name,
      ok: false,
      detail: `HTTP ${res.status}`,
      next: 'ssh vingo "systemctl status vingo-api caddy" — служба или прокси не подняты',
    }
  } catch (error) {
    return {
      name,
      ok: false,
      detail: describe(error),
      next: 'Порты не отвечают: если ping есть, а TCP refused — состояние VM в панели AdminVPS',
    }
  }
}

async function checkPage(base: string): Promise<Check> {
  const name = 'GET / (страница)'
  try {
    const res = await fetch(`${base}/`, {
      headers: { Accept: 'text/html' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const html = await res.text()
    const looksLikeApp = /<div id="root">/i.test(html) && /VINGO/i.test(html)
    if (res.ok && looksLikeApp) return { name, ok: true, detail: `HTTP ${res.status}, вебапп на месте` }
    return {
      name,
      ok: false,
      detail: `HTTP ${res.status}, ${looksLikeApp ? 'страница есть' : 'это не страница вебаппа'}`,
      next: 'Статика не залита или Caddy отдаёт не тот каталог: проверьте /opt/vingo/app/webapp/dist',
    }
  } catch (error) {
    return { name, ok: false, detail: describe(error), next: 'Caddy не отвечает на :80' }
  }
}

async function checkStatus(base: string): Promise<Check> {
  const name = 'GET /api/catalog/status'
  try {
    const res = await fetch(`${base}/api/catalog/status`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    const body = (await res.json().catch(() => null)) as {
      catalog?: { names: string[]; demo: boolean }
      suppliers?: { names: string[]; demo: boolean }
    } | null
    if (!res.ok || !body?.catalog) {
      return { name, ok: false, detail: `HTTP ${res.status}`, next: 'API за Caddy не отвечает JSON-ом' }
    }
    const catalog = `каталог: ${body.catalog.names.join('+') || 'нет'}`
    const suppliers = `поставщики: ${body.suppliers?.demo ? 'ДЕМО-цены' : body.suppliers?.names.join('+')}`
    if (body.catalog.demo) {
      return {
        name,
        ok: false,
        detail: `${catalog} (мок!), ${suppliers}`,
        next: 'В /opt/vingo/app/backend/.env нет ключей каталога — вписать и перезапустить vingo-api и vingo-tgbot',
      }
    }
    return { name, ok: true, detail: `${catalog}, ${suppliers}` }
  } catch (error) {
    return { name, ok: false, detail: describe(error) }
  }
}

async function checkSearch(base: string): Promise<Check> {
  const name = `поиск ${LIVE_CASE.car}`
  const started = Date.now()
  try {
    const res = await fetch(`${base}/api/catalog/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ vin: LIVE_CASE.vin, query: LIVE_CASE.query }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    const body = (await res.json().catch(() => null)) as {
      parts?: { name: string; imageUrl?: string | null }[]
      error?: { message?: string }
    } | null
    if (!res.ok) {
      return {
        name,
        ok: false,
        detail: `HTTP ${res.status} за ${seconds} с: ${body?.error?.message ?? 'без текста'}`,
        next:
          res.status === 502
            ? 'Каталог отказал: ключ истёк или квота кончилась — журнал `journalctl -u vingo-api | grep catalog:`'
            : 'Смотрите журнал vingo-api',
      }
    }
    const parts = body?.parts ?? []
    if (parts.length === 0) {
      return {
        name,
        ok: false,
        detail: `0 деталей за ${seconds} с`,
        next: 'На сервере: `bun run catalog:cases` — какие случаи упали; в журнале — [catalog:miss]',
      }
    }
    const withScheme = parts.filter((part) => part.imageUrl).length
    const first = parts[0]!.name
    if (withScheme === 0) {
      return {
        name,
        ok: false,
        detail: `${parts.length} деталей, первая «${first}», но без схем за ${seconds} с`,
        next: 'Схемы не добираются: проверьте источник со схемами в /api/catalog/status',
      }
    }
    return { name, ok: true, detail: `${parts.length} деталей, «${first}», со схемой ${withScheme}, ${seconds} с` }
  } catch (error) {
    return { name, ok: false, detail: describe(error), next: 'Поиск не ответил за 40 с — источник висит' }
  }
}

function parseArgs(argv: string[]): { base: string; apiOnly: boolean } {
  let base = Bun.env.SMOKE_BASE_URL ?? ''
  let apiOnly = false
  for (const arg of argv) {
    if (arg === '--api-only') apiOnly = true
    else if (arg.startsWith('http://') || arg.startsWith('https://')) base = arg
  }
  if (!base) {
    console.error('Укажите адрес: bun run smoke:live -- http://138.16.227.185 [--api-only]')
    process.exit(2)
  }
  return { base: base.replace(/\/+$/, ''), apiOnly }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.name === 'TimeoutError' ? 'таймаут' : error.message
  return String(error)
}

await main()
