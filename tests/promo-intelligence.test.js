const { test } = require('./harness');
const { sandbox, load } = require('./helpers');

const box = load(sandbox(), 'src/promo-constants.js', 'src/storage.js', 'src/promo-intelligence.js');
const L = box.CouponHunterPromoConstants;
const S = box.CouponHunterStorage;
const I = box.CouponHunterPromoIntelligence;
const NOW = Date.parse('2026-10-04T12:00:00Z');

function promo(code, values = {}) {
  return S.candidate({ code, source: 'REMOTE_JSON', lastSeenAt: '2026-10-04T11:55:00Z', sourceClaims: [{ sourceId: values.sourceId || 'provider-a', sourceGroup: values.sourceGroup || 'provider-a', category: values.category || 'VERIFIED_PROVIDER', observedAt: '2026-10-04T11:55:00Z', trust: values.trust ?? 0.8, claimedDiscountAmount: values.discountAmount, claimedDiscountPercent: values.discountPercent, claimedMaximumDiscount: values.maximumDiscount, claimedMinimumSpend: values.minimumSpend, claimedMinimumSpendBasis: values.minimumSpendBasis || 'UNKNOWN', claimedCurrency: values.currency || null, claimedRegions: values.regions || [], claimedStartsAt: values.startsAt, claimedExpiresAt: values.expiresAt }], ...values });
}

test('duplicate promo codes merge case-insensitively and preserve provenance', (t) => {
  const rows = S.mergeCandidates(promo('save10', { sourceId: 'a', sourceGroup: 'a' }), promo('SAVE10', { sourceId: 'b', sourceGroup: 'b' }));
  t.equal(rows.length, 1); t.equal(rows[0].sourceClaims.length, 2); t.equal(new Set(rows[0].sourceClaims.map((row) => row.sourceGroup)).size, 2);
});

test('pages in one sourceGroup count as one independent confirmation', (t) => {
  const row = S.mergeCandidates(promo('GROUP10', { sourceId: 'page-a', sourceGroup: 'provider' }), promo('GROUP10', { sourceId: 'page-b', sourceGroup: 'provider' }))[0];
  const confidence = I.confidenceFor(row, NOW);
  t.equal(confidence.breakdown.independentSourceGroups, 1); t.equal(confidence.breakdown.corroboration, 0);
});

test('one official and 100 community observations count as two source groups', (t) => {
  const claims = [{ sourceId: 'official', sourceGroup: 'official', category: 'OFFICIAL_ALIEXPRESS', observedAt: '2026-10-04T11:55:00Z', trust: 0.98 }];
  for (let index = 0; index < 100; index += 1) claims.push({ sourceId: 'reddit', sourceGroup: 'reddit', category: 'COMMUNITY', observedAt: new Date(NOW - index * 1000).toISOString(), trust: 0.45 });
  const row = S.candidate({ code: 'TWOGROUPS', source: 'REMOTE_JSON', sourceClaims: claims }); const confidence = I.confidenceFor(row, NOW);
  t.equal(row.sourceClaims.length, 2); t.equal(confidence.breakdown.independentSourceGroups, 2); t.equal(confidence.breakdown.sourceTrust, 72);
});

test('conflicting minimumSpend claims are retained and diagnosed', (t) => {
  const row = S.mergeCandidates(promo('CONFLICT10', { sourceId: 'a', minimumSpend: 80 }), promo('CONFLICT10', { sourceId: 'b', minimumSpend: 89 }))[0];
  t.equal(row.sourceClaims.length, 2); t.ok(row.conflicts.some((conflict) => conflict.field === 'claimedMinimumSpend'));
});

test('expired promo is hard filtered', (t) => {
  const result = I.assessCandidate(promo('OLD10', { expiresAt: '2026-10-03T00:00:00Z' }), { currency: 'USD' }, { nowMs: NOW });
  t.equal(result.eligibility, 'INELIGIBLE'); t.ok(result.reasons.includes('EXPIRED'));
});

test('future promo is hard filtered', (t) => {
  const result = I.assessCandidate(promo('FUTURE10', { startsAt: '2026-10-05T00:00:00Z' }), {}, { nowMs: NOW });
  t.equal(result.eligibility, 'INELIGIBLE'); t.ok(result.reasons.includes('NOT_STARTED'));
});

