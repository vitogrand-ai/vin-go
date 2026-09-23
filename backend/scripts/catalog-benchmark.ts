/**
 * Замер поиска по сетке «ходовые детали × машины пилота»: какая доля запросов
 * мастера даёт ПРАВИЛЬНУЮ деталь первой строкой.
 *
 * Зачем, если есть `catalog:cases`: корзина проверяет починенные жалобы, то
 * есть то, о чём мы уже знаем. Здесь — то, о чём ещё не знаем: около 150
 * запросов, как их пишут в чате СТО, на каждой машине пилота. У каждого
 * запроса записано, какой должна быть первая строка, поэтому прогон считает
 * не «что-то нашлось», а «нашлось то». Итоговая цифра — мерило любой правки
 * поиска: запускать до и после.
 *
 * Запуск (ключ parts-catalogs больше не привязан к IP, работает и локально):
 *   bun run --cwd backend catalog:benchmark
 *   bun run --cwd backend catalog:benchmark -- --out ../.scratch/benchmark
 *   bun run --cwd backend catalog:benchmark -- --only-car Hyundai --only-section Свет
 *
 * Деньги: машины те же, что в `catalog:cases`, — новых VIN в квоте не тратит.
 */
import 'dotenv/config'

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createCatalogProviders } from '../src/catalog/factory'
import { CatalogService } from '../src/catalog/service'
import { loadEnv } from '../src/env'

export type Probe = {
  query: string
  /** Чему отвечает правильная первая строка (русское и английское название). */
  expect: RegExp
  /** Что в первой строке значит чужую деталь, хоть она и подходит под expect. */
  forbid?: RegExp
  /** Детали нет у части машин (турбина, цепь ГРМ): пустой ответ тут не провал. */
  optional?: boolean
}

export type Section = { name: string; probes: Probe[] }

const LAMP = /ламп|bulb/i
const OIL_FILTER = /фильтр.*масл|масл.*фильтр|oil filter|filter.*oil|element.*oil/i
const PADS = /колодк|колодок|brake pad|pad kit|pad set|\bpads?\b(?!.*(clip|shim|wear|sensor))/i
const PADS_FORBID = /датчик|клипс|скоб|пружин|clip|shim|sensor|spring/i
const SHOCK = /амортизатор|shock|absorber|strut/i
const SHOCK_FORBID = /опор|пыльник|отбойник|буфер|mount|boot|bump|пружин|spring/i
const CV = /шрус|шарнир|\bcv\b|drive ?shaft|привод/i
const ENGINE_MOUNT = /опор.*(двигат|силов)|подушк|engine mount|mount.*engine|insulator|bracket.*engine/i
const WIPER = /щетк|щётк|wiper blade|blade.*wiper|стеклоочист/i
const WIPER_FORBID = /мотор|motor|рычаг|arm|трапец|link|форсунк|nozzle/i

