(() => {
  'use strict';
  if (globalThis.CouponHunterStorage) return;

  const Limits = globalThis.CouponHunterPromoConstants || {
    PROMO_SCHEMA_VERSION: 2, STORAGE_SCHEMA_VERSION: 4, MAX_LIBRARY_CANDIDATES: 1000,
    MAX_REMOTE_FEED_ENTRIES: 1000, MAX_SOURCE_CLAIMS_PER_PROMO: 32, MAX_CLAIM_CHANGE_HISTORY: 8,
    STORAGE_SOFT_BUDGET_BYTES: 4 * 1024 * 1024,
    SOURCE_CATEGORIES: ['OFFICIAL_ALIEXPRESS', 'VERIFIED_PROVIDER', 'COMMUNITY', 'MANUAL_CURATED', 'USER', 'PRODUCT_PAGE', 'UNKNOWN'],
    DISCOUNT_TYPES: ['FIXED', 'PERCENT', 'UNKNOWN'], MINIMUM_SPEND_BASES: ['SUBTOTAL', 'ELIGIBLE_ITEMS', 'ORDER_TOTAL', 'UNKNOWN']
  };
  const SOURCES = Object.freeze({ USER: 'USER', PRODUCT_PAGE: 'PRODUCT_PAGE', SESSION_PAGE: 'SESSION_PAGE', KNOWN_LIST: 'KNOWN_LIST', REMOTE_JSON: 'REMOTE_JSON' });
  const SOURCE_CATEGORY_BY_LEGACY = Object.freeze({ USER: 'USER', PRODUCT_PAGE: 'PRODUCT_PAGE', SESSION_PAGE: 'PRODUCT_PAGE', KNOWN_LIST: 'MANUAL_CURATED', REMOTE_JSON: 'UNKNOWN' });
  const LOCAL_CATEGORIES = new Set(['USER', 'PRODUCT_PAGE', 'MANUAL_CURATED']);
  const LOCAL_SOURCE_IDS = new Set([SOURCES.USER, SOURCES.PRODUCT_PAGE, SOURCES.SESSION_PAGE, SOURCES.KNOWN_LIST]);
  const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{3,31}$/;
  const CLAIM_FIELDS = ['claimedDiscountAmount', 'claimedDiscountPercent', 'claimedMaximumDiscount', 'claimedMinimumSpend', 'claimedMinimumSpendBasis', 'claimedCurrency', 'claimedRegions', 'monetaryInterpretation', 'monetaryAmbiguityReason', 'claimedStartsAt', 'claimedExpiresAt', 'campaign'];
  const now = () => new Date().toISOString();
  const finite = (value) => Number.isFinite(value) ? value : null;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const uniqueStrings = (values, max = 100) => [...new Set((Array.isArray(values) ? values : [values]).flat().filter((value) => value !== null && value !== undefined && String(value).trim()).map((value) => String(value).trim()).slice(0, max))];
  const safeDate = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  const triState = (value) => value === true ? true : value === false ? false : null;
  const monetaryInterpretation = (value) => ['PARSED', 'AMBIGUOUS', 'UNKNOWN'].includes(value) ? value : 'UNKNOWN';
  const safeUrl = (value) => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href.slice(0, 500) : null; } catch (_) { return null; } };
  const estimateBytes = (value) => { try { const text = JSON.stringify(value); return typeof TextEncoder === 'function' ? new TextEncoder().encode(text).length : unescape(encodeURIComponent(text)).length; } catch (_) { return 0; } };

  function normalizeCode(value) {
    const code = String(value || '').trim().toUpperCase();
    return CODE_RE.test(code) ? code : null;
  }

  function sourceClaim(input = {}, fallback = {}) {
    const sourceId = String(input.sourceId || fallback.sourceId || fallback.source || SOURCES.REMOTE_JSON).trim().slice(0, 120);
    if (!sourceId) return null;
    const categoryValue = String(input.category || fallback.category || SOURCE_CATEGORY_BY_LEGACY[fallback.source] || 'UNKNOWN').toUpperCase();
    const observedAt = safeDate(input.lastObservedAt || input.observedAt || fallback.observedAt || fallback.lastSeenAt || fallback.addedAt) || now();
    return {
      sourceId,
      sourceGroup: String(input.sourceGroup || fallback.sourceGroup || sourceId).trim().slice(0, 120),
      category: Limits.SOURCE_CATEGORIES.includes(categoryValue) ? categoryValue : 'UNKNOWN',
      status: input.status === 'RETRACTED' ? 'RETRACTED' : 'ACTIVE',
      origin: input.origin === 'REMOTE_FEED' ? 'REMOTE_FEED' : input.origin === 'LOCAL' ? 'LOCAL' : fallback.source === SOURCES.REMOTE_JSON ? 'REMOTE_FEED' : LOCAL_CATEGORIES.has(categoryValue) || LOCAL_SOURCE_IDS.has(sourceId) ? 'LOCAL' : 'REMOTE_FEED',
      observedAt,
      firstObservedAt: safeDate(input.firstObservedAt) || observedAt,
      lastObservedAt: safeDate(input.lastObservedAt) || observedAt,
      observationCount: Math.max(1, Math.floor(Number(input.observationCount) || 1)),
      url: safeUrl(input.url || fallback.url),
      trust: clamp(Number.isFinite(input.trust) ? input.trust : (Number.isFinite(fallback.trust) ? fallback.trust : 0.5), 0, 1),
      claimedDiscountAmount: finite(input.claimedDiscountAmount ?? fallback.discountAmount),
      claimedDiscountPercent: finite(input.claimedDiscountPercent ?? fallback.discountPercent),
      claimedMaximumDiscount: finite(input.claimedMaximumDiscount ?? fallback.maximumDiscount),
      claimedMinimumSpend: finite(input.claimedMinimumSpend ?? fallback.minimumSpend),
      claimedMinimumSpendBasis: Limits.MINIMUM_SPEND_BASES.includes(input.claimedMinimumSpendBasis || fallback.minimumSpendBasis) ? (input.claimedMinimumSpendBasis || fallback.minimumSpendBasis) : 'UNKNOWN',
      claimedCurrency: input.claimedCurrency || fallback.discountCurrency || fallback.currency || null,
      claimedRegions: uniqueStrings(input.claimedRegions || fallback.regions || fallback.region, 50),
      monetaryInterpretation: monetaryInterpretation(input.monetaryInterpretation || fallback.monetaryInterpretation),
      monetaryAmbiguityReason: [input.monetaryAmbiguityReason, fallback.monetaryAmbiguityReason, fallback.monetaryAmbiguityReasons?.[0]].find((value) => typeof value === 'string' && value.trim())?.slice(0, 120) || null,
      claimedStartsAt: safeDate(input.claimedStartsAt || fallback.startsAt || fallback.startAt),
      claimedExpiresAt: safeDate(input.claimedExpiresAt || fallback.expiresAt),
      campaign: input.campaign || fallback.campaign || null,
      changeHistory: (Array.isArray(input.changeHistory) ? input.changeHistory : []).slice(-(Limits.MAX_CLAIM_CHANGE_HISTORY || 8))
    };
  }

  function claimKey(claim) { return `${claim.sourceGroup}\u0000${claim.sourceId}`; }
  function materialSnapshot(claim) { return Object.fromEntries(CLAIM_FIELDS.map((field) => [field, claim[field]])); }
  function materialKey(claim) { return JSON.stringify(materialSnapshot(claim)); }
  function isLocalClaim(claim) { if (claim?.origin === 'REMOTE_FEED') return false; return claim?.origin === 'LOCAL' || LOCAL_CATEGORIES.has(claim?.category) || LOCAL_SOURCE_IDS.has(claim?.sourceId); }

  function mergeClaim(previous, incoming) {
    const previousTime = Date.parse(previous.lastObservedAt || previous.observedAt || 0);
    const incomingTime = Date.parse(incoming.lastObservedAt || incoming.observedAt || 0);
    const latest = incomingTime >= previousTime ? incoming : previous; const earlier = latest === incoming ? previous : incoming;
    const history = [...(previous.changeHistory || []), ...(incoming.changeHistory || [])];
    if (materialKey(previous) !== materialKey(incoming)) history.push({ changedAt: latest.lastObservedAt, previous: materialSnapshot(earlier) });
    return { ...latest,
      firstObservedAt: [previous.firstObservedAt, incoming.firstObservedAt].filter(Boolean).sort()[0] || latest.observedAt,
      lastObservedAt: [previous.lastObservedAt, incoming.lastObservedAt].filter(Boolean).sort().at(-1) || latest.observedAt,
      observedAt: [previous.lastObservedAt, incoming.lastObservedAt].filter(Boolean).sort().at(-1) || latest.observedAt,
      observationCount: (previous.observationCount || 1) + (incoming.observationCount || 1),
      changeHistory: history.slice(-(Limits.MAX_CLAIM_CHANGE_HISTORY || 8))
    };
  }

  function compactClaims(rawClaims = [], fallback = {}) {
    const map = new Map();
    for (const raw of rawClaims) {
      const claim = sourceClaim(raw, fallback); if (!claim) continue;
      const key = claimKey(claim); map.set(key, map.has(key) ? mergeClaim(map.get(key), claim) : claim);
    }
    return [...map.values()].sort((a, b) => Number(isLocalClaim(b)) - Number(isLocalClaim(a)) || Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE') || b.trust - a.trust || Date.parse(b.lastObservedAt) - Date.parse(a.lastObservedAt)).slice(0, Limits.MAX_SOURCE_CLAIMS_PER_PROMO || 32);
  }

  function normalizeClaims(input = {}) {
    const provided = Array.isArray(input.sourceClaims) ? input.sourceClaims : [];
    if (provided.length) return compactClaims(provided, input);
    const legacySources = uniqueStrings([...(Array.isArray(input.sources) ? input.sources : []), input.source].filter(Boolean));
    return compactClaims(legacySources.map((source) => sourceClaim({}, { ...input, source, sourceId: source, category: SOURCE_CATEGORY_BY_LEGACY[source] })).filter(Boolean), input);
  }

  function activeClaims(claims = []) { return claims.filter((claim) => claim.status !== 'RETRACTED'); }
  function groupClaims(claims = []) {
    const groups = new Map();
    for (const claim of activeClaims(claims)) { if (!groups.has(claim.sourceGroup)) groups.set(claim.sourceGroup, []); groups.get(claim.sourceGroup).push(claim); }
    return groups;
  }
  function sourceGroupTrust(claims = []) {
    const values = [...groupClaims(claims).values()].map((rows) => rows.reduce((sum, row) => sum + row.trust, 0) / rows.length);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0.25;
  }
  function bestClaimValue(claims, field) {
    return activeClaims(claims).filter((claim) => claim[field] !== null && claim[field] !== undefined && claim[field] !== '').sort((a, b) => b.trust - a.trust || Date.parse(b.lastObservedAt || b.observedAt) - Date.parse(a.lastObservedAt || a.observedAt) || a.sourceId.localeCompare(b.sourceId))[0]?.[field] ?? null;
  }
  function valueKey(value) { return typeof value === 'object' ? JSON.stringify(value) : String(value); }

  function fieldResolution(claims, field, fallbackValue = null) {
    const byGroup = [];
    for (const [sourceGroup, rows] of groupClaims(claims)) {
      const eligible = rows.filter((row) => row[field] !== null && row[field] !== undefined && row[field] !== ''); if (!eligible.length) continue;
      const best = eligible.sort((a, b) => b.trust - a.trust || Date.parse(b.lastObservedAt) - Date.parse(a.lastObservedAt))[0];
      byGroup.push({ sourceGroup, value: best[field], trust: eligible.reduce((sum, row) => sum + row.trust, 0) / eligible.length });
    }
    if (!byGroup.length) return { value: fallbackValue, confidence: fallbackValue === null || fallbackValue === undefined ? 0 : 50, conflicted: false, independentGroups: 0 };
    const selected = byGroup.slice().sort((a, b) => b.trust - a.trust || a.sourceGroup.localeCompare(b.sourceGroup))[0];
    const total = byGroup.reduce((sum, row) => sum + row.trust, 0) || byGroup.length;
    const support = byGroup.filter((row) => valueKey(row.value) === valueKey(selected.value)).reduce((sum, row) => sum + row.trust, 0);
    return { value: selected.value, confidence: clamp(Math.round(support / total * 100), 0, 100), conflicted: new Set(byGroup.map((row) => valueKey(row.value))).size > 1, independentGroups: byGroup.length };
  }

  function resolveClaims(base, allClaims) {
    const claims = activeClaims(allClaims); const conflicts = []; const fieldConfidence = {};
    const fields = ['claimedDiscountAmount', 'claimedDiscountPercent', 'claimedMaximumDiscount', 'claimedMinimumSpend', 'claimedMinimumSpendBasis', 'claimedCurrency', 'claimedRegions', 'claimedStartsAt', 'claimedExpiresAt'];
    for (const field of fields) {
      const resolution = fieldResolution(claims, field, null); fieldConfidence[field] = { confidence: resolution.confidence, conflicted: resolution.conflicted, independentGroups: resolution.independentGroups };
      const values = [...new Set(claims.map((claim) => claim[field]).filter((value) => value !== null && value !== undefined && value !== '').map(valueKey))];
      if (values.length > 1) conflicts.push({ field, values: values.slice(0, 12) });
    }
    const discountAmount = finite(bestClaimValue(claims, 'claimedDiscountAmount') ?? base.discountAmount);
    const discountPercent = finite(bestClaimValue(claims, 'claimedDiscountPercent') ?? base.discountPercent);
    const maximumDiscount = finite(bestClaimValue(claims, 'claimedMaximumDiscount') ?? base.maximumDiscount);
    const minimumSpend = finite(bestClaimValue(claims, 'claimedMinimumSpend') ?? base.minimumSpend);
    const discountType = Limits.DISCOUNT_TYPES.includes(base.discountType) ? base.discountType : Number.isFinite(discountAmount) ? 'FIXED' : Number.isFinite(discountPercent) ? 'PERCENT' : 'UNKNOWN';
    const regions = uniqueStrings([...(base.regions || []), base.region, ...claims.flatMap((claim) => claim.claimedRegions || [])], 100);
    const currencies = uniqueStrings([...(base.currencies || []), base.currency, ...claims.map((claim) => claim.claimedCurrency)], 20).map((value) => value.toUpperCase());
    const independentGroups = groupClaims(claims).size; const trust = sourceGroupTrust(claims);
    const confidence = clamp(Math.round(trust * 70 + Math.min(independentGroups, 3) * 10 - conflicts.length * 8), 0, 100);
    const startsAt = bestClaimValue(claims, 'claimedStartsAt') || safeDate(base.startsAt || base.startAt);
    const expiresAt = bestClaimValue(claims, 'claimedExpiresAt') || safeDate(base.expiresAt);
    const discountCurrency = bestClaimValue(claims, 'claimedCurrency') || base.discountCurrency || base.currency || null;
    return { discountType, discountAmount, discountPercent, maximumDiscount, minimumSpend,
      minimumSpendBasis: bestClaimValue(claims, 'claimedMinimumSpendBasis') || base.minimumSpendBasis || 'UNKNOWN',
      discountCurrency, regions, currencies, startsAt, expiresAt, resolvedMinimumSpend: minimumSpend,
      resolvedDiscount: Number.isFinite(discountAmount) ? { type: 'FIXED', amount: discountAmount, currency: discountCurrency } : Number.isFinite(discountPercent) ? { type: 'PERCENT', percent: discountPercent, maximumDiscount } : null,
      resolvedValidity: { startsAt, expiresAt }, resolvedRegion: regions, conflicts, fieldConfidence, independentSourceGroups: independentGroups, sourceGroupTrust: trust, confidence };
  }

  function candidate(input = {}) {
    const code = normalizeCode(input.code); if (!code) return null;
    const claims = normalizeClaims(input); const resolved = resolveClaims(input, claims); const active = activeClaims(claims);
    const sourceIds = uniqueStrings([...active.map((claim) => claim.sourceId), ...(input.sources || []), input.source].filter(Boolean));
    const observations = claims.map((claim) => claim.firstObservedAt || claim.observedAt).filter(Boolean).sort();
    const activeObservations = active.map((claim) => claim.lastObservedAt || claim.observedAt).filter(Boolean).sort();
    const firstSeenAt = safeDate(input.firstSeenAt || input.addedAt) || observations[0] || now();
    const lastSeenAt = activeObservations.at(-1) || safeDate(input.lastSeenAt) || firstSeenAt;
    const providerMetadata = (Array.isArray(input.providerMetadata) ? input.providerMetadata : []).filter((row) => row && typeof row === 'object').slice(0, 12).map((row) => ({ sourceId: row.sourceId ? String(row.sourceId).slice(0, 120) : null, recordId: row.recordId ? String(row.recordId).slice(0, 120) : null, store: row.store ? String(row.store).slice(0, 160) : null, brandName: row.brandName ? String(row.brandName).slice(0, 160) : null, firmName: row.firmName ? String(row.firmName).slice(0, 160) : null, source: row.source ? String(row.source).slice(0, 160) : null, rating: finite(row.rating), merchantWebsiteUrl: safeUrl(row.merchantWebsiteUrl) }));
    const inputAmbiguityReasons = Array.isArray(input.monetaryAmbiguityReasons) ? input.monetaryAmbiguityReasons : input.monetaryAmbiguityReasons ? [input.monetaryAmbiguityReasons] : [];
    const ambiguityReasons = uniqueStrings([...inputAmbiguityReasons, input.monetaryAmbiguityReason, ...active.map((claim) => claim.monetaryAmbiguityReason)], 20);
    const hasResolvedMonetaryTerms = Number.isFinite(resolved.discountAmount) || Number.isFinite(resolved.discountPercent) || Number.isFinite(resolved.minimumSpend);
    const hasAmbiguousMonetaryClaim = ambiguityReasons.length || input.monetaryInterpretation === 'AMBIGUOUS' || active.some((claim) => claim.monetaryInterpretation === 'AMBIGUOUS');
    const effectiveMonetaryInterpretation = hasAmbiguousMonetaryClaim ? 'AMBIGUOUS' : hasResolvedMonetaryTerms ? 'PARSED' : monetaryInterpretation(input.monetaryInterpretation);
    return { schemaVersion: Limits.PROMO_SCHEMA_VERSION, code, type: input.type || 'PLATFORM_PROMO_CODE', ...resolved,
      newUsersOnly: triState(input.newUsersOnly), monetaryInterpretation: effectiveMonetaryInterpretation, monetaryAmbiguityReasons: ambiguityReasons,
      campaign: input.campaign || null, providerMetadata,
      itemIds: uniqueStrings([...(input.itemIds || []), input.itemId], 100), sellerIds: uniqueStrings([...(input.sellerIds || []), input.sellerId], 100),
      sourceClaims: claims, source: input.source || sourceIds[0] || SOURCES.USER, sources: sourceIds,
      title: input.title || null, region: input.region || resolved.regions[0] || null, currency: input.currency || resolved.currencies[0] || null,
      itemId: input.itemId || input.itemIds?.[0] || null, skuId: input.skuId || null,
      firstSeenAt, addedAt: safeDate(input.addedAt) || firstSeenAt, lastSeenAt,
      lastVerifiedAt: safeDate(input.lastVerifiedAt), verificationStatus: input.verificationStatus || input.lastStatus || null,
      verificationMessage: input.verificationMessage || input.lastMessage || null,
      saving: finite(input.saving ?? input.lastDiscount), verified: input.verified === true,
      lastVerificationContext: input.lastVerificationContext && typeof input.lastVerificationContext === 'object' ? { country: /^[A-Za-z]{2}$/.test(input.lastVerificationContext.country || '') ? String(input.lastVerificationContext.country).toUpperCase() : null, currency: input.lastVerificationContext.currency || null, itemIds: uniqueStrings(input.lastVerificationContext.itemIds, 100), sellerIds: uniqueStrings(input.lastVerificationContext.sellerIds, 100) } : null };
  }

  function mergeTwo(previous, row) {
    const sourceClaims = compactClaims([...(previous.sourceClaims || []), ...(row.sourceClaims || [])]);
    const latestVerification = row.lastVerifiedAt && (!previous.lastVerifiedAt || Date.parse(row.lastVerifiedAt) >= Date.parse(previous.lastVerifiedAt)) ? row : previous.lastVerifiedAt || previous.verificationStatus ? previous : row;
    const mergedNewUsersOnly = previous.newUsersOnly === true || row.newUsersOnly === true ? true : previous.newUsersOnly === false && row.newUsersOnly === false ? false : null;
    return candidate({ ...previous, title: row.title || previous.title, type: row.type || previous.type,
      newUsersOnly: mergedNewUsersOnly, campaign: previous.campaign || row.campaign,
      providerMetadata: [...(previous.providerMetadata || []), ...(row.providerMetadata || [])].slice(0, 12),
      itemIds: uniqueStrings([...(previous.itemIds || []), ...(row.itemIds || [])]), sellerIds: uniqueStrings([...(previous.sellerIds || []), ...(row.sellerIds || [])]),
      regions: uniqueStrings([...(previous.regions || []), ...(row.regions || [])]), currencies: uniqueStrings([...(previous.currencies || []), ...(row.currencies || [])]),
      sourceClaims, sources: uniqueStrings([...(previous.sources || []), ...(row.sources || [])]), source: previous.source || row.source,
      firstSeenAt: [previous.firstSeenAt, row.firstSeenAt].filter(Boolean).sort()[0], lastSeenAt: [previous.lastSeenAt, row.lastSeenAt].filter(Boolean).sort().at(-1),
      lastVerifiedAt: latestVerification.lastVerifiedAt, verificationStatus: latestVerification.verificationStatus,
      verificationMessage: latestVerification.verificationMessage, saving: latestVerification.saving,
      verified: previous.verified || row.verified, lastVerificationContext: latestVerification.lastVerificationContext });
  }

  function retentionScore(row, referenceTime = Date.now()) {
    const categories = new Set(activeClaims(row.sourceClaims).map((claim) => claim.category)); let score = row.verified ? 500_000 : 0;
    if (categories.has('USER')) score += 1_000_000; if (categories.has('PRODUCT_PAGE')) score += 300_000;
    if (categories.has('OFFICIAL_ALIEXPRESS')) score += 250_000; if (categories.has('VERIFIED_PROVIDER')) score += 150_000;
    const ageDays = Math.max(0, (referenceTime - Date.parse(row.lastSeenAt || 0)) / 86_400_000);
    score += Math.max(0, 100_000 - ageDays * 2_000) + (row.confidence || 0) * 100;
    if (row.expiresAt && Date.parse(row.expiresAt) < referenceTime) score -= 400_000; return score;
  }
  function applyLibraryLimit(rows, max = Limits.MAX_LIBRARY_CANDIDATES) { return rows.slice().sort((a, b) => retentionScore(b) - retentionScore(a) || String(a.code).localeCompare(String(b.code))).slice(0, max); }
  function mergeCandidates(...groups) {
    const map = new Map();
    for (const raw of groups.flat(Infinity)) { const row = candidate(raw); if (!row) continue; map.set(row.code, map.has(row.code) ? mergeTwo(map.get(row.code), row) : row); }
    return applyLibraryLimit([...map.values()]);
  }

  function verificationOverlay(row) {
    if (!row?.code || !(row.lastVerifiedAt || row.verificationStatus || row.lastStatus)) return null;
    return { code: normalizeCode(row.code), lastVerifiedAt: safeDate(row.lastVerifiedAt), verificationStatus: row.verificationStatus || row.lastStatus || null, verificationMessage: row.verificationMessage || row.lastMessage || null, saving: finite(row.saving ?? row.lastDiscount), verified: row.verified === true, lastVerificationContext: row.lastVerificationContext || null };
  }
  function applyVerificationOverlays(rows, overlays = {}) { return rows.map((row) => overlays[row.code] ? candidate({ ...row, ...overlays[row.code], sourceClaims: row.sourceClaims }) : row); }
  function localCandidate(row) {
    const normalized = candidate(row); if (!normalized) return null; const claims = normalized.sourceClaims.filter(isLocalClaim); if (!claims.length) return null;
    return candidate({ ...normalized, sourceClaims: claims, source: claims[0].sourceId, sources: claims.map((claim) => claim.sourceId) });
  }
  function localCandidates(rows = []) { return mergeCandidates(rows.map(localCandidate).filter(Boolean)); }

  function importDataPayload(payload, source = SOURCES.REMOTE_JSON) {
    let parsed = payload; if (typeof payload === 'string') { try { parsed = JSON.parse(payload); } catch (_) { return []; } }
    const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.promos) ? parsed.promos : parsed?.codes); if (!Array.isArray(rows)) return [];
    return rows.slice(0, Limits.MAX_REMOTE_FEED_ENTRIES).map((row) => typeof row === 'string' ? candidate({ code: row, source }) : (!row || typeof row !== 'object' || Array.isArray(row) ? null : candidate({ ...row, source: row.source || source }))).filter(Boolean);
  }
  function candidatesFromPromotions(promotions = [], source = SOURCES.PRODUCT_PAGE) { return promotions.filter((row) => row?.code).map((row) => candidate({ ...row, source, startsAt: row.startsAt || row.startAt, itemIds: uniqueStrings([...(row.itemIds || []), row.itemId]), sellerIds: uniqueStrings([...(row.sellerIds || []), row.sellerId]) })).filter(Boolean); }

  function migrateStorageSnapshot(snapshot = {}) {
    const legacyRows = [...(Array.isArray(snapshot.couponCandidates) ? snapshot.couponCandidates : []), ...(Array.isArray(snapshot.promoLibrary) ? snapshot.promoLibrary : [])]; const overlays = { ...(snapshot.promoVerificationHistory || {}) };
    for (const row of legacyRows) { const overlay = verificationOverlay(row); if (overlay?.code) overlays[overlay.code] = overlay; }
    return { ...snapshot, promoStorageSchemaVersion: Limits.STORAGE_SCHEMA_VERSION, couponCandidates: localCandidates(legacyRows), promoVerificationHistory: overlays, promoLibrary: [] };
  }
  async function migrateStorage() {
    const stored = await chrome.storage.local.get(['promoStorageSchemaVersion', 'couponCandidates', 'promoLibrary', 'promoVerificationHistory']); if (stored.promoStorageSchemaVersion === Limits.STORAGE_SCHEMA_VERSION) return stored;
    const migrated = migrateStorageSnapshot(stored); await chrome.storage.local.set({ promoStorageSchemaVersion: migrated.promoStorageSchemaVersion, couponCandidates: migrated.couponCandidates, promoVerificationHistory: migrated.promoVerificationHistory, promoLibrary: [] }); return migrated;
  }

  function updateWatchlistForProduct(watchlist = [], product = {}) {
    return watchlist.map((row) => {
      if (row.itemId !== product.itemId || (row.skuId && !product.skuId) || (row.skuId && product.skuId && String(row.skuId) !== String(product.skuId))) return row;
      return { ...row, title: product.title || row.title, url: product.url || row.url, lastKnownPrice: product.detectedPrice?.value, currency: product.currency, lastCheckedAt: product.parsedAt, selectedVariant: product.selectedVariant, skuId: row.skuId || product.skuId || null, seller: product.seller, promotions: product.promotions };
    });
  }
  function retainHistory(history = [], snapshot, { samePriceIntervalMs = 12 * 60 * 60 * 1000, maxPerSku = 360 } = {}) {
    const rows = Array.isArray(history) ? history.slice() : []; const last = rows.at(-1); const changed = !last || last.price !== snapshot.price || last.currency !== snapshot.currency || last.skuId !== snapshot.skuId || last.selectedVariant !== snapshot.selectedVariant;
    const elapsed = Date.parse(snapshot.parsedAt || 0) - Date.parse(last?.parsedAt || 0); if (changed || elapsed >= samePriceIntervalMs) rows.push(snapshot); return rows.slice(-maxPerSku);
  }
  function pruneHistoryObject(storageObject = {}, maxTotal = 2500) {
    const keys = Object.keys(storageObject).filter((key) => key.startsWith('history:') && Array.isArray(storageObject[key])); const all = [];
    for (const key of keys) storageObject[key].forEach((row, index) => all.push({ key, index, timestamp: Date.parse(row?.parsedAt || 0) || 0 })); if (all.length <= maxTotal) return {};
    const keep = new Set(all.sort((a, b) => b.timestamp - a.timestamp).slice(0, maxTotal).map((row) => `${row.key}:${row.index}`)); return Object.fromEntries(keys.map((key) => [key, storageObject[key].filter((_, index) => keep.has(`${key}:${index}`))]));
  }
  async function enforceHistoryBudget(maxTotal = 2500) { const all = await chrome.storage.local.get(null); const updates = pruneHistoryObject(all, maxTotal); if (Object.keys(updates).length) await chrome.storage.local.set(updates); return updates; }

  async function storageDiagnostics(storage = chrome.storage.local) {
    const all = await storage.get(null); let bytesInUse = null; if (typeof storage.getBytesInUse === 'function') { try { bytesInUse = await storage.getBytesInUse(null); } catch (_) {} }
    const history = Object.fromEntries(Object.entries(all).filter(([key]) => key.startsWith('history:'))); const total = Number.isFinite(bytesInUse) ? bytesInUse : estimateBytes(all);
    return { bytesInUse: total, promoLibraryBytesEstimate: estimateBytes(all.couponCandidates || []), promoFeedBytesEstimate: estimateBytes(all.promoFeed || null), historyBytesEstimate: estimateBytes(history), softBudgetBytes: Limits.STORAGE_SOFT_BUDGET_BYTES, overSoftBudget: total > Limits.STORAGE_SOFT_BUDGET_BYTES };
  }
  async function enforceStorageBudget(storage = chrome.storage.local) {
    let diagnostics = await storageDiagnostics(storage); if (!diagnostics.overSoftBudget) return diagnostics;
    const all = await storage.get(null); const historyUpdates = pruneHistoryObject(all, 1000); if (Object.keys(historyUpdates).length) await storage.set(historyUpdates);
    if (all.promoFeed?.retractions?.length) await storage.set({ promoFeed: { ...all.promoFeed, retractions: all.promoFeed.retractions.slice(-25) } });
    await storage.set({ couponCandidates: localCandidates(all.couponCandidates || []) }); diagnostics = await storageDiagnostics(storage); return diagnostics;
  }

  async function load() {
    await migrateStorage(); const { couponCandidates = [], promoFeed = null, promoVerificationHistory = {} } = await chrome.storage.local.get(['couponCandidates', 'promoFeed', 'promoVerificationHistory']);
    const remote = !promoFeed?.expiresAt || Date.parse(promoFeed.expiresAt) > Date.now() ? (promoFeed?.promos || []) : [];
    return applyVerificationOverlays(mergeCandidates(couponCandidates, remote), promoVerificationHistory);
  }
  async function save(rows) {
    const local = localCandidates(rows); const overlays = {}; for (const row of rows || []) { const overlay = verificationOverlay(row); if (overlay?.code) overlays[overlay.code] = overlay; }
    const stored = await chrome.storage.local.get('promoVerificationHistory'); await chrome.storage.local.set({ promoStorageSchemaVersion: Limits.STORAGE_SCHEMA_VERSION, couponCandidates: local, promoVerificationHistory: { ...(stored.promoVerificationHistory || {}), ...overlays } });
    await enforceStorageBudget(); return load();
  }
  async function upsert(rows) {
    await migrateStorage(); const stored = await chrome.storage.local.get(['couponCandidates', 'promoVerificationHistory']); const local = mergeCandidates(stored.couponCandidates || [], localCandidates(rows || [])); const overlays = { ...(stored.promoVerificationHistory || {}) };
    for (const row of rows || []) { const overlay = verificationOverlay(row); if (overlay?.code) overlays[overlay.code] = overlay; }
    await chrome.storage.local.set({ promoStorageSchemaVersion: Limits.STORAGE_SCHEMA_VERSION, couponCandidates: local, promoVerificationHistory: overlays }); await enforceStorageBudget(); return load();
  }

  globalThis.CouponHunterStorage = { SOURCES, normalizeCode, sourceClaim, claimKey, compactClaims, activeClaims, isLocalClaim, sourceGroupTrust, fieldResolution,
    candidate, resolveClaims, retentionScore, applyLibraryLimit, mergeCandidates, localCandidates, applyVerificationOverlays,
    importDataPayload, candidatesFromPromotions, migrateStorageSnapshot, migrateStorage, updateWatchlistForProduct, retainHistory, pruneHistoryObject,
    enforceHistoryBudget, estimateBytes, storageDiagnostics, enforceStorageBudget, load, save, upsert };
})();
