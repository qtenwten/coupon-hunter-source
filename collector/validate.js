'use strict';
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{3,31}$/;

function validateFeed(feed) {
  if (feed.schemaVersion !== 3 || feed.feedId !== 'coupon-hunter-aliexpress' || feed.mode !== 'FULL_SNAPSHOT' || !feed.revision || feed.merchant !== 'aliexpress' || !Array.isArray(feed.promos)) throw new Error('Invalid feed envelope');
  if (feed.promos.length > 1000) throw new Error('Feed exceeds 1000 promos');
  for (const promo of feed.promos) {
    if (!CODE_RE.test(promo.code) || promo.schemaVersion !== 2 || !Array.isArray(promo.sourceClaims)) throw new Error(`Invalid promo: ${promo.code || 'unknown'}`);
  }
  return feed;
}

module.exports = { validateFeed };