export const SECTIONS: Section[] = [
  {
    name: 'ТО',
    probes: [
      { query: 'масляный фильтр', expect: OIL_FILTER },
      { query: 'фильтр масляный', expect: OIL_FILTER },
      { query: 'масло фильтр', expect: OIL_FILTER },
      { query: 'воздушный фильтр', expect: /фильтр.*возд|возд.*фильтр|air cleaner|air filter|element.*air/i },
      { query: 'воздухан', expect: /фильтр.*возд|возд.*фильтр|air cleaner|air filter|element.*air/i },
      { query: 'салонный фильтр', expect: /салон|cabin|pollen|фильтр.*(кондицион|вентиляц)|filter.*(clean air|a\/c|conditioner)/i },
      { query: 'топливный фильтр', expect: /фильтр.*топлив|топлив.*фильтр|fuel filter|filter.*fuel/i },
      { query: 'свечи зажигания', expect: /свеч|spark plug|plug.*spark/i, forbid: /накал|glow|провод|wire/i },
      { query: 'свечи', expect: /свеч|spark plug|plug/i },
      { query: 'свеча накала', expect: /накал|glow plug/i, optional: true },
      { query: 'ремень грм', expect: /ремень.*(грм|зубчат|газораспредел)|timing belt|belt.*timing/i, optional: true },
      { query: 'цепь грм', expect: /цеп|timing chain|chain.*timing/i, forbid: /натяжит|успокоит|tensioner|guide/i, optional: true },
      { query: 'ремень генератора', expect: /ремень|v-?ribbed|drive belt|fan belt|belt/i, forbid: /грм|timing|натяжит|tensioner|ролик|pulley/i },
      { query: 'натяжитель ремня', expect: /натяжит|tensioner/i },
      { query: 'обводной ролик', expect: /ролик|pulley|idler/i },
      { query: 'дворники', expect: WIPER, forbid: WIPER_FORBID },
      { query: 'щетки стеклоочистителя', expect: WIPER, forbid: WIPER_FORBID },
      { query: 'аккумулятор', expect: /аккумулятор|батаре|battery/i, forbid: /кронштейн|крепл|клемм|bracket|clamp|terminal|tray/i },
    ],
  },
  {
    name: 'Тормоза',
    probes: [
      { query: 'колодки', expect: PADS, forbid: PADS_FORBID },
      { query: 'тормозные колодки', expect: PADS, forbid: PADS_FORBID },
      { query: 'колодки передние', expect: PADS, forbid: PADS_FORBID },
      { query: 'колодки задние', expect: PADS, forbid: PADS_FORBID },
      { query: 'тормозные диски', expect: /диск.*тормоз|тормоз.*диск|brake disc|disc.*brake|rotor/i, forbid: /колодк|pad|сцеплен|clutch/i },
      { query: 'диск тормозной передний', expect: /диск.*тормоз|тормоз.*диск|brake disc|disc.*brake|rotor/i, forbid: /колодк|pad/i },
      { query: 'тормозной барабан', expect: /барабан|drum/i, optional: true },
      { query: 'суппорт', expect: /суппорт|скоба тормоз|caliper/i, forbid: /колодк|pad|направляющ|guide|пыльник|boot|ремкомплект|repair kit/i },
      { query: 'тормозной шланг', expect: /шланг|hose|flexible/i },
      { query: 'датчик абс', expect: /датчик|sensor/i, forbid: /износ|wear|температ|temp/i },
      { query: 'трос ручника', expect: /трос|cable/i },
      { query: 'главный тормозной цилиндр', expect: /главн.*цилиндр|цилиндр.*главн|master cylinder|cylinder.*master/i },
      { query: 'датчик износа колодок', expect: /датчик.*износ|wear|indicator/i },
    ],
  },
  {
    name: 'Ходовая',
    probes: [
      { query: 'амортизатор передний', expect: SHOCK, forbid: SHOCK_FORBID },
      { query: 'амортизатор задний', expect: SHOCK, forbid: SHOCK_FORBID },
      { query: 'передняя стойка', expect: SHOCK, forbid: /стабилиз|stabil|опор|mount|пыльник|boot/i },
      { query: 'пружина передняя', expect: /пружин|spring/i, forbid: /клапан|valve|тормоз|brake/i },
      { query: 'опора амортизатора', expect: /опор|mount|support|insulator/i, forbid: /двигат|engine|шаров|ball/i },
      { query: 'отбойник', expect: /отбойник|буфер|bump|stopper|rebound/i },
      { query: 'пыльник амортизатора', expect: /пыльник|кожух|чехол|boot|dust|cover/i },
      { query: 'стойка стабилизатора', expect: /стойк.*стабил|тяг.*стабил|link.*stabil|stabil.*link|sway bar link/i },
      { query: 'втулка стабилизатора', expect: /втулк|bush/i, forbid: /рычаг|arm(?!.*stabil)/i },
      { query: 'шаровая', expect: /шаров|ball joint|joint.*ball/i, forbid: /гайк|болт|пыльник|nut|bolt|boot/i },
      { query: 'шаровая опора', expect: /шаров|ball joint|joint.*ball/i, forbid: /гайк|болт|пыльник|nut|bolt|boot/i },
      { query: 'рычаг передний нижний', expect: /рычаг|arm/i, forbid: /сайлентблок|втулк|bush|болт|bolt|шаров|ball/i },
      { query: 'сайлентблок рычага', expect: /сайлентблок|втулк|bush/i },
      { query: 'ступичный подшипник', expect: /подшипник|bearing|ступиц|hub/i, forbid: /генератор|alternator|кпп|transmission|сальник|seal/i },
      { query: 'ступица', expect: /ступиц|hub/i, forbid: /болт|гайк|колпак|bolt|nut|cap/i },
      { query: 'рулевой наконечник', expect: /наконечник|tie rod end|end.*tie rod|rod end/i },
      { query: 'рулевая тяга', expect: /тяг.*рул|рул.*тяг|tie rod|rod.*tie|inner/i, forbid: /стабил|stabil|наконечник|end\b/i },
      { query: 'рулевая рейка', expect: /рейк|механизм рулев|рулев.*механизм|steering gear|gear.*steering|rack/i, forbid: /пыльник|boot|тяг|rod|наконечник/i },
      { query: 'пыльник рулевой рейки', expect: /пыльник|чехол|гофр|boot|bellows/i },
      { query: 'насос гур', expect: /насос|pump/i },
      { query: 'гранатка', expect: CV, forbid: /пыльник|хомут|смазк|boot|clamp|grease/i },
      { query: 'шрус наружный', expect: CV, forbid: /пыльник|хомут|смазк|boot|clamp|grease/i },
      { query: 'пыльник шруса', expect: /пыльник|чехол|boot/i },
      { query: 'полуось', expect: /полуос|привод|вал|drive ?shaft|axle|shaft/i, forbid: /пыльник|boot|сальник|seal/i },
    ],
  },
  {
    name: 'Двигатель',
    probes: [
      { query: 'помпа', expect: /насос.*(охлажд|водян)|помп|water pump|pump.*water|coolant pump/i },
      { query: 'насос водяной', expect: /насос.*(охлажд|водян)|помп|water pump|pump.*water|coolant pump/i },
      { query: 'термостат', expect: /термостат|thermostat/i, forbid: /прокладк|gasket|корпус|housing|датчик|sensor/i },
      { query: 'радиатор охлаждения', expect: /радиатор|radiator/i, forbid: /кондиц|condenser|отопит|heater|крышк|cap|шланг|патрубок|hose|вентилятор|fan/i },
      { query: 'расширительный бачок', expect: /бач|reservoir|tank/i, forbid: /крышк|cap|омыв|washer/i },
      { query: 'крышка расширительного бачка', expect: /крышк|пробк|cap/i },
      { query: 'вентилятор радиатора', expect: /вентилятор|fan/i, forbid: /отопит|heater|салон|blower|ремень|belt/i },
      { query: 'патрубок радиатора', expect: /патрубок|шланг|hose/i },
      { query: 'датчик температуры', expect: /датчик.*температ|температ.*датчик|temperature|sensor.*temp|thermo/i },
      { query: 'клапанная крышка', expect: /крышк|cover/i, forbid: /прокладк|gasket|болт|bolt|бач|tank|маслозалив|oil filler/i },
      { query: 'прокладка клапанной крышки', expect: /прокладк|gasket|seal/i },
      { query: 'прокладка гбц', expect: /прокладк|gasket/i, forbid: /крышк|cover|коллектор|manifold/i },
      { query: 'головка блока цилиндров', expect: /головк|гбц|cylinder head|head/i, forbid: /прокладк|gasket|болт|bolt|крышк|cover/i },
      { query: 'сальник коленвала', expect: /сальник|seal/i },
      { query: 'сальник распредвала', expect: /сальник|seal/i },
      { query: 'поршневые кольца', expect: /кольц|ring/i },
      { query: 'поршень', expect: /поршен|piston/i, forbid: /кольц|палец|ring|pin/i },
      { query: 'коленвал', expect: /коленвал|коленчат|crankshaft/i, forbid: /датчик|sensor|сальник|seal|шкив|pulley|вкладыш|bearing|шестерн|gear|sprocket/i },
      { query: 'распредвал', expect: /распредвал|распределит.*вал|camshaft/i, forbid: /датчик|sensor|сальник|seal|шестерн|gear|sprocket/i },
      { query: 'вкладыши', expect: /вкладыш|bearing/i },
      { query: 'подушка двигателя', expect: ENGINE_MOUNT },
      { query: 'подушка', expect: ENGINE_MOUNT },
      { query: 'поддон картера', expect: /поддон|oil pan|pan.*oil|sump/i, forbid: /пробк|прокладк|plug|gasket|болт|bolt/i },
      { query: 'датчик давления масла', expect: /датчик|sensor|switch/i },
      { query: 'масляный насос', expect: /насос|pump/i, forbid: /топлив|fuel|вод|water|охлажд/i },
      { query: 'маслоотделитель', expect: /маслоотдел|сепаратор|separator|вентиляц.*картер|breather/i },
      { query: 'клапан егр', expect: /egr|рециркуляц/i, optional: true },
      { query: 'дроссельная заслонка', expect: /дроссел|throttle/i },
      { query: 'датчик положения коленвала', expect: /датчик|sensor/i },
      { query: 'датчик распредвала', expect: /датчик|sensor/i },
      { query: 'лямбда', expect: /лямбд|кислород|oxygen|o2 sensor|sensor.*oxygen/i },
      { query: 'лямбда зонд', expect: /лямбд|кислород|oxygen|o2 sensor|sensor.*oxygen/i },
      { query: 'дмрв', expect: /расход.*воздух|air flow|mass air|flow.*sensor|дмрв|датчик.*воздух/i },
      { query: 'форсунка', expect: /форсунк|инжектор|injector/i, forbid: /омыв|washer|уплотн|кольц|seal|ring/i },
      { query: 'бензонасос', expect: /насос|pump/i, forbid: /вод|water|охлажд|масл|oil|омыв|washer/i },
      { query: 'катушка зажигания', expect: /катушк|coil/i },
      { query: 'турбина', expect: /турбо|турбин|turbo/i, forbid: /патрубок|шланг|прокладк|hose|gasket|pipe/i, optional: true },
      { query: 'впускной коллектор', expect: /коллектор|manifold/i, forbid: /выпуск|exhaust|прокладк|gasket/i },
      { query: 'выпускной коллектор', expect: /коллектор|manifold/i, forbid: /впуск|intake|прокладк|gasket/i },
    ],
  },
  {
    name: 'Выхлоп',
    probes: [
      { query: 'глушитель', expect: /глушител|muffler|silencer/i, forbid: /подвес|кронштейн|хомут|hanger|bracket|clamp|прокладк|gasket/i },
      { query: 'катализатор', expect: /каталит|катализатор|converter|catalyst/i },
      { query: 'гофра глушителя', expect: /гофр|сильфон|flex|гибк|труба|pipe/i },
      { query: 'прокладка выпускного коллектора', expect: /прокладк|gasket/i },
    ],
  },
  {
    name: 'Трансмиссия',
    probes: [
      { query: 'сцепление', expect: /сцеплен|clutch/i, forbid: /педал|pedal|трос|cable|цилиндр|cylinder|шланг|hose/i },
      { query: 'диск сцепления', expect: /диск|disc|disk/i },
      { query: 'корзина сцепления', expect: /корзин|нажимн|clutch cover|pressure plate|cover.*clutch/i },
      { query: 'выжимной подшипник', expect: /выжимн|подшипник|bearing/i },
      { query: 'главный цилиндр сцепления', expect: /цилиндр|cylinder/i },
      { query: 'маховик', expect: /маховик|flywheel|drive plate/i, forbid: /болт|bolt|венец|ring gear/i },
      { query: 'подушка коробки', expect: /опор|подушк|mount|insulator|support/i },
    ],
  },
  {
    name: 'Электрика',
    probes: [
      { query: 'генератор', expect: /генератор|alternator|generator/i, forbid: /подшипник|ремень|шкив|ротор|щетк|регулятор|bearing|belt|pulley|rotor|brush|regulator/i },
      { query: 'стартер', expect: /стартер|starter/i, forbid: /реле|relay|щетк|brush|бендикс|муфт|втулк|bush/i },
      { query: 'втягивающее реле', expect: /втягив|реле|solenoid|switch|магнит/i },
      { query: 'бендикс', expect: /бендикс|муфт|привод стартер|pinion|clutch|drive/i },
      { query: 'моторчик стеклоочистителя', expect: /мотор|электродвигател|motor/i },
      { query: 'моторчик печки', expect: /мотор|электродвигател|вентилятор|motor|blower|fan/i },
      { query: 'стеклоподъемник', expect: /стеклоподъ|window regulator|regulator/i },
      { query: 'замок зажигания', expect: /замок|выключател|ignition|switch|lock/i },
      { query: 'компрессор кондиционера', expect: /компрессор|compressor/i },
      { query: 'радиатор кондиционера', expect: /конденсатор|радиатор|condenser/i },
      { query: 'радиатор печки', expect: /радиатор|core|heater/i, forbid: /кондиц|condenser|охлажд(?!.*отоп)/i },
      { query: 'датчик парковки', expect: /датчик|парков|sensor|parking/i },
    ],
  },
  {
    name: 'Кузов',
    probes: [
      { query: 'бампер передний', expect: /бампер|bumper/i, forbid: /направляющ|кронштейн|решетк|решётк|усилит|абсорбер|bracket|reinforce|guide|grille|absorber|заглушк|cap/i },
      { query: 'бампер задний', expect: /бампер|bumper/i, forbid: /направляющ|кронштейн|решетк|решётк|усилит|абсорбер|bracket|reinforce|guide|grille|absorber|заглушк|cap/i },
      { query: 'бампер', expect: /бампер|bumper/i, forbid: /направляющ|кронштейн|решетк|решётк|усилит|абсорбер|bracket|reinforce|guide|grille|absorber|заглушк|cap/i },
      { query: 'капот', expect: /капот|hood|bonnet/i, forbid: /замок|трос|петл|упор|уплотн|lock|hinge|cable|stay|seal|шумоизол|insulat/i },
      { query: 'крыло переднее', expect: /крыло|fender|wing/i, forbid: /подкрыл|локер|liner|расширит|молдинг|moulding|кронштейн|bracket/i },
      { query: 'подкрылок', expect: /подкрыл|локер|liner|щиток|guard/i },
      { query: 'дверь передняя', expect: /двер|door/i, forbid: /ручк|замок|уплотн|петл|handle|lock|seal|hinge|обивк|trim|стекл|glass/i },
      { query: 'зеркало боковое', expect: /зеркал|mirror/i, forbid: /стекл|элемент|glass|крышк|cover|салон|inside/i },
      { query: 'стекло зеркала', expect: /стекл|элемент|glass/i },
      { query: 'лобовое стекло', expect: /стекл|windshield|windscreen|glass/i, forbid: /омыват|washer|зеркал|mirror|двер|door/i },
      { query: 'решетка радиатора', expect: /решетк|решётк|grille/i, forbid: /бампер(?!.*решетк)|эмблем|emblem/i },
      { query: 'ручка двери', expect: /ручк|handle/i },
      { query: 'замок двери', expect: /замок|lock|latch/i },
      { query: 'уплотнитель двери', expect: /уплотнит|weatherstrip|seal/i },
      { query: 'форсунка омывателя', expect: /форсунк|жиклер|жиклёр|nozzle|jet/i },
      { query: 'бачок омывателя', expect: /бач|reservoir|tank/i, forbid: /расширит|охлажд|coolant|крышк|cap/i },
      { query: 'насос омывателя', expect: /насос|мотор|pump|motor/i },
    ],
  },
  {
    name: 'Свет',
    probes: [
      { query: 'фара', expect: /фара|head ?lamp|headlight/i, forbid: /противотуман|fog|кронштейн|корректор|bracket|leveling|омыват|washer|реле|relay/i },
      { query: 'фара передняя', expect: /фара|head ?lamp|headlight/i, forbid: /противотуман|fog|кронштейн|корректор|bracket|leveling|омыват|washer|реле|relay/i },
      { query: 'противотуманка', expect: /противотуман|fog/i, forbid: /реле|relay|выключат|switch|рамк|bezel|cover/i },
      { query: 'птф', expect: /противотуман|fog/i, forbid: /реле|relay|выключат|switch|рамк|bezel|cover/i },
      { query: 'фонарь задний', expect: /фонар|lamp|light/i, forbid: /номер|licen|противотуман|fog|ламп(?!.*фонар)|bulb/i },
      { query: 'повторитель поворота', expect: /повторит|указател|поворот|turn|repeater|side/i },
      { query: 'подсветка номера', expect: /номер|licen/i },
      { query: 'лампа ближнего света', expect: LAMP },
      { query: 'лампа дальнего света', expect: LAMP },
      { query: 'ближний свет', expect: LAMP },
      { query: 'лампа h7', expect: LAMP },
      { query: 'лампа габарита', expect: LAMP },
      { query: 'лампа стоп сигнала', expect: LAMP },
      { query: 'лампа поворотника', expect: LAMP },
      { query: 'корректор фар', expect: /корректор|leveling|actuator|привод/i },
    ],
  },
]

