# Coupon Hunter v3.3.0

Локальное расширение Manifest V3 для Chrome desktop и Яндекс Браузера на Chromium. Оно анализирует страницы AliExpress, хранит данные в `chrome.storage.local` и проверяет только явно найденные или введённые промокоды. Случайные коды не генерируются, brute force не выполняется.

## Что добавлено в v3.3.0

- На корзине/checkout появился основной floating widget Promo Intelligence со состояниями `IDLE`, `READY`, `TESTING`, `FOUND_BEST`, `COMPLETE_NO_SAVING`, `STOPPED`, `SAFETY_STOP`, `ERROR`.
- Виджет загружает подписанную базу и строит ranked applicable queue, но запускает `CH_TEST_PROMOS` только после явного нажатия «Подобрать лучший промокод».
- Standard проверяет до 30, Deep — до 50 top-ranked кандидатов. Прогресс, последние результаты и текущий BEST восстанавливаются из `promoTestSession`.
- Проверенный BEST после тестовой попытки не остаётся применённым; окончательное применение возможно только отдельной кнопкой «Применить лучший».
- Popup сохранён как расширенный диагностический интерфейс, но для обычного checkout-сценария больше не обязателен.

## Основа v3.2.2

- `sourceClaims` compacted по `promo code + sourceGroup + sourceId`: сохраняются последнее наблюдение, first/last timestamps, observation count и максимум 8 material changes; до 32 claims на код.
- Trust и corroboration считаются по независимым `sourceGroup`, повторные polls одного источника не повышают уверенность.
- Persistent library содержит только USER/PRODUCT_PAGE/SESSION/local data и verification overlays. Remote Promo Feed хранится отдельным snapshot и не дублируется в `couponCandidates`.
- Remote Promo Feed schema v3 использует `feedId`, `revision`, `FULL_SNAPSHOT`/`INCREMENTAL`, retraction lifecycle и Ed25519 canonical-signature module.
- Full snapshot удаляет отсутствующую remote provenance; совпадающий USER code сохраняется. Incremental `SUSPENDED` деактивирует claim, повторное появление реактивирует его.
- Field-level confidence не позволяет сомнительному конфликтующему minimum/currency/validity автоматически исключить код.
- Storage diagnostics показывает total/library/feed/history bytes; soft budget сначала сокращает remote diagnostics/history и никогда не удаляет USER code.
- Server-side Collector получил CouponAPI incremental adapter, Feedico catalog adapter и отдельный AliGate seller-coupon adapter. SimplyCodes и официальный buyer-promo AliExpress source остаются честно disabled до подтверждённого доступа/API.
- Feedico adapter сохраняет title/brand/firm/dates/merchant/provider metadata, консервативно извлекает только однозначные условия и имеет hard cap 5 × 100 строк за запуск.
- Невозможные fixed-discount/minimum-spend пары Feedico помечаются `AMBIGUOUS`; их числа не попадают в theoretical saving и ranking.
- Регион Feedico берётся из structured country/location; контекстные country markers в title используются только как fallback.
- Однозначные `New User`/`New Users Only`/`new customer` restrictions сохраняются как `newUsersOnly=true`; неоднозначность остаётся unknown.
- Audience restriction хранится как tri-state `true/false/null`; new-user-only код жёстко отсеивается только при достоверно известном non-new account.
- Production feed по умолчанию загружается с GitHub Pages и принимается только после fail-closed Ed25519 verification встроенным public JWK.
- Production workflow каждые 6 часов строит feed с validity 18 часов, проводит quality gate и публикует только verified Pages artifact.
- Production signing key загружается только из base64 PKCS8 secret и проходит Ed25519/public-JWK preflight до первого provider request.
- Extension получает production feed напрямую с HTTPS custom domain `qsen.ru`, без зависимости от cross-origin redirect GitHub Pages.
- Ручной GitHub Action `.github/workflows/feedico-smoke.yml` выполняет tests и Stage A Feedico smoke без публикации feed, cron, Pages или signing key.
- Applicability Engine локально фильтрует только доказанные несовместимости по сроку, валюте, региону, товарам, продавцам и известному basis минимальной суммы.
- Deterministic Queue Builder ранжирует ожидаемую выгоду, theoretical maximum, применимость, доверие, свежесть, независимые source groups и локальную историю.
- Стандартная проверка ограничена 30 live attempts, явно выбранная глубокая — 50; verifier дополнительно имеет hard cap 50.
- `BEST_VERIFIED` отделён от `BEST_KNOWN_PROVEN`: popup не обещает «самый выгодный», пока остаётся непроверенный потенциально лучший кандидат.
- Collector вынесен из расширения в `collector/`; отказ одного source adapter не отменяет сбор остальных.

## Стабильное verifier-ядро

