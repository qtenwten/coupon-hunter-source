(() => {
  'use strict';
  if (globalThis.CouponHunterPromoIntelligence) return;

  const Limits = globalThis.CouponHunterPromoConstants || { DEFAULT_LIVE_ATTEMPTS: 30, DEEP_SCAN_LIVE_ATTEMPTS: 50, HARD_LIVE_ATTEMPT_LIMIT: 50, FIELD_HARD_FILTER_CONFIDENCE: 70 };
  const Store = globalThis.CouponHunterStorage;
  const Country = globalThis.CouponHunterCountryProfile;
  const DAY_MS = 86_400_000;
  const NEGATIVE_MEMORY_MS = 15 * 60_000;
  const CONTEXTUAL_NEGATIVES = new Set(['EXPIRED', 'INVALID', 'REGION_RESTRICTED', 'ACCOUNT_RESTRICTED', 'NOT_APPLICABLE_TO_ITEMS', 'SITE_REJECTED']);
  const finite = (value) => Number.isFinite(value) ? value : null;
  const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));
  const upperSet = (values) => new Set((Array.isArray(values) ? values : []).filter(Boolean).map((value) => String(value).toUpperCase()));
  const intersects = (left, right) => [...left].some((value) => right.has(value));

  function freshnessScore(candidate, nowMs) {
    const observed = Date.parse(candidate.lastSeenAt || candidate.firstSeenAt || 0);
    if (!Number.isFinite(observed) || observed <= 0) return 15;
    const ageDays = Math.max(0, (nowMs - observed) / DAY_MS);
    return Math.round(clamp(100 * Math.exp(-ageDays / 30)));
  }

  function localVerificationMatches(candidate, context = {}) {
    const previous = candidate.lastVerificationContext; if (!previous) return false;
    const oldCountry = Country?.normalizeCountry(previous.country); const newCountry = Country?.normalizeCountry(context.country || context.region);
    if ((oldCountry || newCountry) && oldCountry !== newCountry) return false;
    if (previous.currency && context.currency && String(previous.currency).toUpperCase() !== String(context.currency).toUpperCase()) return false;
    const oldItems = upperSet(previous.itemIds); const newItems = upperSet(context.itemIds);
    if (oldItems.size && newItems.size && !intersects(oldItems, newItems)) return false;
    const oldSellers = upperSet(previous.sellerIds); const newSellers = upperSet(context.sellerIds);
    if (oldSellers.size && newSellers.size && !intersects(oldSellers, newSellers)) return false;
    return !!(oldCountry || previous.currency || oldItems.size || oldSellers.size);
  }

  function confidenceFor(candidate, nowMs = Date.now(), context = {}) {
    const claims = (Array.isArray(candidate.sourceClaims) ? candidate.sourceClaims : []).filter((claim) => claim.status !== 'RETRACTED');
    const sourceGroups = new Set(claims.map((claim) => claim.sourceGroup).filter(Boolean));
    const sourceTrust = Math.round((Store?.sourceGroupTrust ? Store.sourceGroupTrust(claims) : 0.25) * 100);
    const freshness = freshnessScore(candidate, nowMs);
    const corroboration = clamp(Math.max(0, sourceGroups.size - 1) * 18, 0, 36);
    const fields = [candidate.minimumSpend, candidate.discountAmount, candidate.discountPercent, candidate.expiresAt, candidate.discountCurrency];
    const metadataCompleteness = Math.round(fields.filter((value) => value !== null && value !== undefined).length / fields.length * 100);
    const conflictsPenalty = Math.min(45, (candidate.conflicts?.length || 0) * 12);
    let localHistory = 0;
    if (candidate.verificationStatus === 'VALID_APPLIED' && candidate.verified && localVerificationMatches(candidate, context)) localHistory = 25;
    else if (['EXPIRED', 'OUT_OF_STOCK'].includes(candidate.verificationStatus) && localVerificationMatches(candidate, context)) localHistory = -35;
    else if (candidate.verificationStatus === 'UNKNOWN_ERROR') localHistory = -8;
    const overall = clamp(Math.round(sourceTrust * 0.35 + freshness * 0.25 + corroboration + metadataCompleteness * 0.15 + localHistory - conflictsPenalty));
    return { overall, breakdown: { sourceTrust: Math.round(sourceTrust), freshness, corroboration, metadataCompleteness, conflictsPenalty, localHistory, independentSourceGroups: sourceGroups.size } };
  }

  function amountForBasis(basis, context) {
    if (basis === 'SUBTOTAL') return finite(context.subtotal);
    if (basis === 'ELIGIBLE_ITEMS') return finite(context.eligibleAmount);
    if (basis === 'ORDER_TOTAL') return finite(context.orderTotal ?? context.total);
    return null;
  }

  function estimateSaving(candidate, context) {
    const currency = context.currency || null;
    const discountCurrency = candidate.discountCurrency || candidate.currency || null;
    if (currency && discountCurrency && String(currency).toUpperCase() !== String(discountCurrency).toUpperCase()) return { estimatedSaving: null, theoreticalMaxSaving: null };
    if (candidate.discountType === 'FIXED' && Number.isFinite(candidate.discountAmount)) return { estimatedSaving: candidate.discountAmount, theoreticalMaxSaving: candidate.discountAmount };
    if (candidate.discountType === 'PERCENT' && Number.isFinite(candidate.discountPercent)) {
      const basis = finite(context.eligibleAmount ?? context.subtotal ?? context.orderTotal ?? context.total);
      if (!Number.isFinite(basis)) return { estimatedSaving: null, theoreticalMaxSaving: Number.isFinite(candidate.maximumDiscount) ? candidate.maximumDiscount : null };
      const raw = basis * candidate.discountPercent / 100;
      const saving = Number.isFinite(candidate.maximumDiscount) ? Math.min(raw, candidate.maximumDiscount) : raw;
      return { estimatedSaving: Math.round(saving * 100) / 100, theoreticalMaxSaving: Number.isFinite(candidate.maximumDiscount) ? candidate.maximumDiscount : Math.round(raw * 100) / 100 };
    }
    return { estimatedSaving: null, theoreticalMaxSaving: null };
  }

  function assessCandidate(candidate, context = {}, options = {}) {
    const nowMs = options.nowMs ?? Date.now(); const reasons = []; let eligibility = 'ELIGIBLE';
    const fieldConfidence = candidate.fieldConfidence || {}; const hardThreshold = Limits.FIELD_HARD_FILTER_CONFIDENCE || 70;
    const reliable = (field) => !fieldConfidence[field] || Number(fieldConfidence[field].confidence) >= hardThreshold;
    const expires = candidate.expiresAt ? Date.parse(candidate.expiresAt) : NaN; const starts = candidate.startsAt ? Date.parse(candidate.startsAt) : NaN;
    if (Number.isFinite(expires) && expires > 0 && expires < nowMs && reliable('claimedExpiresAt')) { eligibility = 'INELIGIBLE'; reasons.push('EXPIRED'); }
    else if (Number.isFinite(expires) && expires > 0 && expires < nowMs) { eligibility = 'UNKNOWN'; reasons.push('EXPIRY_CONFLICT'); }
    if (Number.isFinite(starts) && starts > nowMs && reliable('claimedStartsAt')) { eligibility = 'INELIGIBLE'; reasons.push('NOT_STARTED'); }
    else if (Number.isFinite(starts) && starts > nowMs && eligibility === 'ELIGIBLE') { eligibility = 'UNKNOWN'; reasons.push('START_CONFLICT'); }

    const minimum = finite(candidate.minimumSpend ?? candidate.resolvedMinimumSpend);
    const basis = candidate.minimumSpendBasis || 'UNKNOWN'; const applicableAmount = amountForBasis(basis, context);
    if (Number.isFinite(minimum)) {
      if (basis !== 'UNKNOWN' && Number.isFinite(applicableAmount) && applicableAmount + 0.01 < minimum && reliable('claimedMinimumSpend')) { eligibility = 'INELIGIBLE'; reasons.push('MINIMUM_SPEND'); }
      else if (basis !== 'UNKNOWN' && Number.isFinite(applicableAmount) && applicableAmount + 0.01 < minimum) { if (eligibility === 'ELIGIBLE') eligibility = 'UNKNOWN'; reasons.push('MINIMUM_SPEND_CONFLICT'); }
      else if (basis === 'UNKNOWN') { if (eligibility === 'ELIGIBLE') eligibility = 'UNKNOWN'; reasons.push('MINIMUM_SPEND_BASIS_UNKNOWN'); }
    }

    const legacyRegions = upperSet(candidate.regions || (candidate.region ? [candidate.region] : []));
    const legacyTarget = String(context.country || context.region || '').toUpperCase();
    const country = Country?.classifyCandidate(candidate, context.country || context.region) || {
      countryMatch: legacyRegions.size && legacyTarget ? (legacyRegions.has(legacyTarget) ? 'MATCH' : 'MISMATCH') : 'UNKNOWN', countries: [...legacyRegions], confidence: legacyRegions.size ? 100 : 0, evidence: legacyRegions.size ? ['EXPLICIT_REGION'] : []
    };
    if (country.countryMatch === 'MISMATCH') { eligibility = 'INELIGIBLE'; reasons.push(Country ? 'COUNTRY_MISMATCH' : 'REGION_MISMATCH'); }
    else if (country.countryMatch === 'UNKNOWN' && context.includeUnknownCountryCodes === false) { eligibility = 'INELIGIBLE'; reasons.push('COUNTRY_UNKNOWN_EXCLUDED'); }

    const currencies = upperSet(candidate.currencies || (candidate.currency ? [candidate.currency] : []));
    if (currencies.size && context.currency && !currencies.has(String(context.currency).toUpperCase()) && reliable('claimedCurrency')) { eligibility = 'INELIGIBLE'; reasons.push('CURRENCY_MISMATCH'); }
    else if (currencies.size && !context.currency) { if (eligibility === 'ELIGIBLE') eligibility = 'UNKNOWN'; reasons.push('CURRENCY_UNKNOWN'); }

    if (candidate.newUsersOnly === true) {
      const reliableUserStatus = typeof context.isNewUser === 'boolean' && Number(context.newUserStatusConfidence || 0) >= 0.7;
      if (reliableUserStatus && context.isNewUser === false) { eligibility = 'INELIGIBLE'; reasons.push('NEW_USER_ONLY'); }
      else if (!reliableUserStatus) { if (eligibility === 'ELIGIBLE') eligibility = 'UNKNOWN'; reasons.push('NEW_USER_STATUS_UNKNOWN'); }
    }

    const candidateItems = upperSet(candidate.itemIds); const checkoutItems = upperSet(context.itemIds);
    if (candidateItems.size && checkoutItems.size && !intersects(candidateItems, checkoutItems)) { eligibility = 'INELIGIBLE'; reasons.push('ITEM_MISMATCH'); }
    const candidateSellers = upperSet(candidate.sellerIds); const checkoutSellers = upperSet(context.sellerIds);
    if (candidateSellers.size && checkoutSellers.size && !intersects(candidateSellers, checkoutSellers)) { eligibility = 'INELIGIBLE'; reasons.push('SELLER_MISMATCH'); }

    const verifiedAt = Date.parse(candidate.lastVerifiedAt || 0);
    const statusStillCurrent = Number.isFinite(verifiedAt) && (!candidate.lastSeenAt || verifiedAt >= Date.parse(candidate.lastSeenAt));
    const recentContextualNegative = statusStillCurrent && CONTEXTUAL_NEGATIVES.has(candidate.verificationStatus) && localVerificationMatches(candidate, context) && nowMs - verifiedAt <= NEGATIVE_MEMORY_MS;
    if (recentContextualNegative) { eligibility = 'INELIGIBLE'; reasons.push(`LOCAL_${candidate.verificationStatus}`); }
    const savings = estimateSaving(candidate, context); const confidence = confidenceFor(candidate, nowMs, context); const localMatch = localVerificationMatches(candidate, context);
    const applicabilityConfidence = eligibility === 'ELIGIBLE' ? 90 : eligibility === 'UNKNOWN' ? 50 : 100;
    const value = savings.estimatedSaving ?? savings.theoreticalMaxSaving ?? 0;
    const audiencePenalty = candidate.newUsersOnly === true && reasons.includes('NEW_USER_STATUS_UNKNOWN') ? 25 : 0;
    const rankScore = Math.round(value * 1000 + confidence.overall * 10 + applicabilityConfidence - audiencePenalty + (candidate.verificationStatus === 'VALID_APPLIED' && localMatch ? 5000 : 0));
    return { eligibility, reasons, ...country, ...savings, applicabilityConfidence, confidence: confidence.overall, confidenceBreakdown: confidence.breakdown, rankScore };
  }

  function buildQueue(library = [], context = {}, options = {}) {
    const mode = options.mode === 'DEEP' ? 'DEEP' : 'STANDARD';
    const requested = mode === 'DEEP' ? Limits.DEEP_SCAN_LIVE_ATTEMPTS : Limits.DEFAULT_LIVE_ATTEMPTS;
    const limit = Math.min(requested, Limits.HARD_LIVE_ATTEMPT_LIMIT);
    const nowMs = options.nowMs ?? Date.now();
    const liveLibrary = library.filter((candidate) => (candidate.sourceClaims || []).some((claim) => claim.status !== 'RETRACTED') && (!candidate.expiresAt || Date.parse(candidate.expiresAt) >= nowMs || !(candidate.fieldConfidence?.claimedExpiresAt?.confidence >= (Limits.FIELD_HARD_FILTER_CONFIDENCE || 70))));
    const assessed = liveLibrary.map((candidate) => ({ ...candidate, ...assessCandidate(candidate, context, options) }));
    const countryPriority = { MATCH: 0, GLOBAL: 1, UNKNOWN: 2, MISMATCH: 3 };
    const eligible = assessed.filter((row) => row.eligibility !== 'INELIGIBLE').sort((a, b) =>
      (countryPriority[a.countryMatch] ?? 2) - (countryPriority[b.countryMatch] ?? 2) || b.rankScore - a.rankScore || String(a.code).localeCompare(String(b.code)));
    const queue = eligible.slice(0, limit);
    const filteredReasons = {};
    for (const row of assessed.filter((candidate) => candidate.eligibility === 'INELIGIBLE')) for (const reason of row.reasons) filteredReasons[reason] = (filteredReasons[reason] || 0) + 1;
    const sourceCounts = {};
    for (const row of liveLibrary) for (const category of new Set((row.sourceClaims || []).filter((claim) => claim.status !== 'RETRACTED').map((claim) => claim.category))) sourceCounts[category] = (sourceCounts[category] || 0) + 1;
    const countryMatchCounts = { match: 0, global: 0, unknown: 0, mismatch: 0 };
    for (const row of assessed) { const key = String(row.countryMatch || 'UNKNOWN').toLowerCase(); if (Object.prototype.hasOwnProperty.call(countryMatchCounts, key)) countryMatchCounts[key] += 1; }
    return {
      mode, queue, eligibleCandidates: eligible, assessedCandidates: assessed,
      diagnostics: {
        total: library.length, inactive: library.length - liveLibrary.length, filtered: library.length - eligible.length, filteredReasons, eligible: eligible.length,
        rankedLiveQueue: queue.length, limit, queueCoversAllEligible: eligible.length <= limit,
        omitted: Math.max(0, eligible.length - queue.length),
        omittedUnknownTheoretical: eligible.slice(limit).filter((row) => !Number.isFinite(row.theoreticalMaxSaving)).length,
        sourceCounts, countryCode: Country?.normalizeCountry(context.country || context.region), countryMatchCounts
      }
    };
  }

  function shouldEarlyStop(candidate, bestSaving) {
    return Number.isFinite(bestSaving) && bestSaving > 0 && Number.isFinite(candidate?.theoreticalMaxSaving) && candidate.theoreticalMaxSaving <= bestSaving;
  }

  function bestKnownProven(session, queueDiagnostics = {}) {
    if (session?.status !== 'COMPLETE' || !session.bestCode || !queueDiagnostics.queueCoversAllEligible) return false;
    const best = (session.results || []).find((row) => row.code === session.bestCode); const bestSaving = best?.saving;
    if (!Number.isFinite(bestSaving)) return false;
    return !(session.results || []).some((row) => row.verificationStatus === 'UNKNOWN_ERROR' && (!Number.isFinite(row.theoreticalMaxSaving) || row.theoreticalMaxSaving > bestSaving));
  }

  globalThis.CouponHunterPromoIntelligence = { NEGATIVE_MEMORY_MS, freshnessScore, localVerificationMatches, confidenceFor, estimateSaving, assessCandidate, buildQueue, shouldEarlyStop, bestKnownProven };
})();
