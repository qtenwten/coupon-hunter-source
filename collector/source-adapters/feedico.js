'use strict';
const { requestJson, ProviderError } = require('../http-client');

const FEEDICO_PAGE_SIZE = 100;
const FEEDICO_MAX_PAGES_PER_RUN = 5;
const CURRENCY_BY_SYMBOL = Object.freeze({ '$': 'USD', '€': 'EUR', '£': 'GBP', '₽': 'RUB' });
const CURRENCY_CODES = 'USD|EUR|GBP|RUB';
const STRUCTURED_REGION_FIELDS = Object.freeze(['countryCode', 'countryCodes', 'country', 'countries', 'location', 'locations', 'region', 'regions']);
const REGION_ALIASES = Object.freeze({
  US: 'US', USA: 'US', 'UNITED STATES': 'US', 'UNITED STATES OF AMERICA': 'US',
  UK: 'GB', GB: 'GB', GBR: 'GB', 'UNITED KINGDOM': 'GB', 'GREAT BRITAIN': 'GB',
  AU: 'AU', AUS: 'AU', AUSTRALIA: 'AU', CZ: 'CZ', CZE: 'CZ', CZECHIA: 'CZ', 'CZECH REPUBLIC': 'CZ',
  HU: 'HU', HUN: 'HU', HUNGARY: 'HU', CL: 'CL', CHL: 'CL', CHILE: 'CL',
  CA: 'CA', CAN: 'CA', CANADA: 'CA', DE: 'DE', DEU: 'DE', GERMANY: 'DE',
  ES: 'ES', ESP: 'ES', SPAIN: 'ES', FR: 'FR', FRA: 'FR', FRANCE: 'FR',
  IT: 'IT', ITA: 'IT', ITALY: 'IT', JP: 'JP', JPN: 'JP', JAPAN: 'JP',
  KR: 'KR', KOR: 'KR', 'SOUTH KOREA': 'KR', 'REPUBLIC OF KOREA': 'KR',
  IL: 'IL', ISR: 'IL', ISRAEL: 'IL', MX: 'MX', MEX: 'MX', MEXICO: 'MX',
  NL: 'NL', NLD: 'NL', NETHERLANDS: 'NL', PL: 'PL', POL: 'PL', POLAND: 'PL',
  PT: 'PT', PRT: 'PT', PORTUGAL: 'PT', UA: 'UA', UKR: 'UA', UKRAINE: 'UA'
});
const TITLE_REGION_MARKERS = Object.freeze(['US', 'UK', 'GB', 'AU', 'CZ', 'HU', 'CL', 'CA', 'DE', 'ES', 'FR', 'IT', 'JP', 'KR', 'IL', 'MX', 'NL', 'PL', 'PT', 'UA']);

function isAliExpress(row = {}) {
  return [row.firmName, row.brandName, row.networkName, row.merchantWebsiteUrl].filter(Boolean).some((value) => /(?:^|\b|\.)aliexpress(?:\.|\b)/i.test(String(value)));
}

function moneyPattern() {
  return `(?:([$€£₽])\\s*(\\d+(?:[.,]\\d{1,2})?)|(${CURRENCY_CODES})\\s*(\\d+(?:[.,]\\d{1,2})?)|(\\d+(?:[.,]\\d{1,2})?)\\s*(${CURRENCY_CODES}))`;
}

function parseMoneyText(value) {
  const match = String(value || '').match(new RegExp(`^${moneyPattern()}$`, 'i'));
  if (!match) return null;
  if (match[1]) return { amount: Number(match[2].replace(',', '.')), currency: CURRENCY_BY_SYMBOL[match[1]] };
  if (match[3]) return { amount: Number(match[4].replace(',', '.')), currency: match[3].toUpperCase() };
  return { amount: Number(match[5].replace(',', '.')), currency: match[6].toUpperCase() };
}

function termsResult(values = {}) {
  return {
    discountAmount: values.discountAmount ?? null,
    discountPercent: values.discountPercent ?? null,
    minimumSpend: values.minimumSpend ?? null,
    currency: values.currency ?? null,
    monetaryInterpretation: values.monetaryInterpretation || 'UNKNOWN',
    monetaryAmbiguityReason: values.monetaryAmbiguityReason || null
  };
}

