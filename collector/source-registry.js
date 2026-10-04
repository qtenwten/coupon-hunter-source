'use strict';
const path = require('node:path');
const { createLocalJsonAdapter } = require('./source-adapters/local-json');
const { createJsonFeedAdapter } = require('./source-adapters/json-feed');
const { createAliExpressOpenPlatformAdapter } = require('./source-adapters/aliexpress-open-platform');
const { createRedditApiAdapter } = require('./source-adapters/reddit-api');
const { createCouponApiAdapter } = require('./source-adapters/couponapi');
const { createFeedicoAdapter } = require('./source-adapters/feedico');
const { createSimplyCodesAdapter } = require('./source-adapters/simplycodes');
const { createAliGateSellerCouponsAdapter } = require('./source-adapters/aligate-seller-coupons');

function defaultRegistry() {
  return [
    createLocalJsonAdapter({ id: 'manual_curated', path: path.join(__dirname, 'fixtures', 'manual-curated.json'), enabled: true }),
    createCouponApiAdapter(),
    createFeedicoAdapter(),
    createAliGateSellerCouponsAdapter(),
    createSimplyCodesAdapter(),
    createAliExpressOpenPlatformAdapter({ enabled: false }),
    createJsonFeedAdapter({ id: 'verified_provider_a', sourceGroup: 'verified_provider_a', enabled: false, automationApproved: false }),
    createJsonFeedAdapter({ id: 'verified_provider_b', sourceGroup: 'verified_provider_b', enabled: false, automationApproved: false }),
    createRedditApiAdapter({ enabled: false, appApproved: false })
  ];
}

module.exports = { defaultRegistry };
