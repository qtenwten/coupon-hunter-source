'use strict';
function createSimplyCodesAdapter() {
  return { id: 'simplycodes', sourceGroup: 'simplycodes', category: 'VERIFIED_PROVIDER', trust: 0.78, enabled: false,
    disabledReason: 'REQUIRES_PROVIDER_ACCESS: public claims mention API/MCP, but no public developer endpoint/credential issuance contract was confirmed; HTML scraping is prohibited',
    async fetch() { return []; }, normalize(value) { return value; } };
}
module.exports = { createSimplyCodesAdapter };
