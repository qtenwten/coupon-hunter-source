'use strict';
const { requestJson, ProviderError } = require('../http-client');
function normalizeSellerCoupon(row = {}, storeNum) {
  return { code: row.code || row.coupon_code, type: 'SELLER_COUPON', lifecycleStatus: 'ACTIVE', sellerIds: [String(storeNum)], providerRecordId: row.id || row.coupon_id,
    discountAmount: Number.isFinite(Number(row.discount ?? row.discount_amount)) ? Number(row.discount ?? row.discount_amount) : null,
    minimumSpend: Number.isFinite(Number(row.min_spend ?? row.minimum_spend)) ? Number(row.min_spend ?? row.minimum_spend) : null,
    minimumSpendBasis: 'ELIGIBLE_ITEMS', currency: row.currency || null, discountCurrency: row.currency || null, expiresAt: row.expires_at || row.expiry || null };
}
function createAliGateSellerCouponsAdapter(options = {}) {
  const apiKey = options.apiKey || process.env.ALIGATE_RAPIDAPI_KEY; const stores = options.storeNums || String(process.env.ALIGATE_STORE_NUMS || '').split(',').map((row) => row.trim()).filter((row) => /^\d+$/.test(row));
  return { id: 'aligate_seller_coupons', sourceGroup: 'aligate', category: 'VERIFIED_PROVIDER', trust: 0.68, mode: 'FULL_SNAPSHOT',
    enabled: options.enabled !== false && !!apiKey && stores.length > 0, disabledReason: !apiKey ? 'ALIGATE_RAPIDAPI_KEY is not configured' : !stores.length ? 'ALIGATE_STORE_NUMS is not configured; seller coupons require explicit seller scope' : null,
    async fetch(context = {}) {
      if (!this.enabled) throw new ProviderError('AUTH_REQUIRED', this.disabledReason); const rows = [];
      for (const storeNum of stores.slice(0, 50)) {
        const url = new URL('https://aligate-aliexpress-data-api.p.rapidapi.com/api/v2/seller/coupons'); url.searchParams.set('store_num', storeNum);
        const payload = await requestJson(url.href, { headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': 'aligate-aliexpress-data-api.p.rapidapi.com' }, fetchImpl: context.fetchImpl, sleep: context.sleep, timeoutMs: context.timeoutMs, retries: context.retries });
        const coupons = payload?.coupons || payload?.item?.coupons || payload?.data?.coupons || []; for (const row of coupons) if (row.code || row.coupon_code) rows.push(normalizeSellerCoupon(row, storeNum));
      }
      return { rows, state: { lastSuccessfulSync: new Date(context.nowMs ?? Date.now()).toISOString() }, rawCount: rows.length };
    }, normalize(value) { return value; }
  };
}
module.exports = { createAliGateSellerCouponsAdapter, normalizeSellerCoupon };
