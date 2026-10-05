(() => {
  'use strict';
  if (globalThis.CouponHunterCountryProfile) return;

  const MODES = Object.freeze({ AUTO: 'AUTO', MANUAL: 'MANUAL' });
  const MATCH = Object.freeze({ MATCH: 'MATCH', GLOBAL: 'GLOBAL', UNKNOWN: 'UNKNOWN', MISMATCH: 'MISMATCH' });
  const DEFAULT_SETTINGS = Object.freeze({ promoCountryMode: MODES.AUTO, promoCountry: null, includeUnknownCountryCodes: true });
  const FALLBACK_NAMES = Object.freeze({ RU: 'Россия', DE: 'Германия', GB: 'Великобритания', US: 'США', AU: 'Австралия', CZ: 'Чехия', HU: 'Венгрия', CL: 'Чили' });
  const EXPLICIT_COUNTRY_KEYS = new Set([
    'shippingcountry', 'shippingcountrycode', 'deliverycountry', 'deliverycountrycode', 'countrycode',
    'shiptocountry', 'shiptocountrycode', 'destinationcountry', 'destinationcountrycode'
  ]);
  const GLOBAL_MARKERS = new Set(['GLOBAL', 'WORLDWIDE', 'WORLD', 'ALL', 'ALL COUNTRIES', 'INTERNATIONAL']);
  const COUNTRY_ALIASES = Object.freeze({ UK: 'GB', GBR: 'GB', USA: 'US', RUS: 'RU', DEU: 'DE', AUS: 'AU', CZE: 'CZ', HUN: 'HU', CHL: 'CL' });
  const COUNTRY_PATTERNS = Object.freeze({
    DE: /\b(?:germany|deutschland|german)\b/i,
    GB: /\b(?:united\s+kingdom|great\s+britain|britain|british|uk[-\s]only)\b/i,
    AU: /\b(?:australia|australian)\b/i,
    US: /\b(?:united\s+states(?:\s+of\s+america)?|usa|us[-\s]only)\b/i,
    RU: /(?:\b(?:russia|russian)\b|росси(?:я|и|ю|йская|йский|йские)|(?:^|\s)рф(?:\s|$))/i,
    CZ: /\b(?:czechia|czech(?:\s+republic)?)\b/i,
    HU: /\b(?:hungary|hungarian)\b/i,
    CL: /\b(?:chile|chilean)\b/i
  });

  function normalizeCountry(value) {
    const raw = String(value || '').trim().toUpperCase();
    const normalized = COUNTRY_ALIASES[raw] || raw;
    return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
  }

  function normalizeRegion(value) {
    const raw = String(value || '').trim().toUpperCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
    if (GLOBAL_MARKERS.has(raw)) return 'GLOBAL';
    const direct = normalizeCountry(raw); if (direct) return direct;
    for (const [country, pattern] of Object.entries(COUNTRY_PATTERNS)) if (pattern.test(raw)) return country;
    return null;
  }

  function sanitizeSettings(value = {}) {
    const promoCountry = normalizeCountry(value.promoCountry);
    const promoCountryMode = value.promoCountryMode === MODES.MANUAL && promoCountry ? MODES.MANUAL : MODES.AUTO;
    return {
      promoCountryMode,
      promoCountry,
      includeUnknownCountryCodes: value.includeUnknownCountryCodes !== false
    };
  }

  function resolveTarget(settingsValue = {}, autoSignal = null) {
    const settings = sanitizeSettings(settingsValue); const automatic = normalizeCountry(autoSignal?.code || autoSignal?.countryCode);
    if (settings.promoCountryMode === MODES.MANUAL && settings.promoCountry) return { code: settings.promoCountry, mode: MODES.MANUAL, source: 'USER_MANUAL' };
    if (automatic && autoSignal?.strong !== false) return { code: automatic, mode: MODES.AUTO, source: 'AUTO', evidenceType: autoSignal?.source || autoSignal?.evidenceType || null };
    if (settings.promoCountry) return { code: settings.promoCountry, mode: MODES.AUTO, source: 'USER_FALLBACK' };
    return { code: null, mode: MODES.AUTO, source: 'UNRESOLVED' };
  }

  function displayName(code, locale = 'ru') {
    const normalized = normalizeCountry(code); if (!normalized) return 'Не определена';
    try { if (typeof Intl?.DisplayNames === 'function') return new Intl.DisplayNames([locale || 'ru'], { type: 'region' }).of(normalized) || FALLBACK_NAMES[normalized] || normalized; } catch (_) {}
    return FALLBACK_NAMES[normalized] || normalized;
  }

  function explicitCountryValue(value) {
    if (typeof value === 'string' || typeof value === 'number') return normalizeCountry(value);
    if (value && typeof value === 'object') return normalizeCountry(value.code || value.countryCode || value.iso2 || value.isoCode);
    return null;
  }

  function detectStructuredCountry(root, options = {}) {
    const found = new Set(); let visited = 0;
    const maxNodes = options.maxNodes || 50_000;
    const walk = (value, path = []) => {
      if (!value || typeof value !== 'object' || visited++ >= maxNodes) return;
      if (Array.isArray(value)) { for (const child of value) walk(child, [...path, '[]']); return; }
      for (const [key, child] of Object.entries(value)) {
        const compactKey = key.toLowerCase().replace(/[^a-z]/g, '');
        const checkoutScoped = /(?:checkout|order|trade|purchase|cart|shipping|delivery|destination|shipto|address)/i.test([...path, key].join('.'));
        const directionalKey = compactKey !== 'countrycode';
        if (EXPLICIT_COUNTRY_KEYS.has(compactKey) && (directionalKey || checkoutScoped)) { const country = explicitCountryValue(child); if (country) found.add(country); }
        walk(child, [...path, key]);
      }
    };
    walk(root);
    const countries = [...found].sort();
    return countries.length === 1 ? { code: countries[0], strong: true, source: 'ALIEXPRESS_STRUCTURED' } : { code: null, strong: false, source: countries.length > 1 ? 'STRUCTURED_CONFLICT' : 'NONE', candidates: countries };
  }

  function detectDocumentCountry(doc = globalThis.document) {
    if (!doc?.querySelectorAll) return { code: null, strong: false, source: 'NONE' };
    const domCountries = new Set();
    const selector = '[data-country-code],[data-shipping-country],[data-delivery-country],[data-ship-to-country],[data-destination-country],[name="countryCode"],[name="shippingCountry"],[name="deliveryCountry"],[name="shipToCountry"],[name="destinationCountry"]';
    for (const element of Array.from(doc.querySelectorAll(selector)).slice(0, 100)) {
      const values = ['data-country-code', 'data-shipping-country', 'data-delivery-country', 'data-ship-to-country', 'data-destination-country', 'value']
        .map((name) => element.getAttribute?.(name)).concat(element.value);
      for (const value of values) { const country = normalizeCountry(value); if (country) domCountries.add(country); }
    }
    if (domCountries.size === 1) return { code: [...domCountries][0], strong: true, source: 'ALIEXPRESS_COUNTRY_SELECTOR' };
    if (domCountries.size > 1) return { code: null, strong: false, source: 'SELECTOR_CONFLICT', candidates: [...domCountries].sort() };

    const structuredCountries = new Set();
    const scripts = Array.from(doc.querySelectorAll('script[type="application/json"],script#__NEXT_DATA__,script[id*="data" i],script[id*="state" i],script[data-state],script[data-hydration]')).slice(0, 40);
    let totalBytes = 0;
    for (const script of scripts) {
      const text = String(script.textContent || '').trim(); totalBytes += text.length;
      if (!text || text.length > 1_000_000 || totalBytes > 2_000_000 || !/^[{[]/.test(text)) continue;
      try { const result = detectStructuredCountry(JSON.parse(text)); if (result.code) structuredCountries.add(result.code); else for (const code of result.candidates || []) structuredCountries.add(code); } catch (_) {}
    }
    return structuredCountries.size === 1
      ? { code: [...structuredCountries][0], strong: true, source: 'ALIEXPRESS_STRUCTURED' }
      : { code: null, strong: false, source: structuredCountries.size > 1 ? 'STRUCTURED_CONFLICT' : 'NONE', candidates: [...structuredCountries].sort() };
  }

  function candidateText(candidate = {}) {
    const metadata = (candidate.providerMetadata || []).flatMap((row) => [row?.store, row?.brandName, row?.firmName]).filter(Boolean);
    const campaigns = (candidate.sourceClaims || []).map((row) => row?.campaign).filter(Boolean);
    return [candidate.title, candidate.campaign, ...metadata, ...campaigns].filter(Boolean).join(' | ').slice(0, 6000);
  }

  function inferredCountries(candidate = {}) {
    const text = candidateText(candidate); const found = new Set(); const evidence = [];
    for (const [country, pattern] of Object.entries(COUNTRY_PATTERNS)) if (pattern.test(text)) { found.add(country); evidence.push(`TEXT_${country}`); }
    for (const country of ['GB', 'US', 'AU', 'CZ', 'HU', 'CL', 'RU']) {
      const marker = country === 'GB' ? 'UK' : country;
      if (new RegExp(`(?:^|[^A-Z])${marker}(?:[^A-Z]|$)`).test(text)) { found.add(country); evidence.push(`TITLE_MARKER_${marker}`); }
    }
    const code = String(candidate.code || '').toUpperCase();
    if (/^AEUK[A-Z0-9_-]*/.test(code)) { found.add('GB'); evidence.push('CODE_FAMILY_AEUK'); }
    if (/^AUAU[A-Z0-9_-]*/.test(code) && found.has('AU')) evidence.push('CODE_FAMILY_AUAU_CORROBORATED');
    if (/^DELD[A-Z0-9_-]*/.test(code) && found.has('DE')) evidence.push('CODE_FAMILY_DELD_CORROBORATED');
    return { countries: [...found].sort(), evidence };
  }

  function classifyCandidate(candidate = {}, targetCountry = null) {
    const target = normalizeCountry(targetCountry); const rawRegions = [...(Array.isArray(candidate.regions) ? candidate.regions : []), candidate.region].filter(Boolean);
    const explicit = new Set(); let global = false;
    for (const region of rawRegions) { const normalized = normalizeRegion(region); if (normalized === 'GLOBAL') global = true; else if (normalized) explicit.add(normalized); }
    const text = candidateText(candidate);
    if (!rawRegions.length && /(?:\bworldwide\b|\ball\s+countries\b|\bglobal\s+(?:promo|coupon|code|offer)\b)/i.test(text)) global = true;
    if (explicit.size) {
      if (!target) return { countryMatch: MATCH.UNKNOWN, countries: [...explicit].sort(), confidence: 100, evidence: ['EXPLICIT_REGION_TARGET_UNKNOWN'] };
      return { countryMatch: explicit.has(target) ? MATCH.MATCH : MATCH.MISMATCH, countries: [...explicit].sort(), confidence: 100, evidence: ['EXPLICIT_REGION'] };
    }
    if (global) return { countryMatch: MATCH.GLOBAL, countries: [], confidence: 100, evidence: ['EXPLICIT_GLOBAL'] };
    const inferred = inferredCountries(candidate);
    if (inferred.countries.length === 1 && target) return { countryMatch: inferred.countries[0] === target ? MATCH.MATCH : MATCH.MISMATCH, countries: inferred.countries, confidence: inferred.evidence.includes('CODE_FAMILY_AEUK') ? 95 : 85, evidence: inferred.evidence };
    return { countryMatch: MATCH.UNKNOWN, countries: inferred.countries, confidence: inferred.countries.length > 1 ? 0 : inferred.countries.length ? 60 : 0, evidence: inferred.evidence };
  }

  globalThis.CouponHunterCountryProfile = {
    MODES, MATCH, DEFAULT_SETTINGS, FALLBACK_NAMES, normalizeCountry, normalizeRegion, sanitizeSettings, resolveTarget,
    displayName, detectStructuredCountry, detectDocumentCountry, inferredCountries, classifyCandidate
  };
})();
