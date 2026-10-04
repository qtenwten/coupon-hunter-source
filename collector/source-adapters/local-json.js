'use strict';
const fs = require('node:fs/promises');

function createLocalJsonAdapter(options = {}) {
  return {
    id: options.id || 'manual_curated', sourceGroup: options.sourceGroup || options.id || 'manual_curated',
    category: options.category || 'MANUAL_CURATED', trust: options.trust ?? 0.8, mode: 'FULL_SNAPSHOT', enabled: options.enabled !== false,
    async fetch() { const payload = JSON.parse(await fs.readFile(options.path, 'utf8')); return Array.isArray(payload) ? payload : payload.promos || []; },
    normalize(value) { return value; }
  };
}

module.exports = { createLocalJsonAdapter };
