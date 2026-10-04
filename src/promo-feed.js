(() => {
  'use strict';
  if (globalThis.CouponHunterPromoFeed) return;

  const Limits = globalThis.CouponHunterPromoConstants;
  const Store = globalThis.CouponHunterStorage;
  const Signature = globalThis.CouponHunterFeedSignature;
  const BANNED_KEYS = new Set(['javascript', 'script', 'selector', 'cssselector', 'regex', 'eval', 'function', 'command', 'dynamicimport']);
  const byteLength = (value) => typeof TextEncoder === 'function' ? new TextEncoder().encode(value).length : unescape(encodeURIComponent(value)).length;

  function containsExecutableShape(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 8) return false;
    if (Array.isArray(value)) return value.some((row) => containsExecutableShape(row, depth + 1));
    return Object.entries(value).some(([key, child]) => BANNED_KEYS.has(String(key).toLowerCase()) || containsExecutableShape(child, depth + 1));
  }
  function stringsWithinLimit(value, depth = 0) {
    if (typeof value === 'string') return value.length <= Limits.MAX_STRING_LENGTH;
    if (!value || typeof value !== 'object' || depth > 8) return depth <= 8;
    if (Array.isArray(value)) return value.length <= Limits.MAX_REMOTE_FEED_ENTRIES * 5 && value.every((row) => stringsWithinLimit(row, depth + 1));
    return Object.keys(value).length <= 80 && Object.entries(value).every(([key, child]) => key.length <= 80 && stringsWithinLimit(child, depth + 1));
  }
  function validIso(value) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null; }
  function remoteClaim(claim, promo, generatedAt) { return { ...claim, origin: 'REMOTE_FEED', status: claim?.status === 'RETRACTED' || promo.lifecycleStatus === 'SUSPENDED' ? 'RETRACTED' : 'ACTIVE', observedAt: claim?.observedAt || generatedAt, lastObservedAt: claim?.lastObservedAt || claim?.observedAt || generatedAt }; }

  function validateFeed(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('FEED_INVALID_OBJECT');
    if (payload.schemaVersion !== Limits.FEED_SCHEMA_VERSION) throw new Error('FEED_SCHEMA_UNSUPPORTED');
    if (payload.feedId !== Limits.FEED_ID) throw new Error('FEED_ID_MISMATCH');
    if (!payload.revision || typeof payload.revision !== 'string') throw new Error('FEED_REVISION_MISSING');
    if (!Limits.FEED_MODES.includes(payload.mode)) throw new Error('FEED_MODE_UNSUPPORTED');
    if (payload.merchant !== 'aliexpress') throw new Error('FEED_MERCHANT_MISMATCH');
    if (!Array.isArray(payload.promos)) throw new Error('FEED_PROMOS_MISSING');
    if (!stringsWithinLimit(payload) || containsExecutableShape(payload)) throw new Error('FEED_UNSAFE_CONTENT');
    const generatedAt = validIso(payload.generatedAt); const accepted = []; let rejected = 0;
    for (const raw of payload.promos.slice(0, Limits.MAX_REMOTE_FEED_ENTRIES)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { rejected += 1; continue; }
      if ((raw.schemaVersion !== undefined && raw.schemaVersion !== Limits.PROMO_SCHEMA_VERSION) ||
        (raw.discountType !== undefined && !Limits.DISCOUNT_TYPES.includes(raw.discountType)) ||
        (raw.minimumSpendBasis !== undefined && !Limits.MINIMUM_SPEND_BASES.includes(raw.minimumSpendBasis)) ||
        (raw.lifecycleStatus !== undefined && !['ACTIVE', 'SUSPENDED'].includes(raw.lifecycleStatus)) ||
        (Array.isArray(raw.sourceClaims) && raw.sourceClaims.some((claim) => claim?.category && !Limits.SOURCE_CATEGORIES.includes(claim.category)))) { rejected += 1; continue; }
      const sourceClaims = (raw.sourceClaims?.length ? raw.sourceClaims : [{ sourceId: raw.source || Store.SOURCES.REMOTE_JSON, sourceGroup: raw.sourceGroup || raw.source || Store.SOURCES.REMOTE_JSON, category: raw.category || 'UNKNOWN', trust: Number.isFinite(raw.trust) ? raw.trust : 0.5 }]).map((claim) => remoteClaim(claim, raw, generatedAt));
      const candidate = Store.candidate({ ...raw, sourceClaims, source: Store.SOURCES.REMOTE_JSON });
      if (!candidate) { rejected += 1; continue; } accepted.push(candidate);
    }
    rejected += Math.max(0, payload.promos.length - Limits.MAX_REMOTE_FEED_ENTRIES);
    return { schemaVersion: Limits.FEED_SCHEMA_VERSION, feedId: Limits.FEED_ID, revision: payload.revision, mode: payload.mode,
      merchant: 'aliexpress', generatedAt, expiresAt: validIso(payload.expiresAt), promos: Store.mergeCandidates(accepted),
      retractions: (Array.isArray(payload.retractions) ? payload.retractions : []).slice(-(Limits.MAX_REMOTE_RETRACTIONS || 200)),
      signature: payload.signature || null,
      diagnostics: { ...(payload.diagnostics && typeof payload.diagnostics === 'object' ? payload.diagnostics : {}), accepted: accepted.length, rejected } };
  }

  function parseFeedText(text) {
    if (typeof text !== 'string' || byteLength(text) > Limits.MAX_FEED_BYTES) throw new Error('FEED_RESPONSE_TOO_LARGE');
    let payload; try { payload = JSON.parse(text); } catch (_) { throw new Error('FEED_MALFORMED_JSON'); } return validateFeed(payload);
  }

  function claimIdentity(code, claim) { return `${code}\u0000${claim.sourceGroup}\u0000${claim.sourceId}`; }
  function retractionRecord(code, claim, at, reason) { return { code, sourceId: claim.sourceId, sourceGroup: claim.sourceGroup, status: 'RETRACTED', retractedAt: at, reason }; }
  function reconcileFeeds(previous, incoming) {
    if (!previous || previous.feedId !== incoming.feedId) return { ...incoming, mode: 'FULL_SNAPSHOT' };
    const at = incoming.generatedAt || new Date().toISOString(); const retractions = [...(previous.retractions || []), ...(incoming.retractions || [])];
    if (incoming.mode === 'FULL_SNAPSHOT') {
      const active = new Set(incoming.promos.flatMap((promo) => Store.activeClaims(promo.sourceClaims).map((claim) => claimIdentity(promo.code, claim))));
      for (const promo of previous.promos || []) for (const claim of Store.activeClaims(promo.sourceClaims)) if (!active.has(claimIdentity(promo.code, claim))) retractions.push(retractionRecord(promo.code, claim, at, 'MISSING_FROM_FULL_SNAPSHOT'));
      return { ...incoming, retractions: retractions.slice(-(Limits.MAX_REMOTE_RETRACTIONS || 200)) };
    }
    const map = new Map((previous.promos || []).map((promo) => [promo.code, promo]));
    for (const delta of incoming.promos) {
      const merged = map.has(delta.code) ? Store.mergeCandidates(map.get(delta.code), delta)[0] : delta;
      if (merged) {
        for (const claim of merged.sourceClaims.filter((row) => row.status === 'RETRACTED')) retractions.push(retractionRecord(delta.code, claim, at, 'INCREMENTAL_SUSPENDED'));
        if (Store.activeClaims(merged.sourceClaims).length) map.set(delta.code, merged); else map.delete(delta.code);
      }
    }
    return { ...incoming, mode: 'FULL_SNAPSHOT', promos: Store.mergeCandidates([...map.values()]), retractions: retractions.slice(-(Limits.MAX_REMOTE_RETRACTIONS || 200)) };
  }

  function validateFeedUrl(value) {
    try { const url = new URL(value); if (!['https:', 'chrome-extension:'].includes(url.protocol)) throw new Error('FEED_URL_PROTOCOL'); return url.href; }
    catch (error) { throw new Error(error.message === 'FEED_URL_PROTOCOL' ? error.message : 'FEED_URL_INVALID'); }
  }
  async function readBoundedResponse(response) {
    if (!response.body?.getReader) { const text = await response.text(); if (byteLength(text) > Limits.MAX_FEED_BYTES) throw new Error('FEED_RESPONSE_TOO_LARGE'); return text; }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let size = 0; let text = '';
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > Limits.MAX_FEED_BYTES) { await reader.cancel(); throw new Error('FEED_RESPONSE_TOO_LARGE'); } text += decoder.decode(value, { stream: true }); }
    return text + decoder.decode();
  }

  async function fetchFeed(url, { fetchImpl = fetch, timeoutMs = Limits.FEED_TIMEOUT_MS, requireSignature = false, publicKeyJwk = null } = {}) {
    const safeUrl = validateFeedUrl(url); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(safeUrl, { method: 'GET', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal });
      if (!response?.ok) throw new Error(`FEED_HTTP_${response?.status || 0}`);
      const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase(); if (!/(?:application|text)\/(?:[a-z0-9.+-]*\+)?json\b/.test(contentType)) throw new Error('FEED_CONTENT_TYPE');
      const declared = Number(response.headers?.get?.('content-length')); if (Number.isFinite(declared) && declared > Limits.MAX_FEED_BYTES) throw new Error('FEED_RESPONSE_TOO_LARGE');
      const text = await readBoundedResponse(response); let raw; try { raw = JSON.parse(text); } catch (_) { throw new Error('FEED_MALFORMED_JSON'); }
      if (requireSignature && !(await Signature?.verifyEnvelope(raw, publicKeyJwk))) throw new Error('FEED_SIGNATURE_INVALID');
      return validateFeed(raw);
    } finally { clearTimeout(timer); }
  }

  function cacheAge(cache, nowMs = Date.now()) { return cache?.promoFeedFetchedAt ? Math.max(0, nowMs - Date.parse(cache.promoFeedFetchedAt)) : Infinity; }
  function cacheIsFresh(cache, nowMs = Date.now()) { return !!cache?.promoFeed && !(cache.promoFeedExpiresAt && Date.parse(cache.promoFeedExpiresAt) <= nowMs) && cacheAge(cache, nowMs) <= Limits.FEED_TTL_MS; }
  async function cacheState(storage = chrome.storage.local, nowMs = Date.now()) {
    const state = await storage.get(['promoFeed', 'promoFeedFetchedAt', 'promoFeedGeneratedAt', 'promoFeedExpiresAt', 'promoFeedVersion', 'promoFeedRevision']); return { ...state, ageMs: cacheAge(state, nowMs), fresh: cacheIsFresh(state, nowMs) };
  }
  async function refresh(url, options = {}) {
    const storage = options.storage || chrome.storage.local; const nowMs = options.nowMs ?? Date.now(); const cached = await cacheState(storage, nowMs);
    if (!options.force && cached.fresh) return { feed: cached.promoFeed, cacheStatus: 'FRESH_CACHE', ageMs: cached.ageMs };
    try {
      const incoming = await fetchFeed(url, options); const feed = reconcileFeeds(cached.promoFeed, incoming); const fetchedAt = new Date(nowMs).toISOString();
      await storage.set({ promoFeed: feed, promoFeedFetchedAt: fetchedAt, promoFeedGeneratedAt: feed.generatedAt, promoFeedExpiresAt: feed.expiresAt, promoFeedVersion: feed.schemaVersion, promoFeedRevision: feed.revision });
      if (Store?.enforceStorageBudget) await Store.enforceStorageBudget(storage); return { feed, cacheStatus: 'REFRESHED', ageMs: 0 };
    } catch (error) {
      if (cached.promoFeed && cached.ageMs <= Limits.MAX_STALE_FEED_MS && (!cached.promoFeed.expiresAt || Date.parse(cached.promoFeed.expiresAt) > nowMs)) return { feed: cached.promoFeed, cacheStatus: 'STALE_CACHE', ageMs: cached.ageMs, error: error.message }; throw error;
    }
  }
  async function configuredSource(storage = chrome.storage.local) {
    const { promoFeedConfig = null } = await storage.get('promoFeedConfig');
    if (promoFeedConfig?.url) return { url: validateFeedUrl(promoFeedConfig.url), requireSignature: promoFeedConfig.requireSignature !== false, publicKeyJwk: promoFeedConfig.publicKeyJwk || null };
    if (promoFeedConfig?.devMode && promoFeedConfig.localFixturePath && globalThis.chrome?.runtime?.getURL) return { url: chrome.runtime.getURL(promoFeedConfig.localFixturePath), requireSignature: false, publicKeyJwk: null };
    return null;
  }
  async function configuredUrl(storage = chrome.storage.local) { return (await configuredSource(storage))?.url || null; }
  async function refreshConfigured(options = {}) {
    const storage = options.storage || chrome.storage.local; const source = await configuredSource(storage); if (!source) return { feed: null, cacheStatus: 'NOT_CONFIGURED', ageMs: Infinity };
    return refresh(source.url, { ...source, ...options, storage });
  }

  globalThis.CouponHunterPromoFeed = { validateFeed, parseFeedText, reconcileFeeds, validateFeedUrl, readBoundedResponse, fetchFeed, cacheAge, cacheIsFresh, cacheState, refresh, configuredSource, configuredUrl, refreshConfigured };
})();
