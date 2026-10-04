'use strict';
const { requestJson, ProviderError } = require('../http-client');

const FEEDICO_PAGE_SIZE = 100;
const FEEDICO_MAX_PAGES_PER_RUN = 5;
const CURRENCY_BY_SYMBOL = Object.freeze({ '$': 'USD', '€': 'EUR', '£': 'GBP', '₽': 'RUB' });
const CURRENCY_CODES = 'USD|EUR|GBP|RUB';

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

function extractFeedicoTerms(title) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  const empty = { discountAmount: null, discountPercent: null, minimumSpend: null, currency: null };
  if (!text || /\b(?:up\s+to|as\s+much\s+as|selected|select\s+items?|varies?)\b/i.test(text)) return empty;

  const percentMatch = text.match(/(?:^|\b)(\d{1,2}(?:[.,]\d+)?)\s*%\s*(?:off|discount)(?:\b|$)/i);
  const fixedMatch = text.match(new RegExp(`(${moneyPattern()})\\s*(?:off|discount)(?:\\b|$)`, 'i')) || text.match(new RegExp(`(?:save|get)\\s+(${moneyPattern()})(?:\\s+off)?(?:\\b|$)`, 'i'));
  let discountAmount = null; let discountPercent = null; let discountCurrency = null;
  if (percentMatch) discountPercent = Number(percentMatch[1].replace(',', '.'));
  if (fixedMatch) { const parsed = parseMoneyText(fixedMatch[1]); if (parsed) { discountAmount = parsed.amount; discountCurrency = parsed.currency; } }
  if (discountAmount !== null && discountPercent !== null) return empty;

  const minimumPatterns = [
    new RegExp(`(?:orders?|purchases?)\\s*(?:of\\s*)?(?:over|above|from|at\\s+least|minimum|min\\.?)\\s*(${moneyPattern()})`, 'i'),
    new RegExp(`(?:when\\s+you\\s+spend|spend)\\s*(?:over|above|from|at\\s+least)?\\s*(${moneyPattern()})`, 'i'),
    new RegExp(`(?:off|discount)\\s*(?:on\\s+orders?\\s*)?(?:over|above|from|at\\s+least)?\\s*(${moneyPattern()})`, 'i')
  ];
  let minimum = null;
  for (const pattern of minimumPatterns) { const match = text.match(pattern); if (match) { minimum = parseMoneyText(match[1]); if (minimum) break; } }
  if (minimum && discountCurrency && minimum.currency !== discountCurrency) minimum = null;
  return { discountAmount, discountPercent, minimumSpend: minimum?.amount ?? null, currency: discountCurrency || minimum?.currency || null };
}

function normalizeCoupon(row = {}) {
  const terms = extractFeedicoTerms(row.title);
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
    discountCurrency: terms.currency
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

module.exports = { FEEDICO_PAGE_SIZE, FEEDICO_MAX_PAGES_PER_RUN, isAliExpress, extractFeedicoTerms, normalizeCoupon, createFeedicoAdapter };
