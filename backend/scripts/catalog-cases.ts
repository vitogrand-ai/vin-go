/**
 * Регресс каталога по ЖИВЫМ случаям, на которые жаловался пилот.
 *
 * Зачем отдельно от `catalog:names` и `catalog:coverage`: те отвечают «нашлось
 * ли хоть что-то» и «ту ли деталь показали» — глазами, по таблице. Здесь у
 * каждого случая записано ОЖИДАНИЕ, поэтому прогон отвечает «да/нет» и валится
 * ненулевым кодом. Это единственное место, где ранее починенное проверяется
 * заново: почти каждая правка поиска (порядок выдачи, выбор узла, перебор
 * названий, английские термины) чинила одну машину и ломала соседнюю, потому
 * что живьём перепроверялся только последний случай.
 *
 * Правило: починили жалобу — добавили сюда случай с VIN, запросом и тем, что
 * мастер должен был увидеть. Случаи не удаляются, даже когда «давно работает».
 * Случай, который не проходит не по нашей вине (нет данных у источника, нужна
 * работа, которой ещё не было), помечается полем `blocked` с причиной: прогон
 * он не роняет, из корзины не исчезает и сам скажет, когда починится.
 *
 * Запуск (на VPS: ключ parts-catalogs привязан к IP сервера):
 *   bun run --cwd backend catalog:cases
 *   bun run --cwd backend catalog:cases -- --only колодки
 *   bun run --cwd backend catalog:cases -- --json /tmp/cases.json
 *
 * Деньги: 17vin берёт $0.15 за НОВЫЙ VIN, повторы по тому же VIN три месяца
 * бесплатны — поэтому перезапуск корзины ничего не стоит. У parts-catalogs
 * тестовый ключ ограничен числом VIN, а не запросов.
 */
import 'dotenv/config'

import { writeFileSync } from 'node:fs'

import { partsWithVariants } from '@web-app-demo/contracts'

import { createCatalogProviders } from '../src/catalog/factory'
import { CatalogService } from '../src/catalog/service'
import { loadEnv } from '../src/env'

type Expectation = {
  /** Сколько деталей должно найтись как минимум. */
  minParts?: number
  /** Чему должна отвечать ПЕРВАЯ строка выдачи — мастер жмёт первую кнопку. */
  firstMatches?: RegExp
  /** Чего в первой строке быть не должно (сосед по узлу, крепёж, чужая сторона). */
  firstForbids?: RegExp
  /** У детали должна быть схема узла — без картинки мастер не опознаёт деталь. */
  scheme?: boolean
  /** И выноска на схеме: по её номеру работает выбор детали цифрой. */
  position?: boolean
  /** Год машины известен и не раньше указанного (ловит чужую модификацию). */
  yearFrom?: number
  /**
   * У каждого исполнения одной позиции (см. `partsWithVariants`) примечание
   * отвечает шаблону: исполнения в выдаче есть, и видно, чем они различаются.
   */
  variantNotes?: RegExp
}

type Case = {
  vin: string
  car: string
  query: string
  /** Откуда случай: дата жалобы и что мастер увидел вместо нужного. */
  origin: string
  expect: Expectation
  /**
   * Известное ограничение: случай ПОКА не проходит, и причина не в нашей
   * правке. Такой провал не роняет прогон, но и случай не удаляется — а если
   * он вдруг прошёл, корзина об этом скажет: пометку пора снимать.
   */
  blocked?: string
}