test('known minimum spend basis is a hard filter', (t) => {
  const result = I.assessCandidate(promo('MIN100', { minimumSpend: 100, minimumSpendBasis: 'SUBTOTAL' }), { subtotal: 80 }, { nowMs: NOW });
  t.equal(result.eligibility, 'INELIGIBLE'); t.ok(result.reasons.includes('MINIMUM_SPEND'));
});

test('unknown minimum spend basis is not hard rejected', (t) => {
  const result = I.assessCandidate(promo('SOFT100', { minimumSpend: 100, minimumSpendBasis: 'UNKNOWN' }), { subtotal: 80 }, { nowMs: NOW });
  t.equal(result.eligibility, 'UNKNOWN'); t.ok(result.reasons.includes('MINIMUM_SPEND_BASIS_UNKNOWN'));
});

test('conflicted low-confidence minimum spend is not used as a hard filter', (t) => {
  const row = S.mergeCandidates(promo('FIELD80', { sourceId: 'a', sourceGroup: 'a', minimumSpend: 80, minimumSpendBasis: 'SUBTOTAL', trust: 0.8 }), promo('FIELD80', { sourceId: 'b', sourceGroup: 'b', minimumSpend: 100, minimumSpendBasis: 'SUBTOTAL', trust: 0.8 }))[0];
  const result = I.assessCandidate(row, { subtotal: 50 }, { nowMs: NOW });
  t.equal(row.fieldConfidence.claimedMinimumSpend.confidence, 50); t.ok(result.eligibility !== 'INELIGIBLE'); t.ok(result.reasons.includes('MINIMUM_SPEND_CONFLICT'));
});

test('region mismatch filters only with reliable checkout region', (t) => {
  const candidate = promo('REGION10', { regions: ['US'] });
  t.equal(I.assessCandidate(candidate, { region: 'RU', regionConfidence: 0.9 }, { nowMs: NOW }).eligibility, 'INELIGIBLE');
  t.ok(I.assessCandidate(candidate, { region: null, regionConfidence: 0 }, { nowMs: NOW }).eligibility !== 'INELIGIBLE');
});

test('currency mismatch filters while unknown candidate currency remains', (t) => {
  t.equal(I.assessCandidate(promo('USD10', { currency: 'USD', currencies: ['USD'] }), { currency: 'RUB' }, { nowMs: NOW }).eligibility, 'INELIGIBLE');
  t.ok(I.assessCandidate(promo('ANY10'), { currency: 'RUB' }, { nowMs: NOW }).eligibility !== 'INELIGIBLE');
});

test('fixed saving is calculated without FX conversion', (t) => {
  let result = I.estimateSaving(promo('FIXED10', { discountType: 'FIXED', discountAmount: 10, currency: 'USD' }), { currency: 'USD', subtotal: 100 });
  t.equal(result.estimatedSaving, 10); t.equal(result.theoreticalMaxSaving, 10);
  result = I.estimateSaving(promo('FIXEDRU', { discountType: 'FIXED', discountAmount: 500, currency: 'RUB' }), { currency: 'USD', subtotal: 100 });
  t.equal(result.estimatedSaving, null); t.equal(result.theoreticalMaxSaving, null);
});

test('percent saving and maximumDiscount are respected', (t) => {
  let result = I.estimateSaving(promo('PERCENT10', { discountType: 'PERCENT', discountPercent: 10 }), { currency: 'RUB', eligibleAmount: 1000 });
  t.equal(result.estimatedSaving, 100);
  result = I.estimateSaving(promo('CAP10', { discountType: 'PERCENT', discountPercent: 10, maximumDiscount: 60 }), { currency: 'RUB', eligibleAmount: 1000 });
  t.equal(result.estimatedSaving, 60); t.equal(result.theoreticalMaxSaving, 60);
});

test('ranking prioritizes materially larger expected saving', (t) => {
  const small = promo('SMALL10', { discountType: 'FIXED', discountAmount: 100, confidence: 100, trust: 1 });
  const large = promo('LARGE10', { discountType: 'FIXED', discountAmount: 1500, confidence: 55, trust: 0.55 });
  const plan = I.buildQueue([small, large], { currency: null, subtotal: 10000 }, { nowMs: NOW });
  t.equal(plan.queue[0].code, 'LARGE10');
});