- Цена стала SKU-aware и нормализуется как `{ value, currency, isRange, min, max, source, confidence }`.
- Поддерживаются RUB, USD, EUR, десятичные форматы и диапазоны.
- Видимый DOM, aria/семантика, JSON-LD, JSON hydration/state и открытые popup/dialog используются как независимые источники. Кандидаты сохраняются в диагностике.
- Акции разделены на `PLATFORM_PROMO_CODE`, `ALIEXPRESS_COUPON`, `SELLER_COUPON`, `STORE_DISCOUNT`, `SELECT_COUPON`, `COINS`, `EVENT_DISCOUNT`, `INSTANT_DISCOUNT`, `NEW_USER_DISCOUNT`, `UNKNOWN`.
- Реализован изолированный verifier с состояниями `IDLE → ENTERING → APPLYING → WAITING_RESPONSE → APPLIED/REJECTED/UNKNOWN`.
- Для каждого кода измеряются subtotal, shipping, tax, discount и total до/после. Рабочим код считается только при сигнале применения AliExpress и фактическом уменьшении total.
- Применённый при тесте код удаляется, после чего verifier ждёт возврата к baseline. Без восстановленного baseline очередь останавливается.
- Checkout защищён structural fingerprint только из currency, item/SKU/quantity, стабильных sellerId/shippingMethodId. Финансовые компоненты хранятся отдельно и строго сверяются при восстановлении baseline.
- Applied не завершает проверку преждевременно: verifier продолжает ждать реального изменения и стабилизации total.
- Все программные клики проходят через общий safety helper; покупка, checkout и платёжные действия блокируются.
- Лучший код не остаётся применённым. Его можно повторно применить только отдельной кнопкой «Применить лучший проверенный код».
- CAPTCHA, rate limit и security verification немедленно останавливают очередь. Hard maximum — 50 известных кодов за запуск.
- Добавлены безопасный экспорт диагностики и каталог `tests/fixtures/` для regression fixtures.

## Архитектура

- `src/parser-core.js` — чистое ядро цены, SKU, структурированных данных и нормализованных Promotion.
- `src/page-adapter.js` — SPA/mutation debounce и фильтр значимых изменений.
- `src/content.js` — адаптер товарной страницы, история SKU, панель и диагностика.
- `src/checkout-core.js` — чистая классификация checkout, статусов и математической экономии.
- `src/verifier-engine.js` — тестируемая state machine очереди, fingerprint guard и привязка BEST к checkout.
- `src/safety.js` — единая политика безопасного программного клика.
- `src/promo-tester.js` — безопасная state machine, DOM-адаптер checkout и изоляция попыток.
- `src/checkout-widget-core.js` — тестируемая модель checkout-native UI и только явные команды verifier.
- `src/checkout-widget.js` — floating widget, прогресс, режимы, BEST и восстановление `promoTestSession`.
- `src/background.js` — безопасное обновление подписанного data-only production feed для checkout widget.
- `src/storage.js` — compacted `CouponCandidateRegistry`, раздельные local/remote/verification state, storage diagnostics и soft budget.
- `src/promo-constants.js` — централизованные лимиты library/feed/live queue.
- `src/promo-feed.js` — schema v3 lifecycle/reconciliation, безопасная загрузка и cache policy недоверенного JSON feed.
- `src/feed-signature.js` — canonical serialization и fail-closed Ed25519 verification production feed.
- `src/promo-intelligence.js` — applicability, confidence breakdown, ranking, queue и доказанность BEST.
- `src/search-content.js` — разбор поисковой выдачи через общее ядро цены.
- `src/popup-promos.js` — список кандидатов, результаты, BEST и диагностический экспорт.
- `src/popup.js` — товар, поиск, watchlist и история.
- `data/known-codes.json` — локальный data-only список. В репозитории он пуст, чтобы не выдавать устаревшие коды за актуальные.
- `collector/` — отдельный Node.js collector, реальные credential-gated adapters, provider cursor/health, bounded retry, atomic feed builder и Ed25519 signing.

Production feed URL зашит в extension: `https://qsen.ru/coupon-hunter-source/promo-feed.json`. Разрешён только origin `https://qsen.ru/*`; ручная настройка `promoFeedConfig` не требуется. Feed содержит только данные, не JavaScript, selectors или executable rules. Unsigned/tampered production payload отклоняется.

## Установка

1. Откройте `chrome://extensions` или `browser://extensions` в Яндекс Браузере.
2. Включите режим разработчика.
3. Нажмите «Загрузить распакованное расширение».
4. Выберите именно папку `coupon-hunter-mvp-v0.2.1`.
5. После обновления расширения перезагрузите уже открытые вкладки AliExpress.

## Товар и SKU