function extractFeedicoTerms(title) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  if (!text) return termsResult();
  if (/\b(?:up\s+to|as\s+much\s+as|selected|select\s+items?|varies?)\b/i.test(text)) return termsResult({ monetaryInterpretation: 'AMBIGUOUS', monetaryAmbiguityReason: 'NON_DETERMINISTIC_LANGUAGE' });

  const percentMatch = text.match(/(?:^|\b)(\d{1,2}(?:[.,]\d+)?)\s*%\s*(?:off|discount)(?:\b|$)/i);
  const fixedMatch = text.match(new RegExp(`(${moneyPattern()})\\s*(?:off|discount)(?:\\b|$)`, 'i')) || text.match(new RegExp(`(?:save|get)\\s+(${moneyPattern()})(?:\\s+off)?(?:\\b|$)`, 'i'));
  let discountAmount = null; let discountPercent = null; let discountCurrency = null;
  if (percentMatch) discountPercent = Number(percentMatch[1].replace(',', '.'));
  if (fixedMatch) { const parsed = parseMoneyText(fixedMatch[1]); if (parsed) { discountAmount = parsed.amount; discountCurrency = parsed.currency; } }
  if (discountAmount !== null && discountPercent !== null) return termsResult({ monetaryInterpretation: 'AMBIGUOUS', monetaryAmbiguityReason: 'MULTIPLE_DISCOUNT_TYPES' });

  const minimumPatterns = [
    new RegExp(`(?:orders?|purchases?)\\s*(?:of\\s*)?(?:over|above|from|at\\s+least|minimum|min\\.?)\\s*(${moneyPattern()})`, 'i'),
    new RegExp(`(?:when\\s+you\\s+spend|spend)\\s*(?:over|above|from|at\\s+least)?\\s*(${moneyPattern()})`, 'i'),
    new RegExp(`(?:off|discount)\\s*(?:on\\s+orders?\\s*)?(?:over|above|from|at\\s+least)?\\s*(${moneyPattern()})`, 'i')
  ];
  let minimum = null;
  for (const pattern of minimumPatterns) { const match = text.match(pattern); if (match) { minimum = parseMoneyText(match[1]); if (minimum) break; } }
  if (minimum && discountCurrency && minimum.currency !== discountCurrency) return termsResult({ monetaryInterpretation: 'AMBIGUOUS', monetaryAmbiguityReason: 'CURRENCY_CONFLICT' });
  const currency = discountCurrency || minimum?.currency || null;
  if ((discountAmount !== null && discountAmount <= 0) || (discountPercent !== null && (discountPercent <= 0 || discountPercent >= 100)) || (minimum && minimum.amount <= 0)) {
    return termsResult({ currency, monetaryInterpretation: 'AMBIGUOUS', monetaryAmbiguityReason: 'NON_POSITIVE_OR_EXTREME_VALUE' });
  }
  if (discountAmount !== null && minimum && discountAmount >= minimum.amount) {
    return termsResult({ currency, monetaryInterpretation: 'AMBIGUOUS', monetaryAmbiguityReason: 'DISCOUNT_NOT_BELOW_MINIMUM_SPEND' });
  }
  const parsed = discountAmount !== null || discountPercent !== null || minimum !== null;
  return termsResult({ discountAmount, discountPercent, minimumSpend: minimum?.amount ?? null, currency, monetaryInterpretation: parsed ? 'PARSED' : 'UNKNOWN' });
}

function regionValue(value) {
  const normalized = String(value || '').trim().toUpperCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ');
  return REGION_ALIASES[normalized] || null;
}

function collectStructuredRegions(value, output) {
  if (Array.isArray(value)) { for (const entry of value) collectStructuredRegions(entry, output); return; }
  if (value && typeof value === 'object') {
    for (const key of ['countryCode', 'country', 'code', 'iso2', 'name', 'location']) if (value[key] !== undefined) collectStructuredRegions(value[key], output);
    return;
  }
  const exact = regionValue(value); if (exact) { output.add(exact); return; }
  for (const part of String(value || '').split(/[,;|/]+/)) { const normalized = regionValue(part); if (normalized) output.add(normalized); }
}

function extractTitleRegions(title) {
  const text = String(title || ''); const found = new Set(); const markerPattern = TITLE_REGION_MARKERS.join('|');
  const localLists = new RegExp(`\\b((?:${markerPattern})(?:\\s*,\\s*(?:${markerPattern}))*)\\s+Local\\s+day\\s+codes?\\b`, 'g');
  for (const match of text.matchAll(localLists)) for (const marker of match[1].split(',').map((value) => value.trim())) found.add(REGION_ALIASES[marker]);
  for (const marker of TITLE_REGION_MARKERS) {
    const contextual = new RegExp(`\\b${marker}(?=\\s+(?:[Cc]odes?\\b|[Nn]ew\\s+[Uu]sers?(?:\\s+[Oo]nly)?\\b|[Cc]hoice\\s+[Dd]ay\\s+[Ss]ale\\b|(?:[A-Z]{0,3}\\$|[$€£₽])\\s*\\d))`);
    if (contextual.test(text)) found.add(REGION_ALIASES[marker]);
  }
  return [...found].filter(Boolean).sort();
}

function extractFeedicoRegions(row = {}) {
  const regions = new Set(); let hasStructuredRegion = false;
  for (const field of STRUCTURED_REGION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
    const value = row[field]; if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) continue;
    hasStructuredRegion = true; collectStructuredRegions(value, regions);
  }
  return hasStructuredRegion ? [...regions].sort() : extractTitleRegions(row.title);
}

