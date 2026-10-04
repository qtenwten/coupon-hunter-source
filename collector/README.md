# Coupon Hunter collector 3.2.1

Collector — отдельный Node.js data pipeline. Он не входит в Chrome extension и не получает корзину, SKU, total, аккаунт или browser history пользователя.

## Production publishing

`.github/workflows/production-feed.yml` запускается вручную и по cron `17 */6 * * *`. Tests идут без provider credentials. Только build-step получает `FEEDICO_TOKEN` и `COUPON_HUNTER_FEED_PRIVATE_KEY_B64`, после чего runner повторно проверяет подпись public JWK без нового provider request. Production feed действует 18 часов.

Pages artifact содержит только `promo-feed.json` и безопасный `health.json`. Generated files, provider state и private key не коммитятся.

Cursor/state хранится отдельно в `collector/.provider-state.json` (путь можно заменить через `COUPON_HUNTER_PROVIDER_STATE`). Feed и state записываются через temporary file + rename. Неудачный fetch сохраняет claims предыдущего успешного snapshot; неудачная сборка/подпись не заменяет production feed.

Поддерживаемые server-side credentials:

- `COUPONAPI_KEY` — CouponAPI incremental feed (`new`, `updated`, `suspended`), trust 0.72;
- `COUPONAPI_INITIAL_EXTRACT` — опциональный initial epoch для контролируемого первого resync; затем используется сохранённый cursor;
- `FEEDICO_TOKEN` — Feedico catalog API. AliExpress coverage должна быть подтверждена реальным ответом аккаунта;
- `ALIGATE_RAPIDAPI_KEY` + `ALIGATE_STORE_NUMS` — только seller-scoped coupons для явно заданных store numbers;
- `COUPON_HUNTER_FEED_PRIVATE_KEY_B64` — base64 от Ed25519 PKCS8 PEM; ключ декодируется и сверяется с public JWK до provider/network access и никогда не помещается в extension/feed/repository;
- `COUPON_HUNTER_FEED_KEY_ID` — публичный идентификатор signing key.

Без credentials соответствующий adapter имеет `DISABLED`/`AUTH_REQUIRED`; коды не подставляются из fixtures. SimplyCodes остаётся `REQUIRES_PROVIDER_ACCESS`, официальный AliExpress source — `NO_CONFIRMED_BUYER_PROMO_ENDPOINT`.

## Feed contract

Public feed — data-only schema v3:

```json
{
  "schemaVersion": 3,
  "feedId": "coupon-hunter-aliexpress",
  "revision": "20261004…",
  "mode": "FULL_SNAPSHOT",
  "merchant": "aliexpress",
  "generatedAt": "…",
  "expiresAt": "…",
  "promos": [],
  "signature": { "algorithm": "Ed25519", "keyId": "feed-ed25519-2026-10-05", "value": "…" }
}
```

Extension использует production URL и public Ed25519 JWK из `src/production-feed-config.js`; production signature всегда обязательна и проверяется fail-closed. Local fixture разрешён unsigned только при explicit `devMode`.

```json
{
  "url": "https://qtenwten.github.io/coupon-hunter-source/promo-feed.json",
  "requireSignature": true,
  "publicKeyJwk": { "crv": "Ed25519", "x": "G_ifdtSAuos7LGKdXjcIRjEsBZ8ZhYlRHWjaRlPUjSg", "kty": "OKP" }
}
```

Feed download выполняется GET-only, без credentials/referrer, с timeout и лимитом 2 MiB. Collector держит promo payload ниже 1.8 MiB и пишет число отброшенных по byte budget строк в diagnostics.

Local development:

```json
{ "devMode": true, "localFixturePath": "data/promo-feed.dev.json" }
```

Provider health: `OK`, `EMPTY`, `FAILED`, `DISABLED`, `AUTH_REQUIRED`, `RATE_LIMITED`; сохраняются только безопасные `lastAttemptAt`, `lastSuccessAt`, counts и `errorClass`. 401/403 не retry; 429 учитывает `Retry-After` и останавливает sync; retry применяется только к network/5xx с ограниченным exponential backoff.

Feedico smoke запускается вручную через GitHub Actions или локально командой `npm run collector:feedico-smoke`. Adapter делает не более 5 запросов по 100 строк; при наличии продолжения выставляет `feedicoTruncated: true`. Smoke считается успешным при `OK` либо `EMPTY`, то есть только после успешного ответа API. `AUTH_REQUIRED`, 401/403, 429 и transport errors завершают smoke с ошибкой и безопасной диагностикой.
