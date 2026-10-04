(() => {
  'use strict';
  const PUBLIC_KEY_JWK = Object.freeze({ crv: 'Ed25519', x: 'jBRSI-FTT51OwIpTN-6DI5kInmvhnoolJUdjcLn8_ac', kty: 'OKP' });
  const config = Object.freeze({
    url: 'https://qtenwten.github.io/coupon-hunter-source/promo-feed.json',
    requireSignature: true,
    publicKeyJwk: PUBLIC_KEY_JWK,
    keyId: 'feed-ed25519-2026-10-04'
  });
  globalThis.CouponHunterProductionFeedConfig = config;
  if (typeof module !== 'undefined' && module.exports) module.exports = config;
})();
