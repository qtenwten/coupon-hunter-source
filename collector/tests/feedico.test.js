const { test } = require('../../tests/harness');
const { sandbox, load } = require('../../tests/helpers');
const fixture = require('../fixtures/feedico-catalog.json');
const liveQualityFixture = require('../fixtures/feedico-live-quality.json');
const { FEEDICO_PAGE_SIZE, FEEDICO_MAX_PAGES_PER_RUN, extractFeedicoTerms, extractFeedicoRegions, extractTitleRegions, extractNewUsersOnly, normalizeCoupon, createFeedicoAdapter } = require('../source-adapters/feedico');
const { buildFeed } = require('../build-feed');

const response = (payload) => ({ ok: true, status: 200, headers: { get() { return null; } }, async json() { return payload; } });

test('Feedico fixture preserves title, merchant context, dates and provider', (t) => {
  const row = normalizeCoupon(fixture.coupons[0]);
  t.equal(row.title, '20% off orders over $100'); t.equal(row.providerBrandName, 'AliExpress'); t.equal(row.providerFirmName, 'AliExpress Global');
  t.equal(row.startsAt, '2026-10-01T00:00:00Z'); t.equal(row.expiresAt, '2026-10-31T23:59:59Z');
  t.equal(row.providerMerchantWebsiteUrl, 'https://www.aliexpress.com'); t.equal(row.providerSource, 'awin_affiliate');
});

test('Feedico deterministic parser extracts unambiguous percent and minimum spend', (t) => {
  t.deep(extractFeedicoTerms('20% off orders over $100'), { discountAmount: null, discountPercent: 20, minimumSpend: 100, currency: 'USD', monetaryInterpretation: 'PARSED', monetaryAmbiguityReason: null });
  t.deep(extractFeedicoTerms('Get 15% discount when you spend EUR 80'), { discountAmount: null, discountPercent: 15, minimumSpend: 80, currency: 'EUR', monetaryInterpretation: 'PARSED', monetaryAmbiguityReason: null });
});

test('Feedico deterministic parser extracts fixed discount without guessing', (t) => {
  t.deep(extractFeedicoTerms('$10 off orders over $80'), { discountAmount: 10, discountPercent: null, minimumSpend: 80, currency: 'USD', monetaryInterpretation: 'PARSED', monetaryAmbiguityReason: null });
  t.deep(extractFeedicoTerms('Save €15 on purchases above €100'), { discountAmount: 15, discountPercent: null, minimumSpend: 100, currency: 'EUR', monetaryInterpretation: 'PARSED', monetaryAmbiguityReason: null });
});

test('Feedico ambiguous or conflicting title conditions stay null', (t) => {
  t.deep(extractFeedicoTerms('Up to 30% off selected items'), { discountAmount: null, discountPercent: null, minimumSpend: null, currency: null, monetaryInterpretation: 'AMBIGUOUS', monetaryAmbiguityReason: 'NON_DETERMINISTIC_LANGUAGE' });
  t.deep(extractFeedicoTerms('$10 off orders over €80'), { discountAmount: null, discountPercent: null, minimumSpend: null, currency: null, monetaryInterpretation: 'AMBIGUOUS', monetaryAmbiguityReason: 'CURRENCY_CONFLICT' });
  t.deep(extractFeedicoTerms('Great seasonal deal'), { discountAmount: null, discountPercent: null, minimumSpend: null, currency: null, monetaryInterpretation: 'UNKNOWN', monetaryAmbiguityReason: null });
});