/** Машины пилота — те же VIN, что в `catalog:cases`: квота каталога на них уже потрачена. */
const CARS: { vin: string; car: string }[] = [
  { vin: 'KMHJN81VP8U903944', car: 'Hyundai Tucson 2008' },
  { vin: 'Z94K241BAJR066059', car: 'Hyundai Creta' },
  { vin: 'XW8LD6NS2LH410128', car: 'Skoda Kodiaq' },
  { vin: 'WVWZZZ1JZ3W386752', car: 'VW Golf IV' },
  { vin: 'LFV3B2FY2N3102396', car: 'VW Jetta (Китай)' },
  { vin: 'Z6FDXXEECDFD88329', car: 'Ford Mondeo' },
  { vin: 'Z8TND5FEAGM016476', car: 'Citroen C4' },
  { vin: 'WDD1770871V030773', car: 'Mercedes A200' },
  { vin: 'JF1SK7LL5MG129305', car: 'Subaru Forester' },
  { vin: 'LFMGJE720DS070251', car: 'Toyota Prado (КНР)' },
  { vin: 'LVVDB21B9RC095635', car: 'Chery Tiggo 4 Pro' },
  { vin: 'SAJAA04M6FPU46282', car: 'Jaguar XF' },
  { vin: 'UTHB11B1502018885', car: 'Lexus' },
]

