const { test } = require('./harness');
const { sandbox, load } = require('./helpers');
const crypto = require('node:crypto');
const { signFeed } = require('../collector/signature');
const Production = require('../src/production-feed-config');

const box = load(sandbox({ AbortController, TextEncoder, crypto: crypto.webcrypto, atob: (value) => Buffer.from(value, 'base64').toString('binary') }), 'src/promo-constants.js', 'src/storage.js', 'src/production-feed-config.js', 'src/feed-signature.js', 'src/promo-feed.js');
const L = box.CouponHunterPromoConstants;
const F = box.CouponHunterPromoFeed;

const feed = (count, values = {}) => ({ schemaVersion: 3, feedId: 'coupon-hunter-aliexpress', revision: values.revision || `r-${count}`, mode: values.mode || 'FULL_SNAPSHOT', merchant: 'aliexpress', generatedAt: '2026-10-04T00:00:00Z', expiresAt: '2026-10-05T00:00:00Z', promos: Array.from({ length: count }, (_, index) => ({ code: `C${String(index).padStart(4, '0')}`, discountType: 'FIXED', discountAmount: index + 1 })), ...values });

class FakeStorage {
  constructor(data = {}) { this.data = { ...data }; }
  async get(keys) {
    if (typeof keys === 'string') return { [keys]: this.data[keys] };
    return Object.fromEntries((keys || Object.keys(this.data)).map((key) => [key, this.data[key]]));
  }
  async set(values) { Object.assign(this.data, values); }
}

function response(payload, options = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { ok: options.ok !== false, status: options.status || 200, headers: { get(name) { if (name === 'content-type') return options.contentType || 'application/json; charset=utf-8'; if (name === 'content-length') return options.contentLength || String(new TextEncoder().encode(text).length); return null; } }, async text() { return text; } };
}

function errorOf(fn) { try { fn(); return null; } catch (error) { return error.message; } }

