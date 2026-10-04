'use strict';

function createJsonFeedAdapter(options = {}) {
  return {
    id: options.id, sourceGroup: options.sourceGroup || options.id, category: options.category || 'VERIFIED_PROVIDER',
    trust: options.trust ?? 0.75, enabled: options.enabled === true && options.automationApproved === true,
    disabledReason: options.automationApproved ? 'Endpoint is not configured' : 'Automation permission/license has not been confirmed',
    async fetch(context = {}) {
      if (!this.enabled || !options.url) throw new Error(this.disabledReason);
      const response = await (context.fetchImpl || fetch)(options.url, { headers: options.headers || {}, signal: context.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json(); return Array.isArray(payload) ? payload : payload.promos || [];
    },
    normalize(value) { return value; }
  };
}

module.exports = { createJsonFeedAdapter };