type Verdict = 'ok' | 'not-first' | 'wrong' | 'empty' | 'error'

type Row = {
  vin: string
  car: string
  section: string
  query: string
  optional: boolean
  verdict: Verdict
  first: string | null
  category: string | null
  found: number
  ms: number
  error: string | null
}

async function main() {
  const { out, onlyCar, onlySection } = parseArgs(Bun.argv.slice(2))
  const env = loadEnv(Bun.env)
  const providers = createCatalogProviders(env)
  if (providers.meta.catalog.demo) {
    console.error('Боевых каталогов нет — мерить нечего: мок отвечает выдуманными деталями.')
    process.exit(1)
  }
  const service = new CatalogService(providers.catalog, providers.suppliers, providers.plates, providers.meta)

  const cars = CARS.filter((item) => !onlyCar || item.car.toLowerCase().includes(onlyCar.toLowerCase()))
  const sections = SECTIONS.filter((item) => !onlySection || item.name.toLowerCase() === onlySection.toLowerCase())
  const total = sections.reduce((sum, section) => sum + section.probes.length, 0)
  log(`Машин: ${cars.length} | запросов: ${total} | каталоги: ${providers.meta.catalog.names.join('+')}`)

  if (!existsSync(out)) mkdirSync(out, { recursive: true })
  const rows: Row[] = []
  // Машины параллельно, запросы одной машины — по очереди: так каталог видит
  // не больше одного поиска на машину, а прогон идёт в ширину.
  await Promise.all(
    cars.map(async ({ vin, car }) => {
      let done = 0
      for (const section of sections) {
        for (const probe of section.probes) {
          rows.push(await run(service, vin, car, section.name, probe))
          done += 1
          if (done % 25 === 0) log(`  ${car}: ${done}/${total}`)
        }
      }
      log(`  ${car}: готово`)
      writeFileSync(join(out, 'benchmark.json'), JSON.stringify(rows, null, 2), 'utf8')
    }),
  )

  writeFileSync(join(out, 'benchmark.json'), JSON.stringify(rows, null, 2), 'utf8')
  const report = render(rows, cars, sections)
  writeFileSync(join(out, 'benchmark.md'), report, 'utf8')
  log(`\n${report.split('\n## По запросам')[0]}`)
  log(`Отчёт: ${join(out, 'benchmark.md')}`)
}

