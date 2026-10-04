'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeClaim } = require('./normalize');
const { deduplicate } = require('./deduplicate');
const { scoreCandidate } = require('./score');
const { validateFeed } = require('./validate');
const { defaultRegistry } = require('./source-registry');
const { sanitizeError } = require('./http-client');
const { writeJsonAtomic, readJson } = require('./state-store');
const { signFeed } = require('./signature');
const { compactSourceClaims } = require('./resolve');
const PUBLIC_FEED_TARGET_BYTES = Math.floor(1.8 * 1024 * 1024);

function rowsFromFeed(feed) {
  const rows = [];
  for (const promo of feed?.promos || []) for (const sourceClaim of promo.sourceClaims || []) rows.push({ ...promo, sourceClaim, lifecycleStatus: sourceClaim.status === 'RETRACTED' ? 'SUSPENDED' : 'ACTIVE' });
  return rows;
}
function reconcileRows(previousRows, changes, adapter, fullSnapshot = false) {
  const changedCodes = new Set(changes.map((row) => row.code));
  const previousByCode = new Map(previousRows.filter((row) => row.sourceClaim?.sourceId === adapter.id && row.sourceClaim?.sourceGroup === adapter.sourceGroup).map((row) => [row.code, row]));
  const kept = previousRows.filter((row) => {
    const belongs = row.sourceClaim?.sourceId === adapter.id && row.sourceClaim?.sourceGroup === adapter.sourceGroup;
    if (!belongs) return true; if (fullSnapshot) return false; return !changedCodes.has(row.code);
  });
  const activeChanges = changes.filter((row) => row.lifecycleStatus !== 'SUSPENDED' && row.sourceClaim.status !== 'RETRACTED').map((row) => {
    const previous = previousByCode.get(row.code); if (!previous) return row;
    return { ...row, sourceClaim: compactSourceClaims([previous.sourceClaim, row.sourceClaim])[0] };
  });
  return [...kept, ...activeChanges];
}
function healthStatus(errorClass, count) { if (!errorClass) return count > 0 ? 'OK' : 'EMPTY'; if (errorClass === 'AUTH_REQUIRED') return 'AUTH_REQUIRED'; if (errorClass === 'RATE_LIMITED') return 'RATE_LIMITED'; return 'FAILED'; }
function boundPromosByBytes(candidates, maxBytes = PUBLIC_FEED_TARGET_BYTES) {
  const promos = []; let bytes = 2;
  for (const candidate of candidates) { const size = Buffer.byteLength(JSON.stringify(candidate)) + 1; if (bytes + size > maxBytes) continue; promos.push(candidate); bytes += size; }
  return { promos, bytes, omitted: candidates.length - promos.length };
}

