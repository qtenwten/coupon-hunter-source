const path = require('node:path');
const { test } = require('../../tests/harness');
const { buildFeed } = require('../build-feed');
const { PUBLIC_FEED_TARGET_BYTES, boundPromosByBytes, buildFeedWithState, buildProductionFeed } = require('../build-feed');
const { defaultRegistry } = require('../source-registry');
const { normalizeOffer, createCouponApiAdapter } = require('../source-adapters/couponapi');
const { requestJson } = require('../http-client');
const fs = require('node:fs/promises');
const os = require('node:os');

const NOW = Date.parse('2026-10-04T12:00:00Z');
const adapter = (id, sourceGroup, rows, options = {}) => ({ id, sourceGroup, category: options.category || 'VERIFIED_PROVIDER', trust: options.trust ?? 0.8, enabled: options.enabled !== false, async fetch() { if (options.fail) throw new Error(options.fail); return rows; }, normalize(value) { return value; } });

test('collector output is deterministic and sorted for the same claims', async (t) => {
  const sources = [adapter('b', 'b', [{ code: 'ZZZ10', discountAmount: 10 }, { code: 'AAA10', discountAmount: 5 }])];
  const first = await buildFeed(sources, { nowMs: NOW }); const second = await buildFeed(sources, { nowMs: NOW });
  t.deep(first, second); t.deep(first.promos.map((row) => row.code), ['AAA10', 'ZZZ10']);
});

test('collector source failure does not cancel successful adapters', async (t) => {
  const feed = await buildFeed([adapter('ok', 'ok', [{ code: 'GOOD10', discountAmount: 10 }]), adapter('bad', 'bad', [], { fail: 'HTTP 403' })], { nowMs: NOW });
  t.equal(feed.promos.length, 1); t.equal(feed.diagnostics.sourcesSucceeded, 1); t.equal(feed.diagnostics.sourcesFailed, 1);
  t.equal(feed.diagnostics.sourceHealth.bad.status, 'FAILED'); t.match(feed.diagnostics.sourceHealth.bad.reason, /403/);
});

test('collector keeps conflicting claims instead of overwriting minimum spend', async (t) => {
  const feed = await buildFeed([adapter('a', 'a', [{ code: 'MIXED10', minimumSpend: 80 }]), adapter('b', 'b', [{ code: 'MIXED10', minimumSpend: 89 }])], { nowMs: NOW });
  t.equal(feed.promos[0].sourceClaims.length, 2); t.ok(feed.promos[0].conflicts.some((row) => row.field === 'claimedMinimumSpend'));
});

test('collector counts one sourceGroup once for corroboration', async (t) => {
  const feed = await buildFeed([adapter('page-a', 'provider', [{ code: 'GROUP20' }]), adapter('page-b', 'provider', [{ code: 'GROUP20' }])], { nowMs: NOW });
  t.equal(feed.promos[0].independentSourceGroups, 1); t.equal(feed.promos[0].confidenceBreakdown.corroboration, 0);
});

test('collector removes expired claims and reports diagnostics', async (t) => {
  const feed = await buildFeed([adapter('a', 'a', [{ code: 'OLD20', expiresAt: '2026-10-03T00:00:00Z' }, { code: 'NEW20', expiresAt: '2026-10-05T00:00:00Z' }])], { nowMs: NOW });
  t.deep(feed.promos.map((row) => row.code), ['NEW20']); t.equal(feed.diagnostics.expiredRemoved, 1);
});

test('default source registry enables only empty manual curated data', async (t) => {
  const registry = defaultRegistry(); const enabled = registry.filter((row) => row.enabled); const disabled = registry.filter((row) => !row.enabled);
  t.deep(enabled.map((row) => row.id), ['manual_curated']); t.equal(disabled.length, 8);
  for (const row of disabled) t.ok(!!row.disabledReason, row.id);
  const fixture = enabled[0]; t.ok(fixture.path === undefined || path.isAbsolute(path.join(__dirname, '..', 'fixtures', 'manual-curated.json')));
});