async function run(service: CatalogService, vin: string, car: string, section: string, probe: Probe): Promise<Row> {
  const started = Date.now()
  const base = { vin, car, section, query: probe.query, optional: probe.optional ?? false }
  try {
    const { parts } = await service.searchParts(vin, probe.query)
    const first = parts[0] ?? null
    const fits = (name: string) => probe.expect.test(name) && !(probe.forbid?.test(name) ?? false)
    const verdict: Verdict = !first
      ? 'empty'
      : fits(first.name)
        ? 'ok'
        : parts.slice(0, 5).some((part) => fits(part.name))
          ? 'not-first'
          : 'wrong'
    return {
      ...base, verdict, first: first?.name ?? null, category: first?.category ?? null,
      found: parts.length, ms: Date.now() - started, error: null,
    }
  } catch (error) {
    return {
      ...base, verdict: 'error', first: null, category: null, found: 0, ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Машина «без источника»: ни на один запрос каталог не ответил ничем, кроме пустоты и сбоя. */
function deadCars(rows: Row[]): Set<string> {
  const byCar = new Map<string, Row[]>()
  for (const row of rows) byCar.set(row.car, [...(byCar.get(row.car) ?? []), row])
  return new Set([...byCar].filter(([, list]) => list.every((row) => row.verdict === 'empty' || row.verdict === 'error')).map(([car]) => car))
}

function share(list: Row[], verdict: Verdict): string {
  if (list.length === 0) return '—'
  const count = list.filter((row) => row.verdict === verdict).length
  return `${Math.round((count / list.length) * 100)}%`
}

function render(rows: Row[], cars: { car: string }[], sections: Section[]): string {
  const dead = deadCars(rows)
  const live = rows.filter((row) => !dead.has(row.car))
  const main = live.filter((row) => !row.optional)
  const lines: string[] = []
  lines.push(`# Замер поиска: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, '')
  lines.push(`Главная цифра — правильная деталь первой строкой, по машинам с рабочим источником, без деталей «не у всех машин».`, '')
  lines.push(`| | верно первой | верная ниже первой | чужая деталь | пусто | сбой | всего |`)
  lines.push(`|---|---|---|---|---|---|---|`)
  lines.push(`| **Итого** | **${share(main, 'ok')}** | ${share(main, 'not-first')} | ${share(main, 'wrong')} | ${share(main, 'empty')} | ${share(main, 'error')} | ${main.length} |`)
  for (const section of sections) {
    const list = main.filter((row) => row.section === section.name)
    lines.push(`| ${section.name} | ${share(list, 'ok')} | ${share(list, 'not-first')} | ${share(list, 'wrong')} | ${share(list, 'empty')} | ${share(list, 'error')} | ${list.length} |`)
  }
  lines.push('', '## По машинам', '')
  lines.push(`| машина | верно первой | верная ниже | чужая | пусто | сбой | среднее время, с |`)
  lines.push(`|---|---|---|---|---|---|---|`)
  for (const { car } of cars) {
    const list = rows.filter((row) => row.car === car && !row.optional)
    const avg = list.length ? (list.reduce((sum, row) => sum + row.ms, 0) / list.length / 1000).toFixed(1) : '—'
    const mark = dead.has(car) ? ' (нет рабочего источника)' : ''
    lines.push(`| ${car}${mark} | ${share(list, 'ok')} | ${share(list, 'not-first')} | ${share(list, 'wrong')} | ${share(list, 'empty')} | ${share(list, 'error')} | ${avg} |`)
  }
  if (dead.size > 0) {
    const sample = rows.find((row) => dead.has(row.car) && row.error)?.error
    lines.push('', `Без рабочего источника: ${[...dead].join(', ')}${sample ? ` — например: ${sample}` : ''}.`)
  }
  lines.push('', '## По запросам', '', 'Сколько машин (с рабочим источником) ответили верно первой строкой; ниже — что пришло вместо.', '')
  for (const section of sections) {
    lines.push(`### ${section.name}`, '')
    for (const probe of section.probes) {
      const list = live.filter((row) => row.query === probe.query && row.section === section.name)
      const ok = list.filter((row) => row.verdict === 'ok').length
      lines.push(`- **${probe.query}**${probe.optional ? ' _(не у всех машин)_' : ''} — ${ok}/${list.length}`)
      for (const row of list.filter((item) => item.verdict !== 'ok')) {
        const what = row.verdict === 'empty' ? 'пусто'
          : row.verdict === 'error' ? `сбой: ${row.error}`
          : `${row.verdict === 'not-first' ? 'верная ниже, первой' : 'чужая'}: «${row.first}» (узел «${row.category ?? '—'}»)`
        lines.push(`  - ${row.car}: ${what}`)
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

function parseArgs(argv: string[]) {
  let out = '../.scratch/benchmark'
  let onlyCar: string | null = null
  let onlySection: string | null = null
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    const value = argv[index + 1]
    if (arg === '--out' && value) { out = value; index += 1; continue }
    if (arg === '--only-car' && value) { onlyCar = value; index += 1; continue }
    if (arg === '--only-section' && value) { onlySection = value; index += 1; continue }
    throw new Error(`Непонятный аргумент: ${arg}`)
  }
  return { out, onlyCar, onlySection }
}

if (import.meta.main) await main()