test('remote feed loads 500 candidates', (t) => { const result = F.validateFeed(feed(500)); t.equal(result.promos.length, 500); t.equal(result.diagnostics.rejected, 0); });
test('remote feed loads 1000 candidates', (t) => { const result = F.validateFeed(feed(1000)); t.equal(result.promos.length, 1000); });
test('1001st remote candidate is discarded safely', (t) => { const result = F.validateFeed(feed(1001)); t.equal(result.promos.length, 1000); t.equal(result.diagnostics.rejected, 1); });
test('malformed JSON is rejected', (t) => { t.equal(errorOf(() => F.parseFeedText('{bad')), 'FEED_MALFORMED_JSON'); });
test('oversized response is rejected', (t) => { t.equal(errorOf(() => F.parseFeedText('x'.repeat(L.MAX_FEED_BYTES + 1))), 'FEED_RESPONSE_TOO_LARGE'); });
test('invalid promo code is rejected without rejecting whole feed', (t) => { const payload = feed(1); payload.promos.push({ code: 'bad!' }); const result = F.validateFeed(payload); t.equal(result.promos.length, 1); t.equal(result.diagnostics.rejected, 1); });
test('invalid promo enums are rejected per entry', (t) => { const payload = feed(1); payload.promos.push({ code: 'ENUM10', discountType: 'SCRIPTED' }); const result = F.validateFeed(payload); t.equal(result.promos.length, 1); t.equal(result.diagnostics.rejected, 1); });
test('feed rejects executable-shaped data', (t) => { const payload = feed(1); payload.promos[0].selector = '#pay'; t.equal(errorOf(() => F.validateFeed(payload)), 'FEED_UNSAFE_CONTENT'); });
test('feed rejects non-JSON content type', async (t) => {
  let message = null; try { await F.fetchFeed('https://feed.example/promos.json', { fetchImpl: async () => response(feed(1), { contentType: 'text/html' }) }); } catch (error) { message = error.message; }
  t.equal(message, 'FEED_CONTENT_TYPE');
});
test('feed request is one-way and omits credentials/referrer', async (t) => {
  let request = null; await F.fetchFeed('https://feed.example/promos.json', { fetchImpl: async (_url, options) => { request = options; return response(feed(1)); } });
  t.equal(request.method, 'GET'); t.equal(request.credentials, 'omit'); t.equal(request.referrerPolicy, 'no-referrer');
});
test('fresh cache avoids network request', async (t) => {
  const nowMs = Date.parse('2026-10-04T12:00:00Z'); const cachedFeed = F.validateFeed(feed(1));
  const storage = new FakeStorage({ promoFeed: cachedFeed, promoFeedFetchedAt: new Date(nowMs - 10 * 60_000).toISOString(), promoFeedExpiresAt: '2026-10-05T00:00:00Z' }); let calls = 0;
  const result = await F.refresh('https://feed.example/promos.json', { storage, nowMs, fetchImpl: async () => { calls += 1; return response(feed(2)); } });
  t.equal(result.cacheStatus, 'FRESH_CACHE'); t.equal(calls, 0); t.equal(result.feed.promos.length, 1);
});
test('stale cache is used when feed is unavailable', async (t) => {
  const nowMs = Date.parse('2026-10-04T12:00:00Z'); const cachedFeed = F.validateFeed(feed(1));
  const storage = new FakeStorage({ promoFeed: cachedFeed, promoFeedFetchedAt: new Date(nowMs - 5 * 60 * 60_000).toISOString(), promoFeedExpiresAt: '2026-10-05T00:00:00Z' });
  const result = await F.refresh('https://feed.example/promos.json', { storage, nowMs, fetchImpl: async () => { throw new Error('offline'); } });
  t.equal(result.cacheStatus, 'STALE_CACHE'); t.equal(result.feed.promos.length, 1); t.equal(result.error, 'offline');
});
test('feed unavailable does not remove local candidates', async (t) => {
  const storage = new FakeStorage(); let message = null;
  try { await F.refresh('https://feed.example/promos.json', { storage, fetchImpl: async () => { throw new Error('offline'); } }); } catch (error) { message = error.message; }
  t.equal(message, 'offline'); t.equal(storage.data.promoFeed, undefined);
});
test('unsafe feed URL protocols are rejected', (t) => { t.equal(errorOf(() => F.validateFeedUrl('javascript:alert(1)')), 'FEED_URL_PROTOCOL'); });

test('full snapshot retracts remote claims missing from the next revision', (t) => {
  const first = F.validateFeed({ ...feed(0, { revision: 'r1' }), promos: [{ code: 'OLD10', sourceClaims: [{ sourceId: 'provider', sourceGroup: 'provider', category: 'VERIFIED_PROVIDER', trust: 0.8 }] }, { code: 'NEW10', sourceClaims: [{ sourceId: 'provider', sourceGroup: 'provider', category: 'VERIFIED_PROVIDER', trust: 0.8 }] }] });
  const second = F.validateFeed({ ...feed(0, { revision: 'r2' }), promos: [{ code: 'NEW10', sourceClaims: [{ sourceId: 'provider', sourceGroup: 'provider', category: 'VERIFIED_PROVIDER', trust: 0.8 }] }] });
  const reconciled = F.reconcileFeeds(first, second); t.deep(reconciled.promos.map((row) => row.code), ['NEW10']); t.ok(reconciled.retractions.some((row) => row.code === 'OLD10'));
});

test('local USER claim survives removal of same remote code', async (t) => {
  const first = F.validateFeed({ ...feed(0, { revision: 'r1' }), promos: [{ code: 'SHARED10', sourceClaims: [{ sourceId: 'provider', sourceGroup: 'provider', category: 'VERIFIED_PROVIDER', trust: 0.8 }] }] });
  const second = F.reconcileFeeds(first, F.validateFeed(feed(0, { revision: 'r2' })));
  const storage = new FakeStorage({ promoStorageSchemaVersion: 4, couponCandidates: [box.CouponHunterStorage.candidate({ code: 'SHARED10', source: box.CouponHunterStorage.SOURCES.USER })], promoFeed: second, promoVerificationHistory: {} });
  box.chrome = { storage: { local: storage } }; const library = await box.CouponHunterStorage.load();
  t.equal(library.length, 1); t.equal(library[0].code, 'SHARED10'); t.ok(library[0].sourceClaims.some((claim) => claim.category === 'USER'));
});