test('collector trust is averaged by independent sourceGroup, not repeated observations', async (t) => {
  const community = Array.from({ length: 100 }, () => ({ code: 'TRUST10' }));
  const feed = await buildFeed([adapter('official', 'official', [{ code: 'TRUST10' }], { trust: 0.98, category: 'OFFICIAL_ALIEXPRESS' }), adapter('reddit', 'reddit', community, { trust: 0.45, category: 'COMMUNITY' })], { nowMs: NOW });
  t.equal(feed.promos[0].sourceClaims.length, 2); t.equal(feed.promos[0].independentSourceGroups, 2); t.equal(feed.promos[0].confidenceBreakdown.sourceTrust, 72); t.equal(feed.promos[0].sourceClaims.find((row) => row.sourceId === 'reddit').observationCount, 100);
});

test('CouponAPI NEW and UPDATED offers normalize conservatively', (t) => {
  const fresh = normalizeOffer({ offer_id: 1, status: 'new', code: 'SAVE10', title: '$10 off orders over $80', store: 'aliexpress.com', start_date: '2026-10-01', end_date: '2026-10-31', locations: 'US,CA', rating: '4' });
  t.equal(fresh.providerAction, 'NEW'); t.equal(fresh.discountAmount, 10); t.equal(fresh.minimumSpend, 80); t.equal(fresh.currency, 'USD'); t.deep(fresh.regions, ['US', 'CA']);
  const updated = normalizeOffer({ offer_id: 1, status: 'updated', code: 'SAVE10', description: 'maybe save a lot', store: 'AliExpress' });
  t.equal(updated.providerAction, 'UPDATED'); t.equal(updated.discountAmount, null); t.equal(updated.minimumSpend, null);
  const suspended = normalizeOffer({ offer_id: 1, status: 'suspended' }, { code: 'SAVE10', store: 'aliexpress.com' }); t.equal(suspended.code, 'SAVE10'); t.equal(suspended.lifecycleStatus, 'SUSPENDED');
});

test('CouponAPI SUSPENDED removes its previous source claim', async (t) => {
  const source = adapter('couponapi', 'couponapi', [{ code: 'GONE10' }]); source.mode = 'INCREMENTAL';
  const first = await buildFeed(source ? [source] : [], { nowMs: NOW });
  const suspended = adapter('couponapi', 'couponapi', [{ code: 'GONE10', lifecycleStatus: 'SUSPENDED' }]); suspended.mode = 'INCREMENTAL';
  const next = await buildFeed([suspended], { nowMs: NOW + 1000, previousFeed: first }); t.equal(next.promos.length, 0);
});

test('CouponAPI adapter keeps cursor state and filters non-AliExpress offers', async (t) => {
  const source = createCouponApiAdapter({ apiKey: 'secret-test-key' }); let requested = '';
  const result = await source.fetch({ nowMs: NOW, providerState: { couponapi: { lastExtract: 123 } }, fetchImpl: async (url) => { requested = url; return { ok: true, status: 200, headers: { get() { return null; } }, async json() { return { result: true, offers: [{ offer_id: 1, status: 'new', code: 'ALI10', store: 'aliexpress.com', type: 'Code' }, { offer_id: 2, status: 'new', code: 'OTHER10', store: 'example.com', type: 'Code' }] }; } }; } });
  t.equal(result.rows.length, 1); t.equal(result.rows[0].code, 'ALI10'); t.ok(requested.includes('last_extract=123')); t.equal(result.state.lastExtract, Math.floor(NOW / 1000));
});

test('provider 401 does not retry', async (t) => {
  let calls = 0; let errorClass = null;
  try { await requestJson('https://provider.example', { retries: 2, fetchImpl: async () => { calls += 1; return { ok: false, status: 401, headers: { get() { return null; } } }; } }); } catch (error) { errorClass = error.errorClass; }
  t.equal(calls, 1); t.equal(errorClass, 'AUTH_REQUIRED');
});

