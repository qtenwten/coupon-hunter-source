'use strict';

const CLAIM_FIELDS = ['claimedDiscountAmount', 'claimedDiscountPercent', 'claimedMaximumDiscount', 'claimedMinimumSpend', 'claimedMinimumSpendBasis', 'claimedCurrency', 'claimedRegions', 'monetaryInterpretation', 'monetaryAmbiguityReason', 'claimedStartsAt', 'claimedExpiresAt', 'campaign'];
const valueKey = (value) => typeof value === 'object' ? JSON.stringify(value) : String(value);
const claimKey = (claim) => `${claim.sourceGroup}\u0000${claim.sourceId}`;
const snapshot = (claim) => Object.fromEntries(CLAIM_FIELDS.map((field) => [field, claim[field]]));

function mergeClaim(previous, next, maxHistory = 8) {
  const latest = Date.parse(next.lastObservedAt || next.observedAt) >= Date.parse(previous.lastObservedAt || previous.observedAt) ? next : previous;
  const older = latest === next ? previous : next; const history = [...(previous.changeHistory || []), ...(next.changeHistory || [])];
  if (JSON.stringify(snapshot(previous)) !== JSON.stringify(snapshot(next))) history.push({ changedAt: latest.lastObservedAt || latest.observedAt, previous: snapshot(older) });
  return { ...latest,
    firstObservedAt: [previous.firstObservedAt || previous.observedAt, next.firstObservedAt || next.observedAt].sort()[0],
    lastObservedAt: [previous.lastObservedAt || previous.observedAt, next.lastObservedAt || next.observedAt].sort().at(-1),
    observedAt: [previous.lastObservedAt || previous.observedAt, next.lastObservedAt || next.observedAt].sort().at(-1),
    observationCount: (previous.observationCount || 1) + (next.observationCount || 1), changeHistory: history.slice(-maxHistory) };
}

function compactSourceClaims(claims, maxClaims = 32) {
  const map = new Map();
  for (const claim of claims) { const key = claimKey(claim); map.set(key, map.has(key) ? mergeClaim(map.get(key), claim) : { ...claim, changeHistory: (claim.changeHistory || []).slice(-8) }); }
  return [...map.values()].sort((a, b) => a.sourceGroup.localeCompare(b.sourceGroup) || a.sourceId.localeCompare(b.sourceId)).slice(0, maxClaims);
}
function activeClaims(claims) { return claims.filter((claim) => claim.status !== 'RETRACTED'); }
function groupClaims(claims) {
  const groups = new Map(); for (const claim of activeClaims(claims)) { if (!groups.has(claim.sourceGroup)) groups.set(claim.sourceGroup, []); groups.get(claim.sourceGroup).push(claim); } return groups;
}
function distinct(values) { return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== '').map(valueKey))]; }
function best(claims, field) { return activeClaims(claims).filter((claim) => claim[field] !== null && claim[field] !== undefined).sort((a, b) => b.trust - a.trust || b.observedAt.localeCompare(a.observedAt) || a.sourceId.localeCompare(b.sourceId))[0]?.[field] ?? null; }
function fieldResolution(claims, field) {
  const groups = [];
  for (const [sourceGroup, rows] of groupClaims(claims)) {
    const values = rows.filter((claim) => claim[field] !== null && claim[field] !== undefined && claim[field] !== ''); if (!values.length) continue;
    const selected = values.sort((a, b) => b.trust - a.trust || b.observedAt.localeCompare(a.observedAt))[0]; groups.push({ sourceGroup, value: selected[field], trust: values.reduce((sum, claim) => sum + claim.trust, 0) / values.length });
  }
  if (!groups.length) return { confidence: 0, conflicted: false, independentGroups: 0 };
  const selected = groups.slice().sort((a, b) => b.trust - a.trust)[0]; const total = groups.reduce((sum, row) => sum + row.trust, 0); const support = groups.filter((row) => valueKey(row.value) === valueKey(selected.value)).reduce((sum, row) => sum + row.trust, 0);
  return { confidence: Math.round(support / total * 100), conflicted: new Set(groups.map((row) => valueKey(row.value))).size > 1, independentGroups: groups.length };
}