async function buildFeedWithState(adapters = defaultRegistry(), options = {}) {
  const nowMs = options.nowMs ?? Date.now(); const generatedAt = new Date(nowMs).toISOString(); let rows = rowsFromFeed(options.previousFeed); const health = {}; const nextProviderState = { ...(options.providerState || {}) };
  let attempted = 0; let succeeded = 0; let failed = 0; let rawClaims = 0;
  for (const adapter of adapters) {
    const previousHealth = options.providerState?.[adapter.id] || {};
    if (!adapter.enabled) { rows = reconcileRows(rows, [], adapter, true); health[adapter.id] = { status: 'DISABLED', claims: 0, lastAttemptAt: previousHealth.lastAttemptAt || null, lastSuccessAt: previousHealth.lastSuccessAt || null, errorClass: null, reason: adapter.disabledReason || 'Disabled by configuration' }; continue; }
    attempted += 1; const lastAttemptAt = generatedAt;
    try {
      const result = await adapter.fetch({ ...options, nowMs, providerState: options.providerState || {} }); const rawRows = Array.isArray(result) ? result : result?.rows || []; const normalized = [];
      for (const raw of rawRows) { const claim = normalizeClaim(adapter.normalize(raw), adapter, generatedAt); if (claim) normalized.push(claim); }
      rawClaims += normalized.length; rows = reconcileRows(rows, normalized, adapter, adapter.mode === 'FULL_SNAPSHOT'); succeeded += 1;
      nextProviderState[adapter.id] = { ...previousHealth, ...(result?.state || {}), lastAttemptAt, lastSuccessAt: generatedAt };
      health[adapter.id] = { status: healthStatus(null, normalized.length), claims: normalized.filter((row) => row.lifecycleStatus !== 'SUSPENDED').length, rawClaims: normalized.length, rawCount: Number.isFinite(result?.rawCount) ? result.rawCount : rawRows.length, normalizedCount: normalized.length, ...(result?.diagnostics || {}), lastAttemptAt, lastSuccessAt: generatedAt, errorClass: null };
    } catch (error) {
      failed += 1; const safe = sanitizeError(error); nextProviderState[adapter.id] = { ...previousHealth, lastAttemptAt };
      health[adapter.id] = { status: healthStatus(safe.errorClass, 0), claims: 0, lastAttemptAt, lastSuccessAt: previousHealth.lastSuccessAt || null, errorClass: safe.errorClass, reason: safe.message };
    }
  }
  const unique = deduplicate(rows); const expiredRemoved = unique.filter((row) => row.expiresAt && Date.parse(row.expiresAt) < nowMs).length;
  const scored = unique.filter((row) => row.lifecycleStatus !== 'SUSPENDED' && (!row.expiresAt || Date.parse(row.expiresAt) >= nowMs)).map((row) => scoreCandidate(row, nowMs)).sort((a, b) => a.code.localeCompare(b.code)).slice(0, 1000);
  const bounded = boundPromosByBytes(scored); const promos = bounded.promos;
  const revision = options.revision || generatedAt.replace(/[-:.TZ]/g, '');
  const feed = validateFeed({ schemaVersion: 3, feedId: 'coupon-hunter-aliexpress', revision, mode: 'FULL_SNAPSHOT', merchant: 'aliexpress', generatedAt,
    expiresAt: new Date(nowMs + (options.validForMs || 6 * 60 * 60 * 1000)).toISOString(), promos,
    diagnostics: { sourcesAttempted: attempted, sourcesSucceeded: succeeded, sourcesFailed: failed, rawClaims, uniqueCodes: unique.length, conflicts: unique.reduce((sum, row) => sum + row.conflicts.length, 0), expiredRemoved, byteBudgetOmitted: bounded.omitted, promoBytesEstimate: bounded.bytes, feedicoTruncated: health.feedico?.feedicoTruncated === true, sourceHealth: health } });
  return { feed, providerState: nextProviderState };
}
async function buildFeed(adapters = defaultRegistry(), options = {}) { return (await buildFeedWithState(adapters, options)).feed; }

async function buildProductionFeed(options = {}) {
  const output = options.output; const statePath = options.statePath; const previousFeed = await readJson(output, null); const providerState = await readJson(statePath, {});
  const built = await buildFeedWithState(options.adapters || defaultRegistry(), { ...options, previousFeed, providerState });
  const privateKey = options.privateKey || process.env.COUPON_HUNTER_FEED_PRIVATE_KEY; const finalFeed = privateKey ? signFeed(built.feed, privateKey, options.keyId || process.env.COUPON_HUNTER_FEED_KEY_ID || 'production') : built.feed;
  validateFeed(finalFeed); await writeJsonAtomic(output, finalFeed); await writeJsonAtomic(statePath, built.providerState); return finalFeed;
}
async function main() {
  const output = process.argv[2] || path.join(__dirname, 'promo-feed.json'); const statePath = process.env.COUPON_HUNTER_PROVIDER_STATE || path.join(__dirname, '.provider-state.json');
  const feed = await buildProductionFeed({ output, statePath }); console.log(`Promo feed: ${feed.promos.length} codes -> ${output}`);
}
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { PUBLIC_FEED_TARGET_BYTES, boundPromosByBytes, rowsFromFeed, reconcileRows, buildFeedWithState, buildFeed, buildProductionFeed };