test('incremental SUSPENDED deactivates a remote claim and reappearance activates it', (t) => {
  const first = F.validateFeed({ ...feed(0, { revision: 'r1' }), promos: [{ code: 'RETURN10', source: 'provider', sourceGroup: 'provider' }] });
  const suspended = F.validateFeed({ ...feed(0, { revision: 'r2', mode: 'INCREMENTAL' }), promos: [{ code: 'RETURN10', source: 'provider', sourceGroup: 'provider', lifecycleStatus: 'SUSPENDED' }] });
  const inactive = F.reconcileFeeds(first, suspended); t.equal(inactive.promos.length, 0); t.ok(inactive.retractions.some((row) => row.code === 'RETURN10'));
  const active = F.validateFeed({ ...feed(0, { revision: 'r3', mode: 'INCREMENTAL' }), promos: [{ code: 'RETURN10', source: 'provider', sourceGroup: 'provider' }] });
  const reactivated = F.reconcileFeeds(inactive, active); t.equal(reactivated.promos.length, 1); t.equal(reactivated.promos[0].sourceClaims[0].status, 'ACTIVE');
});

test('unknown or downgraded feed schema is rejected', (t) => {
  const payload = feed(1); payload.schemaVersion = 2; t.equal(errorOf(() => F.validateFeed(payload)), 'FEED_SCHEMA_UNSUPPORTED');
  payload.schemaVersion = 99; t.equal(errorOf(() => F.validateFeed(payload)), 'FEED_SCHEMA_UNSUPPORTED');
});

test('production feed is configured by default with exact direct HTTPS URL, JWK and required signature', async (t) => {
  const source = await F.configuredSource(new FakeStorage());
  t.equal(source.url, 'https://qsen.ru/coupon-hunter-source/promo-feed.json');
  t.equal(new URL(source.url).protocol, 'https:');
  t.ok(!source.url.includes('qtenwten.github.io'));
  t.equal(source.requireSignature, true);
  t.deep(source.publicKeyJwk, { crv: 'Ed25519', x: 'G_ifdtSAuos7LGKdXjcIRjEsBZ8ZhYlRHWjaRlPUjSg', kty: 'OKP' });
  t.equal(JSON.stringify(Production.publicKeyJwk), JSON.stringify(source.publicKeyJwk));
  t.equal(Production.keyId, 'feed-ed25519-2026-10-05');
});

test('production config cannot be downgraded while local dev fixture remains available', async (t) => {
  const overridden = await F.configuredSource(new FakeStorage({ promoFeedConfig: { url: 'https://unsigned.example/feed.json', requireSignature: false } }));
  t.equal(overridden.url, Production.url); t.equal(overridden.requireSignature, true);
  box.chrome = { runtime: { getURL: (path) => `chrome-extension://test/${path}` } };
  const development = await F.configuredSource(new FakeStorage({ promoFeedConfig: { devMode: true, localFixturePath: 'data/promo-feed.dev.json' } }));
  t.equal(development.url, 'chrome-extension://test/data/promo-feed.dev.json'); t.equal(development.requireSignature, false);
});

test('production signature policy rejects unsigned and tampered feed payloads', async (t) => {
  let unsignedError = null;
  try { await F.refreshConfigured({ storage: new FakeStorage(), fetchImpl: async () => response(feed(1)) }); } catch (error) { unsignedError = error.message; }
  t.equal(unsignedError, 'FEED_SIGNATURE_INVALID');
  const keys = crypto.generateKeyPairSync('ed25519'); const signed = signFeed(feed(1), keys.privateKey, 'test'); signed.promos[0].discountAmount = 999;
  let tamperedError = null;
  try { await F.fetchFeed('https://feed.example/promos.json', { requireSignature: true, publicKeyJwk: keys.publicKey.export({ format: 'jwk' }), fetchImpl: async () => response(signed) }); } catch (error) { tamperedError = error.message; }
  t.equal(tamperedError, 'FEED_SIGNATURE_INVALID');
});
