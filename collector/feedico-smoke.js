'use strict';
const path = require('node:path');
const { buildProductionFeed } = require('./build-feed');
const { defaultRegistry } = require('./source-registry');
const { writeJsonAtomic } = require('./state-store');

async function main() {
  const output = path.resolve(process.argv[2] || 'promo-feed.json');
  const diagnosticsPath = path.resolve(process.argv[3] || 'provider-diagnostics.json');
  const statePath = path.resolve(process.argv[4] || '.feedico-smoke-state.json');
  if (!process.env.FEEDICO_TOKEN) {
    const diagnostics = { provider: 'feedico', status: 'AUTH_REQUIRED', errorClass: 'AUTH_REQUIRED', rawCount: 0, aliexpressNormalizedCount: 0, pagesRequested: 0, truncated: false, message: 'FEEDICO_TOKEN GitHub Secret is not configured' };
    await writeJsonAtomic(diagnosticsPath, diagnostics); console.error('Feedico smoke: AUTH_REQUIRED (FEEDICO_TOKEN is not configured)'); process.exitCode = 1; return;
  }

  const feed = await buildProductionFeed({ output, statePath, adapters: defaultRegistry() });
  const health = feed.diagnostics?.sourceHealth?.feedico || {};
  const diagnostics = {
    provider: 'feedico', status: health.status || 'FAILED', errorClass: health.errorClass || null,
    rawCount: Number.isFinite(health.rawCount) ? health.rawCount : 0,
    aliexpressNormalizedCount: Number.isFinite(health.normalizedCount) ? health.normalizedCount : 0,
    pagesRequested: Number.isFinite(health.pagesRequested) ? health.pagesRequested : 0,
    truncated: health.feedicoTruncated === true,
    generatedAt: feed.generatedAt, revision: feed.revision,
    message: health.reason || null,
    sourceHealth: Object.fromEntries(Object.entries(feed.diagnostics?.sourceHealth || {}).map(([id, row]) => [id, { status: row.status, claims: row.claims, errorClass: row.errorClass || null }]))
  };
  await writeJsonAtomic(diagnosticsPath, diagnostics);
  console.log(`sourceHealth.feedico.status=${diagnostics.status}`);
  console.log(`rawCount=${diagnostics.rawCount}`);
  console.log(`AliExpress normalized count=${diagnostics.aliexpressNormalizedCount}`);
  console.log(`pagesRequested=${diagnostics.pagesRequested}`);
  console.log(`truncated=${diagnostics.truncated}`);
  if (!['OK', 'EMPTY'].includes(diagnostics.status)) process.exitCode = 1;
}

if (require.main === module) main().catch(async (error) => {
  const diagnosticsPath = path.resolve(process.argv[3] || 'provider-diagnostics.json');
  const diagnostics = { provider: 'feedico', status: 'FAILED', errorClass: error?.errorClass || 'FAILED', rawCount: 0, aliexpressNormalizedCount: 0, pagesRequested: 0, truncated: false, message: String(error?.message || 'Smoke test failed').slice(0, 240) };
  try { await writeJsonAtomic(diagnosticsPath, diagnostics); } catch (_) {}
  console.error(`Feedico smoke failed safely: ${diagnostics.errorClass}`); process.exitCode = 1;
});