function extractNewUsersOnly(title) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  if (!text || /\b(?:all|existing|returning)\s+(?:users?|customers?)?\s*(?:and|or)\s+new\s+(?:users?|customers?)\b/i.test(text) || /\bnew\s+(?:users?|customers?)\s+(?:and|or)\s+(?:all|existing|returning)\b/i.test(text)) return null;
  return /\bnew\s+(?:users?|customers?)(?:\s+only)?\b/i.test(text) || /\b(?:only|exclusively)\s+for\s+new\s+(?:users?|customers?)\b/i.test(text) ? true : null;
}

function normalizeCoupon(row = {}) {
  const terms = extractFeedicoTerms(row.title);
  const titleAudience = extractNewUsersOnly(row.title);
  const newUsersOnly = row.newUsersOnly === true || titleAudience === true ? true : row.newUsersOnly === false ? false : null;
  return {
    code: row.code,
    title: row.title ? String(row.title).slice(0, 300) : null,
    lifecycleStatus: String(row.status || 'active').toLowerCase() === 'suspended' ? 'SUSPENDED' : 'ACTIVE',
    providerRecordId: row.id,
    providerStore: row.firmName || row.brandName || row.networkName || null,
    providerBrandName: row.brandName || null,
    providerFirmName: row.firmName || null,
    providerSource: row.provider || 'feedico',
    providerMerchantWebsiteUrl: row.merchantWebsiteUrl || null,
    startsAt: row.startsAt || null,
    expiresAt: row.endsAt || null,
    url: row.merchantWebsiteUrl || null,
    discountAmount: terms.discountAmount,
    discountPercent: terms.discountPercent,
    minimumSpend: terms.minimumSpend,
    minimumSpendBasis: Number.isFinite(terms.minimumSpend) ? 'UNKNOWN' : 'UNKNOWN',
    currency: terms.currency,
    discountCurrency: terms.currency,
    monetaryInterpretation: terms.monetaryInterpretation,
    monetaryAmbiguityReason: terms.monetaryAmbiguityReason,
    regions: extractFeedicoRegions(row),
    newUsersOnly
  };
}

function createFeedicoAdapter(options = {}) {
  const token = options.token || process.env.FEEDICO_TOKEN;
  return {
    id: 'feedico', sourceGroup: 'feedico', category: 'VERIFIED_PROVIDER', trust: 0.7, mode: 'FULL_SNAPSHOT', enabled: options.enabled !== false && !!token,
    disabledReason: token ? null : 'FEEDICO_TOKEN is not configured; AliExpress catalogue availability is not confirmed for this account',
    async fetch(context = {}) {
      if (!this.enabled) throw new ProviderError('AUTH_REQUIRED', this.disabledReason);
      const coupons = []; let pagesRequested = 0; let reportedCount = null; let lastBatchSize = 0;
      for (let page = 1; page <= FEEDICO_MAX_PAGES_PER_RUN; page += 1) {
        pagesRequested += 1;
        const payload = await requestJson('https://api.feedico.io/api/v1/catalog/coupons', {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ page, pageSize: FEEDICO_PAGE_SIZE, firmName: 'AliExpress' }),
          fetchImpl: context.fetchImpl, sleep: context.sleep, timeoutMs: context.timeoutMs, retries: context.retries
        });
        const batch = Array.isArray(payload?.coupons) ? payload.coupons : []; coupons.push(...batch); lastBatchSize = batch.length;
        if (Number.isFinite(Number(payload?.recordCount))) reportedCount = Number(payload.recordCount);
        if (batch.length < FEEDICO_PAGE_SIZE || (reportedCount !== null && coupons.length >= reportedCount)) break;
      }
      const rows = coupons.filter((row) => row.code && isAliExpress(row)).map(normalizeCoupon);
      const feedicoTruncated = (reportedCount !== null && reportedCount > coupons.length) || (pagesRequested === FEEDICO_MAX_PAGES_PER_RUN && lastBatchSize === FEEDICO_PAGE_SIZE && reportedCount === null);
      return {
        rows,
        state: { lastSuccessfulSync: new Date(context.nowMs ?? Date.now()).toISOString() },
        rawCount: coupons.length,
        diagnostics: { feedicoTruncated, pagesRequested, rawCount: coupons.length, normalizedCount: rows.length }
      };
    },
    normalize(value) { return value; }
  };
}

module.exports = { FEEDICO_PAGE_SIZE, FEEDICO_MAX_PAGES_PER_RUN, isAliExpress, extractFeedicoTerms, extractFeedicoRegions, extractTitleRegions, extractNewUsersOnly, normalizeCoupon, createFeedicoAdapter };