const CASES: Case[] = [
  {
    vin: 'Z8TND5FEAGM016476',
    car: 'Citroen (РФ-сборка)',
    query: 'крышка гбц',
    origin: '11.09.2026: на «крышку гбц» приходила схема расширительного бачка',
    expect: { minParts: 1, firstMatches: /крышк|cover/i, firstForbids: /бачк|прокладк|болт|шайб|пробк/i },
  },
  {
    vin: 'Z8TND5FEAGM016476',
    car: 'Citroen (РФ-сборка)',
    query: 'клапанная крышка',
    origin: '11.09.2026: то же название из словаря жаргона должно вести к той же детали',
    expect: { minParts: 1, firstMatches: /крышк|cover/i, firstForbids: /бачк|прокладк|болт|шайб/i },
  },
  {
    vin: 'UTHB11B1502018885',
    car: 'Lexus',
    query: 'крышка гбц',
    origin: '12.09.2026: первыми шли два БОЛТА крышки, сама крышка третьей',
    expect: { minParts: 1, firstMatches: /крышк|cover/i, firstForbids: /болт|bolt|шайб|washer/i },
  },
  {
    vin: 'JF1SK7LL5MG129305',
    car: 'Subaru Forester',
    query: 'колодки передние',
    origin: '12.09.2026: уходило в задний узел и в скобу «PAD CLIP», выдача пустела',
    expect: { minParts: 1, firstMatches: /колодк|pad/i, firstForbids: /скоб|clip|задн|rear/i },
  },
  {
    vin: 'LFV3B2FY2N3102396',
    car: 'VW Jetta (Китай, 2022)',
    query: 'колодки передние',
    origin: '12.09.2026: по VIN бралась первая модификация — Jetta 1992 года, детали чужие',
    expect: {
      minParts: 1,
      yearFrom: 2020,
      firstMatches: /колодк|pad/i,
      // «caliper without brake pads» — это суппорт, а не колодки: слово «pad» в
      // названии есть, детали нет. Такой сосед по узлу первой строкой не годится.
      firstForbids: /барабан|shoe|задн|rear|суппорт|caliper|without/i,
    },
  },
  {
    vin: 'WDD1770871V030773',
    car: 'Mercedes A200 (Европа)',
    query: 'капот',
    origin: '12.09.2026: год не приходил ни от одного источника — карточка уходила без года',
    expect: { yearFrom: 2010 },
  },
  {
    vin: 'KMHJN81VP8U903944',
    car: 'Hyundai',
    query: 'колодки передние',
    origin: '11.09.2026: схема узла не доходила до бота — мастер не мог опознать деталь',
    expect: { minParts: 1, scheme: true, position: true, firstMatches: /колодк|pad/i },
  },
  {
    vin: 'Z94K241BAJR066059',
    car: 'Hyundai Creta',
    query: 'коленвал',
    origin: '11.09.2026: после перебора названий по одному выдача упала с 5 деталей до нуля',
    expect: { minParts: 1 },
  },
  {
    vin: 'Z94K241BAJR066059',
    car: 'Hyundai Creta',
    query: 'катушка зажигания',
    origin: '11.09.2026: EPC пишет «COIL ASSY-IGNITION», отбор подстрокой её не узнавал',
    expect: { minParts: 1, firstMatches: /катушк|coil/i },
  },
  {
    vin: 'XW8LD6NS2LH410128',
    car: 'Skoda Kodiaq (РФ-сборка)',
    query: 'фара',
    origin: '12.09.2026: на схеме нужный жгут подписан цифрой 9 — без схемы и выносок выбор цифрой не работает',
    expect: { minParts: 1, scheme: true, position: true },
  },
  {
    vin: 'LVVDB21B9RC095635',
    car: 'Chery Tiggo 4 Pro',
    query: 'колодки тормозные',
    origin: '02.09.2026: китайский путь — «тачку определил, но запчасть не ищет»',
    expect: { minParts: 1 },
    blocked:
      'нет данных у источников: parts-catalogs открывает карточку машины, но дерева узлов ' +
      'не отдаёт совсем (groups = null, у названий «Колодки тормозные…» ноль схем), а 17vin ' +
      'машину опознаёт и на поиск детали отвечает пусто. Снимется новым источником по ' +
      'китайским машинам либо ответом parts-catalogs про дерево Chery.',
  },
  {
    vin: 'LVVDB21B9RC095635',
    car: 'Chery Tiggo 4 Pro',
    query: 'колодки передние',
    origin: '12.09.2026: вместо честного «не найдено» приходил «Насос вакуумный тормозной системы»',
    expect: { firstForbids: /насос|vacuum/i },
  },
  {
    vin: 'WVWZZZ1JZ3W386752',
    car: 'VW Golf IV',
    query: 'масляный фильтр',
    origin: 'опорная машина демо: ходовой расходник должен находиться всегда',
    expect: { minParts: 1, firstMatches: /фильтр|filter/i },
  },
  {
    vin: 'LFMGJE720DS070251',
    car: 'Toyota Prado (FAW, рынок КНР)',
    query: 'масляный фильтр',
    origin:
      '16.09.2026: машина, на которой схему отдаёт 17vin, а не parts-catalogs — ' +
      'адаптер отбрасывал illustration_img_address и callout из ответа поиска',
    expect: { minParts: 1, scheme: true, position: true },
  },
  {
    vin: 'Z6FDXXEECDFD88329',
    car: 'Ford Mondeo (РФ-сборка, 2015)',
    query: 'аккумулятор',
    origin:
      '17.09.2026: пять АКБ под позицией 10655 одним названием «Батарея аккумуляторная» — ' +
      'ёмкость и ток каталог отдавал в description, адаптер их выбрасывал; мастер выбирал ' +
      'по шильдику старого АКБ в чужом каталоге (нужен 1917577, 75AH 700A)',
    expect: {
      minParts: 5,
      firstMatches: /батаре|аккумул|battery/i,
      scheme: true,
      position: true,
      variantNotes: /\d\s*A\s*H|\d\s*Ач/i,
    },
  },
  {
    vin: 'XW8LD6NS2LH410128',
    car: 'Skoda Kodiaq (РФ-сборка)',
    query: 'фара',
    origin:
      '17.09.2026: найдено разбором АКБ Ford — четыре «Фара головного света» подряд, ' +
      'левая или правая, видно только в описании каталога',
    expect: { minParts: 2, variantNotes: /слева|справа|лев|прав/i },
  },
  {
    vin: 'SAJAA04M6FPU46282',
    car: 'Jaguar XF 2.0T (2014)',
    query: 'фильтр масляный',
    origin:
      '18.09.2026: «По этому запросу ничего не найдено» в боте. 17vin машину узнаёт, но база ' +
      'каталога jaguar английская: китайский термин словаря (机油滤清器) не находит ничего, ' +
      'деталь зовётся «Oil filter». Так промахивались 36 терминов словаря из 68',
    expect: { minParts: 1, firstMatches: /масл|oil/i, firstForbids: /поддон|отстой|sediment|прокладк|болт/i },
  },
  {
    vin: 'SAJAA04M6FPU46282',
    car: 'Jaguar XF 2.0T (2014)',
    query: 'колодки передние',
    origin:
      '18.09.2026: найдено разбором масляного фильтра Jaguar — по родовому английскому «pad» ' +
      'в выдачу шли накладки бампера и подушки сидений; колодки в этом каталоге подписаны ' +
      '«Brake pad tool»',
    expect: { minParts: 1, firstMatches: /колод|тормоз|brake pad/i, firstForbids: /бампер|сиден|bumper|seat/i },
  },  {
    vin: 'XW8LD6NS2LH410128',
    car: 'Skoda Kodiaq (РФ-сборка)',
    query: 'маслоотделитель',
    origin:
      '22.09.2026, прогон всех машин корзины: «маслоотделитель» разворачивался словарём жаргона в ' +
      '«моторное масло, масло на двигатель…», и мастер получал масло вместо детали. Каталог сам ' +
      'деталь знает — «Маслоотделитель вентиляции картера»',
    expect: { minParts: 1, firstMatches: /маслоотдел|вентиляц|separator/i, firstForbids: /^масло\s|моторн|трансмисс/i },
  },
  {
    vin: 'WVWZZZ1JZ3W386752',
    car: 'VW Golf IV',
    query: 'маслоотделитель',
    origin:
      '22.09.2026, прогон всех машин корзины: «маслоотделитель» разворачивался словарём жаргона в ' +
      '«моторное масло, масло на двигатель…», и мастер получал масло вместо детали. Каталог сам ' +
      'деталь знает — «Маслоотделитель вентиляции картера»',
    expect: { minParts: 1, firstMatches: /маслоотдел|вентиляц|separator/i, firstForbids: /^масло\s|моторн|трансмисс/i },
  },
  {
    vin: 'LVVDB21B9RC095635',
    car: 'Chery Tiggo 4 Pro',
    query: 'бампер',
    origin: '22.09.2026, прогон всех машин корзины: первой строкой «Направляющая бампера», самого бампера нет',
    expect: { minParts: 1, firstMatches: /бампер/i, firstForbids: /направляющ|кронштейн|крепл|накладк/i },
    blocked:
      'нет данных у источника: названия «Бампер передний»/«Бампер задний» parts-catalogs знает, но ' +
      'schemas по ним для этой машины отдаёт пустой list (живьём 22.09.2026); схема есть только у ' +
      '«Направляющей бампера», её поиск и отдаёт — под своим честным названием. Снимется, когда ' +
      'каталог получит дерево Chery, либо новым источником по китайским машинам.',
  },
  {
    vin: 'Z8TND5FEAGM016476',
    car: 'Citroen (РФ-сборка)',
    query: 'бампер',
    origin: '22.09.2026, прогон всех машин корзины: «ничего не найдено», у остальных машин бампер находится',
    expect: { minParts: 1, firstMatches: /бампер/i },
  },
  {
    vin: 'WVWZZZ1JZ3W386752',
    car: 'VW Golf IV',
    query: 'бампер',
    origin: '22.09.2026, прогон всех машин корзины: «ничего не найдено», у VW Jetta и Skoda тот же запрос работает',
    expect: { minParts: 1, firstMatches: /бампер/i },
  },  {
    vin: 'XW8LD6NS2LH410128',
    car: 'Skoda Kodiaq (РФ-сборка)',
    query: 'генератор',
    origin:
      '22.09.2026, замер 13 машин × 35 запросов: генератор, стартер, термостат и ещё пять ходовых ' +
      'деталей не находились НИ НА ОДНОЙ машине. Каталог на schemas?partNameIds отдавал одну схему на ' +
      'любую деталь; найдено через дерево узлов машины (groups-tree → schemas?branchId)',
    expect: { minParts: 1, firstMatches: /^генератор/i, scheme: true },
  },
  {
    vin: 'Z6FDXXEECDFD88329',
    car: 'Ford Mondeo (РФ-сборка, 2015)',
    query: 'сцепление',
    origin:
      '22.09.2026, замер 13 машин × 35 запросов: генератор, стартер, термостат и ещё пять ходовых ' +
      'деталей не находились НИ НА ОДНОЙ машине. Каталог на schemas?partNameIds отдавал одну схему на ' +
      'любую деталь; найдено через дерево узлов машины (groups-tree → schemas?branchId)',
    expect: { minParts: 1, firstMatches: /сцеплен/i, scheme: true },
  },  {
    vin: 'LFMGJE720DS070251',
    car: 'Toyota Prado (FAW, рынок КНР)',
    query: 'тормозные диски',
    origin:
      '22.09.2026: каталог на schemas?partNameIds отдал узел «Генератор», и мастер получил «Ротор - якорь ' +
      'генератора» (ротор — синоним тормозного диска). Чужой узел теперь отсекается по nameId',
    expect: { minParts: 1, firstMatches: /диск/i, firstForbids: /генератор|якорь/i },
  },
  {
    vin: 'WDD1770871V030773',
    car: 'Mercedes A200 (Европа)',
    query: 'ремень грм',
    origin:
      '22.09.2026: запрос укорачивался до «ремень», и приходил ремень безопасности (16 штук). У M270 цепь, ' +
      'честный ответ — «не найдено»',
    expect: { firstForbids: /безопасн|приводн/i },
  },
  {
    vin: 'JF1SK7LL5MG129305',
    car: 'Subaru Forester',
    query: 'стойка стабилизатора',
    origin:
      '22.09.2026: первой строкой «Тяга рулевая» из узла рулевой рейки. У subaru нет nameId, поэтому чужой ' +
      'узел по якорю не отсекается, а «тяга» совпадает с синонимом «тяга стабилизатора»',
    expect: { minParts: 1, firstMatches: /стабилиз|stabil/i, firstForbids: /рулев|steer/i },
  },
  {
    vin: 'XW8LD6NS2LH410128',
    car: 'Skoda Kodiaq',
    query: 'гранатка',
    origin:
      '23.09.2026: schemas?partNameIds на сервере отдавал давние чужие схемы, дерево брало только листья, ' +
      'названные деталью, — ШРУС в «Привод колеса > Приводной вал» не находился. Ловушка: лист с тем же ' +
      'именем в «ГСМ» (смазка)',
    expect: { minParts: 1, firstMatches: /шрус/i, firstForbids: /пыльник|смазк/i },
  },
  {
    vin: 'WVWZZZ1JZ3W386752',
    car: 'VW Golf IV',
    query: 'шаровая',
    origin: '23.09.2026: пусто — шаровая лежит в рычагах подвески, узел своим именем её не называет',
    expect: { minParts: 1, firstMatches: /шаров/i },
  },
  {
    vin: 'WDD1770871V030773',
    car: 'Mercedes A200 (Европа)',
    query: 'крышка расширительного бачка',
    origin: '23.09.2026: пусто — крышка лежит в узле «Бачок расширительный»',
    expect: { minParts: 1, firstMatches: /крышка расширительного/i },
  },
  {
    vin: 'XW8LD6NS2LH410128',
    car: 'Skoda Kodiaq',
    query: 'крышка расширительного бачка',
    origin:
      '23.09.2026: пусто — листья «Крышка багажника», «Крышка ГБЦ» (общее слово) вытесняли подсказанный ' +
      '«Бачок расширительный» из трёх раскрываемых листьев дерева',
    expect: { minParts: 1, firstMatches: /крышка расширительного/i },
  },
  {
    vin: 'LFMGJE720DS070251',
    car: 'Toyota Land Cruiser Prado',
    query: 'шаровая',
    origin:
      '23.09.2026: первой шла «NUT, CASTLE (FOR FRONT LOWER BALL JOINT RH)» — гайка для шаровой; ' +
      'английский термин ловился в скобках с применимостью',
    expect: { firstForbids: /\bnut\b|гайк/i },
  },
  {
    vin: 'KMHJN81VP8U903944',
    car: 'Hyundai Tucson 2008',
    query: 'лампа ближнего света',
    origin:
      '23.09.2026: «не найдено». Справочник знает только «Лампа», в узле «Фары» лампы так и зовутся, ' +
      'а лист «Лампа» ведёт в лампу багажника',
    expect: { minParts: 1, firstMatches: /ламп/i, scheme: true },
  },
  {
    vin: 'KMHJN81VP8U903944',
    car: 'Hyundai Tucson 2008',
    query: 'колодки передние',
    origin:
      '23.09.2026, замер после таблицы part-nodes: первыми шли «Колодки тормозные барабанные» — ' +
      'это задние, передние колодки барабанными не бывают',
    expect: { minParts: 1, firstMatches: /колодк/i, firstForbids: /барабан|drum|shoe/i },
  },
  {
    vin: 'Z8TND5FEAGM016476',
    car: 'Citroen (РФ-сборка)',
    query: 'датчик положения коленвала',
    origin:
      '23.09.2026, замер: первой строкой «Коленвал» — словарь жаргона разворачивал запрос в вариант ' +
      '«коленчатый вал», и поиск по варианту отдавал сам вал',
    expect: { firstForbids: /^коленвал$|^crankshaft$/i },
  },
  {
    vin: 'WVWZZZ1JZ3W386752',
    car: 'VW Golf IV',
    query: 'главный цилиндр сцепления',
    origin: '23.09.2026, замер: первой строкой «Цилиндр тормозной главный» — тормозной вместо сцепления',
    expect: { firstForbids: /тормоз|brake/i },
  },
  {
    vin: 'JF1SK7LL5MG129305',
    car: 'Subaru Forester',
    query: 'воздушный фильтр',
    origin:
      '25.09.2026, кнопка «Детали ТО» в вебе: первой строкой шёл BRACKET-AIR CLEANER — кронштейн корпуса, ' +
      'а не фильтр: исключения строки таблицы не знали кронштейн, хомут и патрубок',
    expect: { minParts: 1, firstMatches: /фильтр|element|air cleaner/i, firstForbids: /bracket|кронштейн|clamp|duct|hose/i },
  },
]

