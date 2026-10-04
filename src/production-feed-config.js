(() => {
  'use strict';
  const PUBLIC_KEY_JWK = Object.freeze({ crv: 'Ed25519', x: 'G_ifdtSAuos7LGKdXjcIRjEsBZ8ZhYlRHWjaRlPUjSg', kty: 'OKP' });
  const config = Object.freeze({
    url: 'https://qsen.ru/coupon-hunter-source/promo-feed.json',
    requireSignature: true,
    publicKeyJwk: PUBLIC_KEY_JWK,
    keyId: 'feed-ed25519-2026-10-05'
  });
  globalThis.CouponHunterProductionFeedConfig = config;
  if (typeof module !== 'undefined' && module.exports) module.exports = config;
})();
