const { test } = require('./harness');
const { sandbox, load } = require('./helpers');

const box = load(sandbox(), 'src/storage.js');
const S = box.CouponHunterStorage;

test('candidate registry deduplicates codes case-insensitively and preserves sources', (t) => {
  const rows = S.mergeCandidates(
    [{ code: 'sale20', source: S.SOURCES.USER, minimumSpend: 1000 }],
    [{ code: 'SALE20', source: S.SOURCES.PRODUCT_PAGE, discountAmount: 200 }, { code: 'other10', source: S.SOURCES.KNOWN_LIST }]
  );
  t.equal(rows.length, 2); const sale = rows.find((row) => row.code === 'SALE20');
  t.equal(sale.minimumSpend, 1000); t.equal(sale.discountAmount, 200);
  t.deep(sale.sources.sort(), ['PRODUCT_PAGE', 'USER']);
});

test('invalid and random-looking malformed codes are not accepted', (t) => {
  t.equal(S.normalizeCode('ab'), null); t.equal(S.normalizeCode('bad!code'), null);
  t.equal(S.normalizeCode(' ae_us-10 '), 'AE_US-10');
});

test('remote JSON architecture imports data only, never executable fields', (t) => {
  const rows = S.importDataPayload(JSON.stringify({ codes: [{ code: 'REMOTE10', region: 'US', currency: 'USD', javascript: 'alert(1)' }, 'plain20'] }));
  t.equal(rows.length, 2); t.equal(rows[0].source, S.SOURCES.REMOTE_JSON);
  t.equal(rows[0].region, 'US'); t.equal(rows[0].javascript, undefined); t.equal(rows[1].code, 'PLAIN20');
  t.deep(S.importDataPayload('{bad json'), []);
});

test('promotion candidates retain order applicability metadata', (t) => {
  const rows = S.candidatesFromPromotions([{ code: 'KEEP500', title: '500 off', minimumSpend: 5000, discountAmount: 500, currency: 'RUB', itemId: '1', skuId: '2' }]);
  t.equal(rows[0].code, 'KEEP500'); t.equal(rows[0].minimumSpend, 5000);
  t.equal(rows[0].itemId, '1'); t.equal(rows[0].skuId, '2');
});

test('watchlist does not update every SKU when current product SKU is unknown', (t) => {
  const watchlist = [
    { itemId: 'ITEM', skuId: 'SKU-A', lastKnownPrice: 100 },
    { itemId: 'ITEM', skuId: 'SKU-B', lastKnownPrice: 200 },
    { itemId: 'OTHER', skuId: 'SKU-X', lastKnownPrice: 300 }
  ];
  const updated = S.updateWatchlistForProduct(watchlist, { itemId: 'ITEM', skuId: null, detectedPrice: { value: 50 }, parsedAt: '2026-01-01T00:00:00Z' });
  t.deep(updated, watchlist);
});

test('watchlist updates only the matching SKU entry', (t) => {
  const watchlist = [{ itemId: 'ITEM', skuId: 'SKU-A', lastKnownPrice: 100 }, { itemId: 'ITEM', skuId: 'SKU-B', lastKnownPrice: 200 }];
  const updated = S.updateWatchlistForProduct(watchlist, { itemId: 'ITEM', skuId: 'SKU-B', detectedPrice: { value: 150 }, currency: 'RUB', parsedAt: '2026-01-01T00:00:00Z', promotions: [] });
  t.equal(updated[0].lastKnownPrice, 100); t.equal(updated[1].lastKnownPrice, 150);
});

test('history retention saves changes immediately and throttles equal prices', (t) => {
  const first = { parsedAt: '2026-01-01T00:00:00Z', price: 100, currency: 'RUB', skuId: 'A', selectedVariant: 'Black' };
  const sameSoon = { ...first, parsedAt: '2026-01-01T01:00:00Z' };
  const changed = { ...first, parsedAt: '2026-01-01T01:01:00Z', price: 90 };
  let rows = S.retainHistory([], first); rows = S.retainHistory(rows, sameSoon); t.equal(rows.length, 1);
  rows = S.retainHistory(rows, changed); t.equal(rows.length, 2); t.equal(rows.at(-1).price, 90);
});

test('history retention enforces per-SKU and global budgets', (t) => {
  let rows = [];
  for (let index = 0; index < 8; index += 1) rows = S.retainHistory(rows, { parsedAt: new Date(index * 1000).toISOString(), price: index, currency: 'RUB', skuId: 'A' }, { maxPerSku: 3 });
  t.deep(rows.map((row) => row.price), [5, 6, 7]);
  const storage = { 'history:A': [{ parsedAt: '2026-01-01T00:00:00Z' }, { parsedAt: '2026-01-03T00:00:00Z' }], 'history:B': [{ parsedAt: '2026-01-02T00:00:00Z' }, { parsedAt: '2026-01-04T00:00:00Z' }] };
  const pruned = S.pruneHistoryObject(storage, 2);
  t.deep(pruned['history:A'], [{ parsedAt: '2026-01-03T00:00:00Z' }]); t.deep(pruned['history:B'], [{ parsedAt: '2026-01-04T00:00:00Z' }]);
});