test('Feedico live suspicious monetary pairs are ambiguous and cannot rank as savings', async (t) => {
  const suspicious = liveQualityFixture.coupons.filter((row) => ['AEUKFS20', 'AEUKFS31'].includes(row.code));
  for (const coupon of suspicious) {
    const row = normalizeCoupon(coupon);
    t.equal(row.discountAmount, null, coupon.code); t.equal(row.minimumSpend, null, coupon.code);
    t.equal(row.monetaryInterpretation, 'AMBIGUOUS', coupon.code); t.equal(row.monetaryAmbiguityReason, 'DISCOUNT_NOT_BELOW_MINIMUM_SPEND', coupon.code);
  }
  const adapter = createFeedicoAdapter({ token: 'fixture-token' });
  adapter.fetch = async () => ({ rows: suspicious.map(normalizeCoupon), rawCount: suspicious.length });
  const feed = await buildFeed([adapter], { nowMs: Date.parse('2026-10-04T12:00:00Z') });
  const box = sandbox(); load(box, 'src/promo-constants.js', 'src/storage.js', 'src/promo-intelligence.js');
  for (const promo of feed.promos) {
    t.equal(promo.discountType, 'UNKNOWN', promo.code); t.equal(promo.monetaryInterpretation, 'AMBIGUOUS', promo.code);
    t.deep(box.CouponHunterPromoIntelligence.estimateSaving(box.CouponHunterStorage.candidate(promo), { currency: 'GBP', subtotal: 1000 }), { estimatedSaving: null, theoreticalMaxSaving: null }, promo.code);
  }
});

test('Feedico regions prefer structured country data and use contextual title fallback', (t) => {
  t.deep(extractFeedicoRegions({ countryCode: 'US', title: 'Party Ready Sale UK codes' }), ['US']);
  t.deep(extractFeedicoRegions({ location: { country: 'United Kingdom' }, title: 'US Choice Day Sale' }), ['GB']);
  t.deep(extractFeedicoRegions({ location: 'Europe', title: 'Party Ready Sale UK codes' }), []);
  const byCode = Object.fromEntries(liveQualityFixture.coupons.map((row) => [row.code, normalizeCoupon(row).regions]));
  t.deep(byCode.AEUKFS12, ['GB']); t.deep(byCode.AUAU02, ['AU']); t.deep(byCode.CEELD02, ['CZ', 'HU']); t.deep(byCode.CLAF10, ['CL']);
  t.deep(extractTitleRegions('Save with us today'), []); t.deep(extractTitleRegions('IT is a great deal'), []);
});

test('Feedico audience restrictions are inferred only from unambiguous wording', (t) => {
  const live = liveQualityFixture.coupons.find((row) => row.code === '0003NEWUSOFF');
  t.equal(normalizeCoupon(live).newUsersOnly, true); t.deep(normalizeCoupon(live).regions, ['US']);
  t.equal(extractNewUsersOnly('New Users Only: save $5'), true);
  t.equal(extractNewUsersOnly('New customer discount'), true);
  t.equal(extractNewUsersOnly('Offer for existing and new users'), null);
  t.equal(extractNewUsersOnly('Seasonal customer discount'), null);
});

test('Feedico region and audience metadata survive final feed resolution', async (t) => {
  const selected = liveQualityFixture.coupons.filter((row) => ['AEUKFS12', '0003NEWUSOFF'].includes(row.code));
  const adapter = createFeedicoAdapter({ token: 'fixture-token' });
  adapter.fetch = async () => ({ rows: selected.map(normalizeCoupon), rawCount: selected.length });
  const feed = await buildFeed([adapter], { nowMs: Date.parse('2026-10-04T12:00:00Z') });
  const uk = feed.promos.find((row) => row.code === 'AEUKFS12'); const usNewUser = feed.promos.find((row) => row.code === '0003NEWUSOFF');
  t.deep(uk.regions, ['GB']); t.deep(uk.sourceClaims[0].claimedRegions, ['GB']);
  t.deep(usNewUser.regions, ['US']); t.equal(usNewUser.newUsersOnly, true);
  const box = sandbox(); load(box, 'src/promo-constants.js', 'src/storage.js', 'src/promo-intelligence.js');
  const assessed = box.CouponHunterPromoIntelligence.assessCandidate(box.CouponHunterStorage.candidate(uk), { region: 'RU', regionConfidence: 0.9 }, { nowMs: Date.parse('2026-10-04T12:00:00Z') });
  t.equal(assessed.eligibility, 'INELIGIBLE'); t.ok(assessed.reasons.includes('REGION_MISMATCH'));
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
