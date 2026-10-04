'use strict';

function createRedditApiAdapter(options = {}) {
  return {
    id: 'reddit_api', sourceGroup: 'reddit', category: 'COMMUNITY', trust: 0.45,
    enabled: options.enabled === true && options.appApproved === true && typeof options.apiClient === 'function',
    disabledReason: 'Requires approved OAuth Data API access and an application-specific compliance review; HTML scraping is not used',
    async fetch() { if (!this.enabled) throw new Error(this.disabledReason); return options.apiClient(); },
    normalize(value) { return value; }
  };
}

module.exports = { createRedditApiAdapter };