function resolveCode(rows) {
  const code = rows[0].code; const claims = compactSourceClaims(rows.map((row) => row.sourceClaim)); const active = activeClaims(claims); const conflicts = []; const fieldConfidence = {};
  for (const field of ['claimedDiscountAmount', 'claimedDiscountPercent', 'claimedMaximumDiscount', 'claimedMinimumSpend', 'claimedMinimumSpendBasis', 'claimedCurrency', 'claimedRegions', 'claimedStartsAt', 'claimedExpiresAt']) {
    const values = distinct(active.map((claim) => claim[field])); if (values.length > 1) conflicts.push({ field, values: values.slice(0, 12) }); fieldConfidence[field] = fieldResolution(active, field);
  }
  const amount = best(active, 'claimedDiscountAmount'); const percent = best(active, 'claimedDiscountPercent'); const maximum = best(active, 'claimedMaximumDiscount');
  const currencies = [...new Set(rows.flatMap((row) => row.currencies))].sort(); const regions = [...new Set(rows.flatMap((row) => row.regions))].sort();
  const hasResolvedMonetaryTerms = amount !== null || percent !== null || best(active, 'claimedMinimumSpend') !== null;
  const ambiguityReasons = [...new Set(active.filter((claim) => claim.monetaryInterpretation === 'AMBIGUOUS').map((claim) => claim.monetaryAmbiguityReason).filter(Boolean))].sort();
  const monetaryInterpretation = hasResolvedMonetaryTerms ? 'PARSED' : ambiguityReasons.length ? 'AMBIGUOUS' : 'UNKNOWN';
  const audienceValues = rows.map((row) => row.newUsersOnly).filter((value) => typeof value === 'boolean');
  const newUsersOnly = audienceValues.includes(true) ? true : audienceValues.length && audienceValues.every((value) => value === false) ? false : null;
  const observations = claims.map((claim) => claim.firstObservedAt || claim.observedAt).sort(); const activeObservations = active.map((claim) => claim.lastObservedAt || claim.observedAt).sort();
  return { schemaVersion: 2, code, title: rows.map((row) => row.title).filter(Boolean).sort()[0] || null, lifecycleStatus: active.length ? 'ACTIVE' : 'SUSPENDED', type: rows.some((row) => row.type === 'SELLER_COUPON') ? 'SELLER_COUPON' : 'PLATFORM_PROMO_CODE',
    discountType: amount !== null ? 'FIXED' : percent !== null ? 'PERCENT' : 'UNKNOWN', discountAmount: amount, discountPercent: percent, maximumDiscount: maximum,
    minimumSpend: best(active, 'claimedMinimumSpend'), minimumSpendBasis: best(active, 'claimedMinimumSpendBasis') || 'UNKNOWN', discountCurrency: best(active, 'claimedCurrency'), currencies, regions,
    monetaryInterpretation, monetaryAmbiguityReasons: ambiguityReasons,
    newUsersOnly, campaign: rows.map((row) => row.campaign).filter(Boolean).sort()[0] || null,
    startsAt: best(active, 'claimedStartsAt'), expiresAt: best(active, 'claimedExpiresAt'), itemIds: [...new Set(rows.flatMap((row) => row.itemIds))].sort(), sellerIds: [...new Set(rows.flatMap((row) => row.sellerIds))].sort(),
    providerMetadata: rows.map((row) => ({ sourceId: row.sourceClaim.sourceId, recordId: row.providerRecordId, store: row.providerStore, brandName: row.providerBrandName, firmName: row.providerFirmName, source: row.providerSource, rating: row.providerRating, merchantWebsiteUrl: row.providerMerchantWebsiteUrl })).filter((row) => row.recordId || row.store || row.brandName || row.firmName || row.source || row.rating !== null || row.merchantWebsiteUrl).slice(0, 12),
    sourceClaims: claims, conflicts, fieldConfidence, independentSourceGroups: groupClaims(active).size, firstSeenAt: observations[0], lastSeenAt: activeObservations.at(-1) || observations.at(-1) };
}

module.exports = { resolveCode, compactSourceClaims, activeClaims, groupClaims, fieldResolution };
