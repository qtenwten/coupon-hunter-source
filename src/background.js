'use strict';
importScripts('promo-constants.js', 'storage.js', 'production-feed-config.js', 'feed-signature.js', 'promo-feed.js');

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'CH_REFRESH_PROMO_FEED') return false;
  globalThis.CouponHunterPromoFeed.refreshConfigured({ force: message.force === true })
    .then((result) => sendResponse({ ok: true, cacheStatus: result.cacheStatus, count: result.feed?.promos?.length || 0, ageMs: result.ageMs }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || 'FEED_REFRESH_FAILED' }));
  return true;
});