test('1000 observations from one source are compacted into one bounded claim', (t) => {
  const observations = Array.from({ length: 1000 }, (_, index) => ({ sourceId: 'provider-a', sourceGroup: 'provider-a', category: 'VERIFIED_PROVIDER', observedAt: new Date(Date.parse('2026-01-01T00:00:00Z') + index * 1000).toISOString(), trust: 0.8, claimedMinimumSpend: index < 999 ? 80 : 90 }));
  const row = S.candidate({ code: 'COMPACT10', source: S.SOURCES.REMOTE_JSON, sourceClaims: observations });
  t.equal(row.sourceClaims.length, 1); t.equal(row.independentSourceGroups, 1); t.equal(row.sourceClaims[0].observationCount, 1000);
  t.ok(row.sourceClaims[0].changeHistory.length <= 8); t.ok(S.estimateBytes(row) < 20_000);
});

test('source claim count has a hard per-promo cap', (t) => {
  const sourceClaims = Array.from({ length: 100 }, (_, index) => ({ sourceId: `source-${index}`, sourceGroup: `group-${index}`, category: 'COMMUNITY', observedAt: '2026-01-01T00:00:00Z', trust: 0.4 }));
  const row = S.candidate({ code: 'BOUNDED10', source: S.SOURCES.REMOTE_JSON, sourceClaims });
  t.ok(row.sourceClaims.length <= 32);
});

test('effective library combines local state and remote cache without copying remote rows', async (t) => {
  class Storage { constructor(data) { this.data = data; } async get(keys) { if (keys === null) return { ...this.data }; if (typeof keys === 'string') return { [keys]: this.data[keys] }; return Object.fromEntries(keys.map((key) => [key, this.data[key]])); } async set(values) { Object.assign(this.data, values); } async getBytesInUse() { return S.estimateBytes(this.data); } }
  const storage = new Storage({ promoStorageSchemaVersion: 4, couponCandidates: [S.candidate({ code: 'USER10', source: S.SOURCES.USER })], promoFeed: { promos: [S.candidate({ code: 'REMOTE10', source: S.SOURCES.REMOTE_JSON })] }, promoVerificationHistory: {} });
  box.chrome = { storage: { local: storage } };
  const library = await S.load(); t.deep(library.map((row) => row.code).sort(), ['REMOTE10', 'USER10']); t.equal(storage.data.couponCandidates.length, 1);
  await S.upsert(storage.data.promoFeed.promos); t.equal(storage.data.couponCandidates.length, 1); t.equal(storage.data.couponCandidates[0].code, 'USER10');
});

test('expired remote snapshot is excluded while local user code remains', async (t) => {
  class Storage { constructor(data) { this.data = data; } async get(keys) { if (keys === null) return { ...this.data }; if (typeof keys === 'string') return { [keys]: this.data[keys] }; return Object.fromEntries(keys.map((key) => [key, this.data[key]])); } async set(values) { Object.assign(this.data, values); } }
  const storage = new Storage({ promoStorageSchemaVersion: 4, couponCandidates: [S.candidate({ code: 'LOCAL10', source: S.SOURCES.USER })], promoFeed: { expiresAt: '2000-01-01T00:00:00Z', promos: [S.candidate({ code: 'EXPIRED10', source: S.SOURCES.REMOTE_JSON })] }, promoVerificationHistory: {} }); box.chrome = { storage: { local: storage } };
  const library = await S.load(); t.deep(library.map((row) => row.code), ['LOCAL10']);
});

test('merging remote provenance cannot erase an explicit USER claim', (t) => {
  const merged = S.mergeCandidates(S.candidate({ code: 'SHARED20', source: S.SOURCES.REMOTE_JSON }), S.candidate({ code: 'SHARED20', source: S.SOURCES.USER }))[0]; const local = S.localCandidates([merged]);
  t.equal(local.length, 1); t.equal(local[0].code, 'SHARED20'); t.ok(local[0].sourceClaims.some((claim) => claim.category === 'USER' && claim.origin === 'LOCAL'));
});

test('storage diagnostics use getBytesInUse and soft-budget compaction never removes user codes', async (t) => {
  class Storage { constructor(data) { this.data = data; } async get(keys) { if (keys === null) return { ...this.data }; if (typeof keys === 'string') return { [keys]: this.data[keys] }; return Object.fromEntries(keys.map((key) => [key, this.data[key]])); } async set(values) { Object.assign(this.data, values); } async getBytesInUse() { return 5 * 1024 * 1024; } }
  const user = S.candidate({ code: 'KEEPUSER', source: S.SOURCES.USER }); const storage = new Storage({ couponCandidates: [user], promoFeed: { retractions: Array.from({ length: 250 }, (_, index) => ({ code: `OLD${index}` })) } });
  const diagnostics = await S.storageDiagnostics(storage); t.equal(diagnostics.overSoftBudget, true); t.equal(diagnostics.bytesInUse, 5 * 1024 * 1024);
  await S.enforceStorageBudget(storage); t.equal(storage.data.couponCandidates[0].code, 'KEEPUSER'); t.ok(storage.data.promoFeed.retractions.length <= 25);
});
