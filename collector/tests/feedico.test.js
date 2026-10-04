const { test } = require('../../tests/harness');
const fixture = require('../fixtures/feedico-catalog.json');
const { FEEDICO_PAGE_SIZE, FEEDICO_MAX_PAGES_PER_RUN, extractFeedicoTerms, normalizeCoupon, createFeedicoAdapter } = require('../source-adapters/feedico');
const { buildFeed } = require('../build-feed');

const response = (payload) => ({ ok: true, status: 200, headers: { get() { return null; } }, async json() { return payload; } });

test('Feedico fixture preserves title, merchant context, dates and provider', (t) => {
  const row = normalizeCoupon(fixture.coupons[0]);
  t.equal(row.title, '20% off orders over $100'); t.equal(row.providerBrandName, 'AliExpress'); t.equal(row.providerFirmName, 'AliExpress Global');
  t.equal(row.startsAt, '2026-10-01T00:00:00Z'); t.equal(row.expiresAt, '2026-10-31T23:59:59Z');
  t.equal(row.providerMerchantWebsiteUrl, 'https://www.aliexpress.com'); t.equal(row.providerSource, 'awin_affiliate');
});

test('Feedico deterministic parser extracts unambiguous percent and minimum spend', (t) => {
  t.deep(extractFeedicoTerms('20% off orders over $100'), { discountAmount: null, discountPercent: 20, minimumSpend: 100, currency: 'USD' });
  t.deep(extractFeedicoTerms('Get 15% discount when you spend EUR 80'), { discountAmount: null, discountPercent: 15, minimumSpend: 80, currency: 'EUR' });
});

test('Feedico deterministic parser extracts fixed discount without guessing', (t) => {
  t.deep(extractFeedicoTerms('$10 off orders over $80'), { discountAmount: 10, discountPercent: null, minimumSpend: 80, currency: 'USD' });
  t.deep(extractFeedicoTerms('Save €15 on purchases above €100'), { discountAmount: 15, discountPercent: null, minimumSpend: 100, currency: 'EUR' });
});

test('Feedico ambiguous or conflicting title conditions stay null', (t) => {
  t.deep(extractFeedicoTerms('Up to 30% off selected items'), { discountAmount: null, discountPercent: null, minimumSpend: null, currency: null });
  t.deep(extractFeedicoTerms('$10 off orders over €80'), { discountAmount: 10, discountPercent: null, minimumSpend: null, currency: 'USD' });
  t.deep(extractFeedicoTerms('Great seasonal deal'), { discountAmount: null, discountPercent: null, minimumSpend: null, currency: null });
});

test('Feedico adapter filters non-AliExpress fixture rows and reports diagnostics', async (t) => {
  const adapter = createFeedicoAdapter({ token: 'fixture-token' }); let calls = 0;
  const result = await adapter.fetch({ nowMs: Date.parse('2026-10-04T12:00:00Z'), fetchImpl: async () => { calls += 1; return response(fixture); } });
  t.equal(calls, 1); t.equal(result.rawCount, 4); t.equal(result.rows.length, 3); t.equal(result.diagnostics.normalizedCount, 3); t.equal(result.diagnostics.pagesRequested, 1); t.equal(result.diagnostics.feedicoTruncated, false);
});

test('Feedico hard cap prevents a sixth network call even with wrong recordCount', async (t) => {
  const adapter = createFeedicoAdapter({ token: 'fixture-token' }); let calls = 0; const requestedPages = [];
  const result = await adapter.fetch({ fetchImpl: async (_url, options) => {
    calls += 1; const body = JSON.parse(options.body); requestedPages.push(body.page); t.equal(body.pageSize, FEEDICO_PAGE_SIZE);
    return response({ ok: true, recordCount: 999999, page: body.page, pageSize: FEEDICO_PAGE_SIZE, coupons: Array.from({ length: FEEDICO_PAGE_SIZE }, (_, index) => ({ id: `${body.page}-${index}`, brandName: 'AliExpress', code: `A${body.page}${String(index).padStart(3, '0')}`, title: '10% off', merchantWebsiteUrl: 'https://aliexpress.com' })) });
  } });
  t.equal(FEEDICO_MAX_PAGES_PER_RUN, 5); t.equal(calls, 5); t.deep(requestedPages, [1, 2, 3, 4, 5]); t.equal(result.rawCount, 500); t.equal(result.rows.length, 500); t.equal(result.diagnostics.pagesRequested, 5); t.equal(result.diagnostics.feedicoTruncated, true);
});

test('Feedico truncation and preserved metadata reach safe public diagnostics', async (t) => {
  const adapter = createFeedicoAdapter({ token: 'fixture-token' });
  adapter.fetch = async () => ({ rows: fixture.coupons.filter((row) => row.code && /aliexpress/i.test(row.brandName)).map(normalizeCoupon), rawCount: 501, diagnostics: { pagesRequested: 5, rawCount: 501, normalizedCount: 3, feedicoTruncated: true } });
  const feed = await buildFeed([adapter], { nowMs: Date.parse('2026-10-04T12:00:00Z') }); const health = feed.diagnostics.sourceHealth.feedico;
  t.equal(feed.diagnostics.feedicoTruncated, true); t.equal(health.pagesRequested, 5); t.equal(health.rawCount, 501); t.equal(health.normalizedCount, 3);
  t.equal(feed.promos[0].title, fixture.coupons[0].title); t.equal(feed.promos[0].providerMetadata[0].brandName, 'AliExpress');
});
