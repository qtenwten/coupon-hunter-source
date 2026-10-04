'use strict';

function createAliExpressOpenPlatformAdapter(options = {}) {
  return {
    id: 'aliexpress_open_platform', sourceGroup: 'aliexpress_official', category: 'OFFICIAL_ALIEXPRESS', trust: 0.98,
    enabled: options.enabled === true && typeof options.apiClient === 'function',
    disabledReason: 'NO_CONFIRMED_BUYER_PROMO_ENDPOINT: documented marketing coupon APIs are seller-oriented and the legacy Affiliate API is deprecated',
    async fetch() { if (!this.enabled) throw new Error(this.disabledReason); return options.apiClient(); },
    normalize(value) { return value; }
  };
}

module.exports = { createAliExpressOpenPlatformAdapter };
