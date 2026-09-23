# Что по каталогам запчастей лежит в свободном доступе — обзор 23.09.2026

Зачем: понять, сколько информации «VIN → OEM-номер → схема узла» можно получить бесплатно,
и сравнивать с этим предложения платных поставщиков (parts-catalogs/Tradesoft, ACAT, Laximo,
17vin, GOODVIN — см. [SOURCES.md](SOURCES.md)). Ничего не скачивалось, регистраций не было:
страницы только открывались и читались.

Второй проход (тот же день): сайты, закрывшиеся от агентов, открыты настоящим Chrome, а на
Armtek и Autopiter введён публичный пример VIN с сайта parts-catalogs (`XW8AN2NE3JH035743`, Skoda
Octavia калужской сборки), а не машина клиента.

**Как читать:** ✓ — страницу открыли и увидели описанное; ✓ VIN — ещё и ввели VIN; ✗ — сайт закрылся от автоматического
просмотра (защита от ботов, капча, ошибка), описание взято из поиска и отзывов. «Статус» —
как его видно с сайта: *официальный* (сам производитель), *дилер* (магазин, торгующий
оригиналом), *не раскрыт* (откуда данные — не сказано), *серый* (признаки нелицензионного
доступа).

## Коротко

- **Найдено 75 ресурсов**, 61 открыт лично, 14 закрыты защитой от ботов или не отвечают. Плюс 6 видов пиратских раздач — описаны без ссылок.
- **Бесплатного API нет ни у кого**, кроме NHTSA vPIC. А vPIC только расшифровывает VIN
  американских машин, деталей и схем не даёт. Всё бесплатное — это просмотр глазами на сайте.
- **Бесплатный подбор по VIN в РФ — это витрины магазинов** (Armtek — проверено вводом VIN,
  без входа; Exist, Avtoall, Emex; Autopiter — только после входа в аккаунт). Они зарабатывают
  на продаже детали, а под капотом у них и у сотен мелких магазинов стоят те же платные
  движки — ACAT, Laximo (у Armtek он виден прямо в адресе), семейство elcats/japancats. То есть «бесплатно» для
  покупателя, но магазин за каталог платит.
- **Мировые бесплатные каталоги со схемами** (PartSouq, 7zap, RealOEM, Megazip, Amayama) —
  самая близкая замена платным, но ни один не показывает лицензию. Прецедент давления есть:
  bmwcats.com закрыт по требованию правообладателя.
- **Легально и бесплатно** — только магазины американских дилеров (бесплатный VIN-декодер и
  каталог, но под машины рынка США; это сайты дилеров, а не самих заводов), PDF-каталоги УАЗ и LADA без поиска по VIN и магазин КАМАЗ. Порталы
  производителей для независимых СТО (JLR, Stellantis, Volvo, VW, BMW, Mercedes, Toyota) —
  везде платная подписка; из РФ часть недоступна вовсе (Volvo).
- **Что платный поставщик даёт сверх бесплатного:** программный доступ (API) для бота и сайта,
  одинаковый поиск по всем маркам, русские названия, свежесть данных и понятный договор.
  Сравнивая предложения, стоит смотреть именно на эти пять пунктов.

## 1. Магазины РФ с бесплатным подбором по VIN