type Result = {
  case: Case
  ok: boolean
  problems: string[]
  found: number
  first: string | null
  year: number | null
  error: string | null
}

async function main() {
  const { only, json } = parseArgs(Bun.argv.slice(2))
  const cases = only
    ? CASES.filter((item) => `${item.query} ${item.car} ${item.vin}`.toLowerCase().includes(only.toLowerCase()))
    : CASES

  if (cases.length === 0) {
    console.error(`Под «${only}» не подошёл ни один случай.`)
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
  console.log(
    `Случаев: ${cases.length} | уникальных VIN: ${new Set(cases.map((item) => item.vin)).size}` +
      ` | каталоги: ${providers.meta.catalog.names.join('+')}\n`,
  )

  const results: Result[] = []
  for (const item of cases) {
    const result = await check(service, item)
    results.push(result)
    print(result)
  }

  const failed = results.filter((result) => !result.ok && !result.case.blocked)
  const known = results.filter((result) => !result.ok && result.case.blocked)
  const revived = results.filter((result) => result.ok && result.case.blocked)
  console.log(
    `\nпрошло: ${results.filter((result) => result.ok).length} из ${results.length}` +
      (known.length > 0 ? ` | известных ограничений: ${known.length}` : ''),
  )
  if (failed.length > 0) {
    console.log('провалились:')
    for (const result of failed) {
      console.log(`  ${result.case.car} «${result.case.query}» — ${result.problems.join('; ')}`)
      console.log(`    жалоба: ${result.case.origin}`)
    }
  }
  for (const result of known) {
    console.log(`известное ограничение: ${result.case.car} «${result.case.query}» — ${result.case.blocked}`)
  }
  for (const result of revived) {
    console.log(
      `случай ${result.case.car} «${result.case.query}» помечен ограничением, но ПРОШЁЛ — снимите blocked`,
    )
  }

  if (json) {
    writeFileSync(
      json,
      JSON.stringify(
        results.map((result) => ({ ...result, case: { ...result.case, expect: undefined } })),
        null,
        2,
      ),
      'utf8',
    )
    console.log(`\nОтчёт: ${json}`)
  }

  process.exit(failed.length > 0 ? 1 : 0)
}

async function check(service: CatalogService, item: Case): Promise<Result> {
  const problems: string[] = []
  try {
    const response = await service.searchParts(item.vin, item.query)
    const first = response.parts[0] ?? null
    const year = response.vehicle.year ?? null
    const expect = item.expect

    if (expect.yearFrom !== undefined && (year === null || year < expect.yearFrom)) {
      problems.push(`год машины ${year ?? 'не пришёл'} (ожидали от ${expect.yearFrom})`)
    }
    if (expect.minParts !== undefined && response.parts.length < expect.minParts) {
      problems.push(`нашлось ${response.parts.length} деталей (ожидали от ${expect.minParts})`)
    }
    if (first) {
      if (expect.firstMatches && !expect.firstMatches.test(first.name)) {
        problems.push(`первой строкой «${first.name}» — не та деталь`)
      }
      if (expect.firstForbids && expect.firstForbids.test(first.name)) {
        problems.push(`первой строкой «${first.name}» — сосед по узлу или чужая сторона`)
      }
      if (expect.scheme && !first.imageUrl) {
        problems.push('у детали нет схемы узла')
      }
      if (expect.position && !first.position) {
        problems.push('у детали нет выноски на схеме — выбор цифрой не сработает')
      }
    }
    if (expect.variantNotes) {
      const variants = partsWithVariants(response.parts)
      const blind = response.parts.filter(
        (part) => variants.has(part.oemNumber) && !expect.variantNotes!.test(part.note ?? ''),
      )
      if (variants.size === 0) problems.push('исполнений одной позиции в выдаче нет')
      else if (blind.length > 0) {
        problems.push(`исполнения без различия в примечании: ${blind.map((part) => part.oemNumber).join(', ')}`)
      }
    }

    return {
      case: item,
      ok: problems.length === 0,
      problems,
      found: response.parts.length,
      first: first?.name ?? null,
      year,
      error: null,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      case: item,
      ok: false,
      problems: [`сбой: ${message}`],
      found: 0,
      first: null,
      year: null,
      error: message,
    }
  }
}

function print(result: Result): void {
  const head = `${result.case.car} «${result.case.query}»`.padEnd(46)
  if (result.ok) {
    const first = result.first ? ` → ${result.first}` : ''
    console.log(`  OK       ${head}${first}  ×${result.found}`)
    return
  }
  console.log(`  ${result.case.blocked ? 'ИЗВЕСТНО' : 'ПРОВАЛ  '} ${head}${result.problems.join('; ')}`)
}

function parseArgs(argv: string[]) {
  let only: string | null = null
  let json: string | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--only') {
      const value = argv[++index]
      if (!value) throw new Error('После --only нужна подстрока: марка, VIN или запрос')
      only = value
      continue
    }
    if (arg === '--json') {
      const value = argv[++index]
      if (!value) throw new Error('После --json нужен путь к файлу')
      json = value
    }
  }

  return { only, json }
}

await main()
