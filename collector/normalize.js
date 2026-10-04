'use strict';

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{3,31}$/;
const CATEGORIES = new Set(['OFFICIAL_ALIEXPRESS', 'VERIFIED_PROVIDER', 'COMMUNITY', 'MANUAL_CURATED', 'USER', 'PRODUCT_PAGE', 'UNKNOWN']);
const BASES = new Set(['SUBTOTAL', 'ELIGIBLE_ITEMS', 'ORDER_TOTAL', 'UNKNOWN']);
const finite = (value) => Number.isFinite(value) ? value : null;
const iso = (value, fallback = null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback;
const list = (value, max = 100) => [...new Set((Array.isArray(value) ? value : [value]).filter(Boolean).map((row) => String(row).trim()).filter(Boolean))].slice(0, max);

function normalizeCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

function safeUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch (_) { return null; }
}

function normalizeClaim(raw, adapter, observedAt) {
  const code = normalizeCode(raw?.code); if (!code) return null;
  const category = CATEGORIES.has(adapter.category) ? adapter.category : 'UNKNOWN';
  return {
    code, lifecycleStatus: String(raw.lifecycleStatus || raw.status || 'ACTIVE').toUpperCase() === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE',
    type: raw.type === 'SELLER_COUPON' ? 'SELLER_COUPON' : 'PLATFORM_PROMO_CODE',
    providerRecordId: raw.providerRecordId === undefined || raw.providerRecordId === null ? null : String(raw.providerRecordId).slice(0, 120),
    providerStore: raw.providerStore ? String(raw.providerStore).slice(0, 160) : null,
    providerBrandName: raw.providerBrandName ? String(raw.providerBrandName).slice(0, 160) : null,
    providerFirmName: raw.providerFirmName ? String(raw.providerFirmName).slice(0, 160) : null,
    providerSource: raw.providerSource ? String(raw.providerSource).slice(0, 160) : null,
    providerMerchantWebsiteUrl: safeUrl(raw.providerMerchantWebsiteUrl),
    providerRating: finite(raw.providerRating),
    title: raw.title ? String(raw.title).slice(0, 300) : null,
    discountType: ['FIXED', 'PERCENT'].includes(raw.discountType) ? raw.discountType : Number.isFinite(raw.discountAmount) ? 'FIXED' : Number.isFinite(raw.discountPercent) ? 'PERCENT' : 'UNKNOWN',
    discountAmount: finite(raw.discountAmount), discountPercent: finite(raw.discountPercent), maximumDiscount: finite(raw.maximumDiscount),
    minimumSpend: finite(raw.minimumSpend), minimumSpendBasis: BASES.has(raw.minimumSpendBasis) ? raw.minimumSpendBasis : 'UNKNOWN',
    currencies: list(raw.currencies || raw.currency, 20).map((value) => value.toUpperCase()), regions: list(raw.regions || raw.region, 50).map((value) => value.toUpperCase()),
    newUsersOnly: raw.newUsersOnly === true, campaign: raw.campaign ? String(raw.campaign).slice(0, 200) : null,
    startsAt: iso(raw.startsAt || raw.startAt), expiresAt: iso(raw.expiresAt), itemIds: list(raw.itemIds || raw.itemId), sellerIds: list(raw.sellerIds || raw.sellerId),
    sourceClaim: {
      sourceId: adapter.id, sourceGroup: adapter.sourceGroup, category, origin: 'REMOTE_FEED',
      status: String(raw.lifecycleStatus || raw.status || 'ACTIVE').toUpperCase() === 'SUSPENDED' ? 'RETRACTED' : 'ACTIVE',
      observedAt: iso(raw.observedAt, observedAt), firstObservedAt: iso(raw.firstObservedAt || raw.observedAt, observedAt), lastObservedAt: iso(raw.lastObservedAt || raw.observedAt, observedAt), observationCount: Math.max(1, Number(raw.observationCount) || 1),
      url: safeUrl(raw.url), trust: Math.max(0, Math.min(1, Number(adapter.trust) || 0)),
      claimedDiscountAmount: finite(raw.discountAmount), claimedDiscountPercent: finite(raw.discountPercent), claimedMaximumDiscount: finite(raw.maximumDiscount),
      claimedMinimumSpend: finite(raw.minimumSpend), claimedMinimumSpendBasis: BASES.has(raw.minimumSpendBasis) ? raw.minimumSpendBasis : 'UNKNOWN',
      claimedCurrency: raw.discountCurrency || raw.currency || raw.currencies?.[0] || null,
      claimedRegions: list(raw.regions || raw.region, 50).map((value) => value.toUpperCase()),
      claimedStartsAt: iso(raw.startsAt || raw.startAt), claimedExpiresAt: iso(raw.expiresAt), campaign: raw.campaign || null
    }
  };
}

module.exports = { normalizeCode, normalizeClaim, safeUrl };