test('provider 429 respects Retry-After once and stops source sync', async (t) => {
  let calls = 0; const waits = []; let errorClass = null;
  try { await requestJson('https://provider.example', { retries: 2, sleep: async (ms) => waits.push(ms), fetchImpl: async () => { calls += 1; return { ok: false, status: 429, headers: { get(name) { return name === 'retry-after' ? '2' : null; } } }; } }); } catch (error) { errorClass = error.errorClass; }
  t.equal(calls, 1); t.deep(waits, [2000]); t.equal(errorClass, 'RATE_LIMITED');
});

test('empty provider result is healthy EMPTY rather than failure', async (t) => {
  const built = await buildFeedWithState([adapter('empty', 'empty', [])], { nowMs: NOW });
  t.equal(built.feed.promos.length, 0); t.equal(built.feed.diagnostics.sourceHealth.empty.status, 'EMPTY'); t.equal(built.feed.diagnostics.sourcesFailed, 0);
});

test('provider health distinguishes AUTH_REQUIRED and RATE_LIMITED', async (t) => {
  const auth = adapter('auth', 'auth', []); auth.fetch = async () => { const error = new Error('no credentials'); error.errorClass = 'AUTH_REQUIRED'; throw error; };
  const limited = adapter('limited', 'limited', []); limited.fetch = async () => { const error = new Error('slow down'); error.errorClass = 'RATE_LIMITED'; throw error; };
  const feed = await buildFeed([auth, limited], { nowMs: NOW }); t.equal(feed.diagnostics.sourceHealth.auth.status, 'AUTH_REQUIRED'); t.equal(feed.diagnostics.sourceHealth.limited.status, 'RATE_LIMITED');
});

test('provider failure preserves claims from previous good feed', async (t) => {
  const first = await buildFeed([adapter('provider', 'provider', [{ code: 'KEEP10' }])], { nowMs: NOW });
  const next = await buildFeed([adapter('provider', 'provider', [], { fail: 'network API_KEY=secret' })], { nowMs: NOW + 1000, previousFeed: first, providerState: { provider: { lastSuccessAt: first.generatedAt } } });
  t.deep(next.promos.map((row) => row.code), ['KEEP10']); t.equal(next.diagnostics.sourceHealth.provider.status, 'FAILED'); t.ok(!next.diagnostics.sourceHealth.provider.reason.includes('secret'));
});

test('production feed replacement is atomic and failed signing preserves previous file', async (t) => {
  const directory = await fs.mkdtemp(`${os.tmpdir()}/coupon-hunter-`); const output = `${directory}/feed.json`; const statePath = `${directory}/state.json`;
  const initial = await buildFeed([adapter('provider', 'provider', [{ code: 'ATOMIC10' }])], { nowMs: NOW }); await fs.writeFile(output, JSON.stringify(initial));
  let failed = false; try { await buildProductionFeed({ output, statePath, adapters: [adapter('provider', 'provider', [{ code: 'BROKEN10' }])], nowMs: NOW + 1000, privateKey: 'not-a-private-key' }); } catch (_) { failed = true; }
  const after = JSON.parse(await fs.readFile(output, 'utf8')); t.equal(failed, true); t.deep(after.promos.map((row) => row.code), ['ATOMIC10']);
});

test('public feed promo payload is bounded below extension response limit', (t) => {
  const rows = Array.from({ length: 1000 }, (_, index) => ({ code: `SIZE${String(index).padStart(4, '0')}`, title: 'x'.repeat(3000) })); const bounded = boundPromosByBytes(rows);
  t.ok(bounded.bytes <= PUBLIC_FEED_TARGET_BYTES); t.ok(bounded.omitted > 0); t.ok(Buffer.byteLength(JSON.stringify(bounded.promos)) < 2 * 1024 * 1024);
});