test('local VALID_APPLIED history increases ranking priority', (t) => {
  const plain = promo('PLAIN10', { discountType: 'FIXED', discountAmount: 100 });
  const verified = promo('LOCAL10', { discountType: 'FIXED', discountAmount: 100, verified: true, verificationStatus: 'VALID_APPLIED', lastVerifiedAt: '2026-10-04T11:58:00Z', lastVerificationContext: { currency: 'RUB', itemIds: ['ITEM-A'] } });
  t.equal(I.buildQueue([plain, verified], { currency: 'RUB', itemIds: ['ITEM-A'] }, { nowMs: NOW }).queue[0].code, 'LOCAL10');
  t.equal(I.localVerificationMatches(verified, { currency: 'USD', itemIds: ['ITEM-A'] }), false);
});

test('MINIMUM_SPEND_NOT_MET does not globally kill a code', (t) => {
  const candidate = promo('RETRY10', { minimumSpend: 100, minimumSpendBasis: 'SUBTOTAL', verificationStatus: 'MINIMUM_SPEND_NOT_MET', lastVerifiedAt: '2026-10-04T11:58:00Z' });
  t.ok(I.assessCandidate(candidate, { subtotal: 150 }, { nowMs: NOW }).eligibility !== 'INELIGIBLE');
});

test('early stop skips only a known maximum that cannot beat best', (t) => {
  t.equal(I.shouldEarlyStop({ theoreticalMaxSaving: 1000 }, 1500), true);
  t.equal(I.shouldEarlyStop({ theoreticalMaxSaving: null }, 1500), false);
});

test('standard, deep and hard queue limits are enforced', (t) => {
  const rows = Array.from({ length: 80 }, (_, index) => promo(`Q${String(index).padStart(4, '0')}`, { discountType: 'FIXED', discountAmount: 100 + index }));
  t.equal(I.buildQueue(rows, {}, { mode: 'STANDARD', nowMs: NOW }).queue.length, L.DEFAULT_LIVE_ATTEMPTS);
  t.equal(I.buildQueue(rows, {}, { mode: 'DEEP', nowMs: NOW }).queue.length, L.DEEP_SCAN_LIVE_ATTEMPTS);
  t.ok(I.buildQueue(rows, {}, { mode: 'DEEP', nowMs: NOW }).queue.length <= L.HARD_LIVE_ATTEMPT_LIMIT);
});

test('BEST_KNOWN_PROVEN requires complete coverage and no unresolved contender', (t) => {
  const session = { status: 'COMPLETE', bestCode: 'BEST10', results: [{ code: 'BEST10', saving: 500, verificationStatus: 'VALID_APPLIED' }] };
  t.equal(I.bestKnownProven(session, { queueCoversAllEligible: true }), true);
  t.equal(I.bestKnownProven(session, { queueCoversAllEligible: false }), false);
  session.results.push({ code: 'MAYBE10', verificationStatus: 'UNKNOWN_ERROR', theoreticalMaxSaving: null });
  t.equal(I.bestKnownProven(session, { queueCoversAllEligible: true }), false);
});

test('library retention keeps user and verified codes ahead of expired low-confidence rows', (t) => {
  const rows = Array.from({ length: 1002 }, (_, index) => promo(`R${String(index).padStart(4, '0')}`, { expiresAt: '2026-01-01T00:00:00Z', trust: 0.1 }));
  rows.push(S.candidate({ code: 'USERKEEP', source: S.SOURCES.USER }), promo('VERIFIEDKEEP', { verified: true, verificationStatus: 'VALID_APPLIED' }));
  const retained = S.mergeCandidates(rows);
  t.equal(retained.length, 1000); t.ok(retained.some((row) => row.code === 'USERKEEP')); t.ok(retained.some((row) => row.code === 'VERIFIEDKEEP'));
});

test('2.1.2 storage migration preserves user codes, history and watchlist', (t) => {
  const legacy = { couponCandidates: [{ code: 'user10', source: 'USER', minimumSpend: 100 }, { code: 'OLD20', source: 'PRODUCT_PAGE' }], watchlist: [{ itemId: '1' }], 'history:1:A': [{ price: 10 }] };
  const migrated = S.migrateStorageSnapshot(legacy);
  t.equal(migrated.promoStorageSchemaVersion, 4); t.equal(migrated.couponCandidates.length, 2);
  t.equal(migrated.couponCandidates.find((row) => row.code === 'USER10').schemaVersion, 2);
  t.deep(migrated.watchlist, legacy.watchlist); t.deep(migrated['history:1:A'], legacy['history:1:A']);
});