1. Откройте товар AliExpress.
2. Выберите нужные цвет, размер и комплектацию.
3. Убедитесь, что в панели показаны ожидаемые SKU/вариант и цена.
4. Смените вариант: цена и SKU должны обновиться без полной перезагрузки.
5. Если найден только диапазон при уже выбранном SKU, расширение не выдаёт его минимум за точную цену.
6. «Открыть скидки» можно нажать вручную, чтобы AliExpress дорисовал dialog/popover; после этого данные перечитываются.

## Проверка промокодов

1. Добавьте свои коды в popup при необходимости. Найденные на ранее открытых страницах коды уже находятся в локальном registry.
2. Откройте корзину или checkout и проверьте состав заказа, SKU, количество, адрес, доставку и способ оплаты самостоятельно.
3. В floating widget выберите Standard (до 30 attempts) или Deep (до 50) и нажмите «Подобрать лучший промокод». Запуск никогда не происходит автоматически.
4. Verifier фиксирует baseline, применяет один код, ждёт перерасчёта, классифицирует ответ и измеряет `baselineTotal - resultingTotal`.
5. Если код был применён, verifier удаляет его и подтверждает возврат к baseline до следующей попытки.
6. `BEST` означает проверенный результат с положительной фактической экономией и восстановленным baseline. «Самый выгодный» показывается только при доказанном полном покрытии eligible-кандидатов; иначе UI пишет «Лучший из проверенных».
7. Чтобы применить BEST, нажмите отдельную кнопку. После этого ещё раз вручную проверьте итоговую сумму.

Verifier различает `VALID_APPLIED`, `INVALID`, `EXPIRED`, `NOT_STARTED`, `MINIMUM_SPEND_NOT_MET`, `NOT_APPLICABLE_TO_ITEMS`, `REGION_RESTRICTED`, `ACCOUNT_RESTRICTED`, `ALREADY_USED`, `OUT_OF_STOCK`, `NOT_COLLECTED`, `RATE_LIMITED`, `CAPTCHA`, `UNKNOWN_ERROR`.

Расширение не меняет количество, товары, SKU, адрес, доставку или оплату. Оно не нажимает Place order, Buy, Pay, Checkout, «Оформить заказ» или «Оплатить». Такие подписи дополнительно заблокированы в безопасном click-адаптере.

## Диагностика и fixtures

Кнопка «Экспорт диагностики» создаёт JSON со следующими полями:

- `pageType`, безопасный URL без query;
- `itemId`, `skuId`, locale, currency;
- `detectedPrice`, `priceCandidates`, `detectedPromotions`;
- `couponCandidates`, `selectorMatches`;
- `checkoutState`, `verificationResults`;
- `parserVersion`, timestamp.

Экспорт не читает cookies, auth tokens, пароли, платёжные данные и значения пользовательских полей. DOM snippets ограничены тегом, безопасными атрибутами и коротким текстом вокруг цены/купона.

Инструкция по превращению проблемного Debug JSON в обезличенный regression fixture находится в `tests/fixtures/README.md`.

## Проверка разработчиком

Нужен Node.js 18 или новее:

```bash
npm test
```

Команда запускает unit/regression-сценарии и статическую проверку всех JavaScript-файлов, manifest, JSON, порядка файлов и popup IDs. Unit-тесты не заменяют живую проверку конкретной локализации и аккаунта AliExpress.

## Что хранится локально

- `history:<itemId>:<skuId>` — история цены конкретного SKU;
- `latestProduct` — последняя открытая карточка;
- `lastSearch` — последняя разобранная выдача;
- `watchlist` — локальный список наблюдения;
- `couponCandidates` — только локальные USER/PRODUCT_PAGE/SESSION/manual candidates;
- `promoVerificationHistory` — локальные verification overlays без копии remote provenance;
- `promoFeed*` — валидированный feed, timestamps/version и cache metadata;
- `promoStorageSchemaVersion` — версия миграции promo storage (v4);
- `promoTestSession` — baseline, переходы state machine и результаты последней проверки.

Старый `promoLibrary` и schema v3 читаются при миграции в storage schema v4. USER codes, verification history, watchlist и price history сохраняются; старые дубли remote feed удаляются из persistent local library.

История сохраняет изменение цены сразу, одинаковую цену — не чаще раза в 12 часов, ограничивается 360 точками на SKU и общим бюджетом 2500 точек. `unlimitedStorage` не используется.

## Ограничения

AliExpress меняет DOM, тексты, локализации и checkout по региону/аккаунту. Код, не подошедший текущему заказу, не объявляется глобально нерабочим. При CAPTCHA, security verification, rate limit, невозможности безопасно удалить код или восстановить baseline проверка останавливается. Окончательное решение и нажатие кнопки оформления всегда остаётся за пользователем.