| Ресурс | Что бесплатно | VIN | Схемы | Статус | |
|---|---|---|---|---|---|
| [exist.ru — оригинальные каталоги](https://www.exist.ru/Catalog/Links/Original) | ~55 марок: ссылки на elcats/japancats/eurospares + «Запрос по VIN» | да | не проверено | не раскрыт | ✓ |
| [autopiter.ru/original](https://autopiter.ru/original) | «Оригинальные каталоги по VIN», 100+ производителей; **после ввода VIN просит войти в аккаунт** | только с аккаунтом | не проверено | не раскрыт | ✓ VIN |
| [avtoall.ru — запросы по VIN](https://www.avtoall.ru/vin-requests/) | подбор по VIN | да | не проверено | не раскрыт | ✓ |
| [part-kom.ru — каталоги](https://www.part-kom.ru/catalogues.php) | ВАЗ, ГАЗ, УАЗ, ЗАЗ, ЗИЛ, ИЖ, ЛуАЗ, АЗЛК на движке ACAT | нет, по модели | списки номеров | не раскрыт | ✓ |
| [koreanaparts.ru — Kia](https://koreanaparts.ru/catalog-kia) | текстовый каталог и схемы блоков Kia (упоминают Microcat) | не видно | да | не раскрыт | ✓ |
| [cats.parts](https://cats.parts/) (бывший bmwcats.com) | 730 000+ позиций BMW/Mini | не видно | не проверено | прежний домен закрыт по требованию правообладателя | ✓ |
| [baza.drom.ru — запчасти](https://baza.drom.ru/sell_spare_parts/) | объявления + отдельная проверка авто по VIN | частично | нет | доска объявлений, не каталог | ✓ |
| [emex.ru — каталоги](https://emex.ru/products/catalogs) | каталоги по маркам | по отзывам да | — | — | ✗ |
| [autodoc.ru](https://www.autodoc.ru/) | прежний раздел «Оригинальные каталоги» удалён — страница отдаёт «Страница не найдена» | — | — | — | ✓ |
| [zzap.ru — каталоги](https://www.zzap.ru/public/catalogs/catalogs.aspx) | каталоги Laximo, поиск по VIN и по фото | по отзывам да | — | — | ✗ |
| [armtek.ru — идентификация по VIN](https://armtek.ru/catalog/identification-auto) | **без входа:** VIN → марка и модель («SKODA/Octavia»), дерево узлов, поиск по названию детали; внутри каталог Laximo (адрес `/catalog/laximo/…`) | да | до схемы дойти не удалось | встроенный Laximo | ✓ VIN |
| [китайавто.рус](https://xn--80aagvgd7a1ae.xn--p1acf/) | магазин запчастей для китайских машин, поиск по артикулу и VIN | поле есть | — | не раскрыт | ✓ |
| [kia.epcdata.ru](https://kia.epcdata.ru/) | японские и корейские марки по VIN/Frame | по отзывам да | — | — | ✗ |
| [autoopt.ru — ВАЗ](https://www.autoopt.ru/auto/catalog/car/vaz) | каталог ВАЗ | — | — | — | ✗ |

## 2. Бесплатные каталоги-справочники со схемами

| Ресурс | Что бесплатно | VIN | Схемы | Статус | |
|---|---|---|---|---|---|
| [elcats.ru](https://www.elcats.ru/) | ~50 марок: европейские, американские, китайские; цены Exist | по отзывам частично | не проверено | не раскрыт | ✓ |
| [japancats.ru](https://www.japancats.ru/) | Toyota, Lexus, Honda, Nissan, Mazda, Subaru, Mitsubishi, Suzuki, Infiniti и др. — тот же оператор, что elcats | по отзывам частично | не проверено | не раскрыт | ✓ |
| [megazip.net](https://www.megazip.net/) | VIN/Frame → «точные заводские схемы» | да | да | магазин, лицензия не раскрыта | ✓ |
| [bimmercat.com](https://bimmercat.com/bmw/language/en) | BMW: VIN-декодер, каталог, схемы проводки | да | да | сам пишет «не связан с BMW AG» | ✓ |
| [bmwfans.info](https://bmwfans.info/parts-catalog) | BMW: VIN-декодер, каталог моделей | да | да | серый: «не связан с BMW AG», данные «из открытых источников» | ✓ |
| [volkswagen.catalogs-parts.com](https://volkswagen.catalogs-parts.com/) | вход в каталог VW (96 серий, 765 поколений), дальше 7zap | частично | на 7zap | не раскрыт | ✓ |
| [7zap.com](https://7zap.com/ru/) | 70 марок, VIN-декодер, схемы, номера, ИИ-советы; **«Бесплатная версия ограничена»** — есть платные тарифы | да | да | не раскрыт | ✓ |
| [partsouq.com](https://partsouq.com/en/catalog/genuine/vehicle) | один из самых полных в мире: VIN/Frame, схемы, номера | по отзывам да | по отзывам да | не раскрыт | ✗ |
| [amayama.com](https://www.amayama.com/en/genuine-catalogs) | каталоги Toyota (Япония, США, Азия, Европа), Daihatsu, Audi, BMW, Hyundai и др.; поиск по номеру | не видно | по отзывам да | не раскрыт | ✓ |
| [realoem.com](https://www.realoem.com/bmw/) | BMW: номера и примерные цены, схемы по узлам, модель и дата выпуска по VIN; живёт на пожертвования | да | да | серый | ✓ |
| [ilcats.ru](https://www.ilcats.ru/) | третий сайт семейства elcats | — | — | — | ✗ |
| [etkbmw.cc](https://etkbmw.cc/en) | клон BMW ETK, поиск по VIN и номеру; **данные версии 03.2019** | да | да | «не связан с BMW AG» | ✓ |
| [new.lrcat.com](https://new.lrcat.com/) | Land Rover | — | — | — | ✗ |

## 3. Магазины американских дилеров (бесплатный VIN-декодер)

Все — одна модель: бесплатный VIN-декодер и каталог по узлам, платна только покупка. Данные
под машины рынка США; такие магазины есть почти под каждую марку, здесь — примеры. Это сайты
дилеров, а не заводов: nissanpartsdeal.com и gmpartsgiant.com прямо пишут, что они не
официальные магазины производителя. Официальные — только autoparts.toyota.com и parts.vw.com.

| Ресурс | Марки | |
|---|---|---|
| [fordpartsgiant.com](https://www.fordpartsgiant.com/) | Ford, Lincoln | ✓ |
| [hondapartsnow.com](https://www.hondapartsnow.com/) | Honda | ✓ |
| [subarupartsdeal.com — VIN-декодер](https://www.subarupartsdeal.com/vin-decoder.html) | Subaru | ✓ |
| [nissanpartsdeal.com — VIN-декодер](https://www.nissanpartsdeal.com/vin-decoder.html) | Nissan | ✓ |
| [hyundaipartsdeal.com — VIN-декодер](https://www.hyundaipartsdeal.com/vin-decoder.html) | Hyundai | ✓ |
| [bmwpartsdeal.com — VIN-декодер](https://www.bmwpartsdeal.com/vin-decoder.html) | BMW | ✓ |
| [kiapartsnow.com — VIN-декодер](https://www.kiapartsnow.com/vin-decoder.html) | Kia | ✓ |
| [gmpartsgiant.com](https://www.gmpartsgiant.com/) | GM | ✓ |
| [gmpartsdirect.com — VIN-декодер](https://www.gmpartsdirect.com/vin-decoder.html) | Chevrolet, GMC, Buick, Cadillac | ✗ |
| [autoparts.toyota.com](https://autoparts.toyota.com/) | Toyota (официальный магазин Toyota Motor Sales) | ✗ |
| [parts.vw.com](https://parts.vw.com/) | Volkswagen (официальный магазин VW of America) | ✗ |
| [mopar.com — VIN lookup](https://www.mopar.com/en-us/my-vehicle/vin-lookup.html) | Chrysler, Dodge, Jeep, Ram | ✗ |

## 4. Заводы РФ

| Ресурс | Что бесплатно | VIN | |
|---|---|---|---|
| [uaz.ru — каталог запчастей и аксессуаров (PDF)](https://www.uaz.ru/uploads/docs/parts-and-accessories/supplies-catalog.pdf) | заводской PDF, ~7,5 МБ | нет | ✓ |
| [uazcomplect.ru — каталоги](https://uazcomplect.ru/buyers/directory/) | PDF-каталоги УАЗ по моделям и двигателям ЗМЗ/IVECO/Andoria (155 КБ – 31,7 МБ); сайт поставщика, не завода | нет | ✓ |
| [lada-image.ru — каталог](https://www.lada-image.ru/products/catalog/) | онлайн-каталог LADA по узлам (Granta, Vesta, Niva, XRAY) от официального поставщика | нет | ✓ |
| [static.lada.ru — каталог (PDF)](https://static.lada.ru/files/catalog_of_original_spare_parts.pdf) | заводской PDF на домене АвтоВАЗ | нет | ✗ |
| [shop.kamaz.ru](https://shop.kamaz.ru/) | официальный магазин КАМАЗ, каталог по узлам | нет | ✓ |
| [gazgroup.ru](https://gazgroup.ru/) | открытого заводского каталога не найдено — только у дилеров | — | ✗ |

## 5. Порталы производителей для независимых СТО (платно)

| Ресурс | Что бесплатно | Что платно | |
|---|---|---|---|
| [JLR TOPIx](https://topix.landrover.jlrext.com/) | только руководство владельца | ремонт, схемы, бюллетени; прайс 2025 от £10/час; проверка бизнеса 2–5 дней | ✓ |
| [Stellantis Independent Operator Portal](https://www.stellantisiop.com/) | — | TechAuthority, от часа | ✓ |
| [Peugeot/Citroën Service Box](https://public.servicebox.peugeot.com/) | — | каталог и электросхемы после регистрации | ✓ |
| [Volvo TIS / VIDA](https://tis.volvocars.biz/independent.html) | — | всё по подписке; **России нет в списке рынков** | ✓ |
| [VW erWin](https://volkswagen.erwin-store.com/erwin/showHome.do) | регистрация | материалы; идентификация по VIN | ✓ |
| [BMW AOS](https://aos.bmwgroup.com/) | — | отдельная подписка на BMW, MINI, Rolls-Royce | ✓ |
| [Mercedes-Benz B2B Connect](https://b2bconnect.mercedes-benz.com/gb) | — | XENTRY, WIS, EPC | ✓ |
| [Toyota TIS](https://techinfo.toyota.com) | данные для спасателей и утилизаторов, отзывные кампании по VIN | подписка | ✓ |

## 6. Открытые данные

| Ресурс | Что даёт | |
|---|---|---|
| [NHTSA vPIC API](https://vpic.nhtsa.dot.gov/api/) | расшифровка VIN без ключа и регистрации (марка, модель, завод, комплектация); не детали | ✓ |
| [NHTSA vPIC — выгрузка](https://datahub.transportation.gov/Automobiles/NHTSA-Product-Information-Catalog-and-Vehicle-List/j7xy-dt4s) | та же база целиком, официальный портал Минтранса США | ✓ |

## 7. Платные — для сравнения цен

| Ресурс | Что | Цена | |
|---|---|---|---|
| [ACAT.online](https://acat.online/) | движок каталогов для магазинов | готовое решение от 4 990 ₽/мес, API от 19 990 ₽/мес | ✓ |
| [catcar.info](http://www.catcar.info/) | движок каталогов для встраивания в магазины | по заявке | ✓ |
| [autodealer.ru](https://autodealer.ru/catalog) | 400+ марок, включая ВАЗ/ГАЗ/УАЗ; демо бесплатно | от 1 390 ₽/мес | ✓ |
| [poisk.vin](https://poisk.vin/) | 125+ марок, 300+ дилерских каталогов | от 40 ₽/мин, EPC от 5 200 ₽/мес | ✓ |
| [autopoisk.ru](https://autopoisk.ru/) | 240 производителей, только юрлица | от 6 500 ₽/мес | ✓ |

## 8. Форумы и клубы

Номера, аналоги и опыт подбора от мастеров и владельцев. Поиска по VIN и единых схем нет,
всё — ручной обмен. Марочных клубов в рунете сотни; здесь — крупные и показательные.

| Ресурс | Что там | |
|---|---|---|
| [DRIVE2 — «Автозапчасти (артикулы и каталоги)»](https://www.drive2.ru/communities/3937/) | артикулы, аналоги, сравнение магазинов | ✓ |
| [DRIVE2 — «Авто-запчасти (описание с фото)»](https://www.drive2.ru/communities/3480/) | фото + номер + размеры по конкретным деталям | ✓ |
| [forum.autodata.ru](https://forum.autodata.ru/) | диагносты и СТО, раздел «Запчасти и каталоги» | ✓ |
| [forum.drom.ru](https://forum.drom.ru/) | японские марки, неисправности | ✓ |
| [carmasters.org](https://carmasters.org/) | автоэлектрика, разделы каталогов по маркам | ✓ |
| [mytyper.ru — «Запчасти»](https://www.mytyper.ru/talk/) | Honda; инструкция, как найти OEM-номер по VIN | ✓ |
| [forum.zr.ru — «Ремонт и сервис»](https://forum.zr.ru/forum/forum/4-%D0%B0%D0%B2%D1%82%D0%BE-%D0%BC%D0%BE%D1%82%D0%BE-%D0%B8-%D1%82%D0%B5%D1%85%D0%BD%D0%B8%D0%BA%D0%B0/) | 26 894 темы по узлам и запчастям | ✓ |
| [rennlist.com — 987 Forum](https://rennlist.com/forums/987-forum/) | Porsche, поиск номеров через PET | ✓ |
| [reddit r/MechanicAdvice](https://www.reddit.com/r/MechanicAdvice/) | 2,1 млн участников | ✗ |
| [vwvortex.com — ветка номеров VW](https://www.vwvortex.com/threads/the-vw-part-number-thread.1068577) | сводная ветка оригинальных номеров Golf II/Jetta II, 2003–2012 | ✓ |
| [toyotanation.com](https://www.toyotanation.com/) | Toyota, живые ветки по ремонту | ✓ |
| [lada-forum.ru](http://lada-forum.ru/) | ВАЗ/LADA по моделям и регионам | ✓ |

## 9. Серые сервисы, которые торгуют открыто

| Ресурс | Что продают | Почему серый | |
|---|---|---|---|
| [tecdoc.ru](https://tecdoc.ru/) | база TecDoc (дамп MySQL + API) | TecAlliance ушла из РФ в 2022–2023, лицензии нет, продают как «параллельный импорт» | ✓ |
| [vinsearch.online](https://vinsearch.online/) | доступ к 45 дилерским EPC (ETKA, Xentry, Microcat, Toyota EPC…), $5/день, $50/мес | не объясняют, откуда доступ к чужим дилерским порталам | ✓ |
| [partsapi.ru](https://partsapi.ru/) | API «TECDOC 2025Q4» | лицензия TecAlliance не упомянута | ✓ |

## 10. Пиратские раздачи — без ссылок

Ссылок нет намеренно; пиратские сайты не открывались.

- **Дилерские каталоги целиком** — ETKA (VAG), BMW ETK, Toyota EPC, Nissan FAST, Renault
  DIALOGYS, Ford ETIS, Hyundai/Kia: образы дисков на торрентах и закрытых форумах.
- **Mercedes WIS/EPC/Xentry** — готовые виртуальные машины на десятки гигабайт с каталогом,
  схемами и процедурами; обычно со взломанной активацией.
- **Старые TecDoc на DVD** — данные заморожены на последнем легальном выпуске (2021–2022).
- **Microcat** (Ford, Mazda, Land Rover, Jaguar и др.) — копии программы и баз.
- **«Аренда» чужих дилерских аккаунтов** в Telegram — посуточно или за VIN.
- **Веб-обёртки над слитыми базами**, выдающие себя за «свой каталог».

Риски для того, кто этим пользуется: данные устаревают (обновлений нет), в «кряках» часто
вредоносные программы, чужой аккаунт блокируют в любой момент, а копирование баз данных
запрещено даже для личных целей (ст. 1273 п. 2 ГК РФ).
