'use strict';
const { resolveCode } = require('./resolve');

function deduplicate(rows) {
  const map = new Map();
  for (const row of rows) { if (!map.has(row.code)) map.set(row.code, []); map.get(row.code).push(row); }
  return [...map.values()].map(resolveCode).sort((a, b) => a.code.localeCompare(b.code));
}

module.exports = { deduplicate };
