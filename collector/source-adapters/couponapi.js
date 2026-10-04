'use strict';
const { requestJson, ProviderError } = require('../http-client');

function merchantIsAliExpress(offer = {}) {
  return [offer.store, offer.merchant_home_page, offer.url].filter(Boolean).some((value) => /(?:^|\b|\.)aliexpress(?:\.|\b)/i.test(String(value)));
}
function regions(value) { return [...new Set(String(value || '').split(/[,;|\s]+/).map((row) => row.trim().toUpperCase()).filter((row) => /^[A-Z]{2}$/.test(row)))]; }
function isoDate(value, end = false) { if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null; return `${value}T${end ? '23:59:59' : '00:00:00'}Z`; }

function extractTerms(text) {
  const value = String(text || '').replace(/\s+/g, ' '); let discountAmount = null; let discountPercent = null; let minimumSpend = null; let currency = null;
  const percent = value.match(/(?:save|get)?\s*(\d{1,2}(?:\.\d+)?)\s*%\s*(?:off|discount)/i); if (percent) discountPercent = Number(percent[1]);
  const fixed = value.match(/(?:save|get)?\s*([$€£₽])\s*(\d+(?:[.,]\d{1,2})?)\s*(?:off|discount)/i);
  if (fixed) { discountAmount = Number(fixed[2].replace(',', '.')); currency = ({ '$': 'USD', '€': 'EUR', '£': 'GBP', '₽': 'RUB' })[fixed[1]]; }
  const minimum = value.match(/(?:orders?|spend|purchase)(?:\s+of)?\s*(?:over|above|from|minimum|min\.?|at least)?\s*([$€£₽])\s*(\d+(?:[.,]\d{1,2})?)/i) || value.match(/(?:off|discount)\s*([$€£₽])\s*(\d+(?:[.,]\d{1,2})?)\s*(?:orders?|spend|purchase)/i);
  if (minimum) { const minimumCurrency = ({ '$': 'USD', '€': 'EUR', '£': 'GBP', '₽': 'RUB' })[minimum[1]]; if (!currency || currency === minimumCurrency) { currency = minimumCurrency; minimumSpend = Number(minimum[2].replace(',', '.')); } }
  return { discountAmount, discountPercent, minimumSpend, currency };
}

function normalizeOffer(offer = {}, previous = null) {
  const status = String(offer.status || 'new').toLowerCase(); const terms = extractTerms(`${offer.title || ''} ${offer.description || ''}`);
  return { code: offer.code || previous?.code, lifecycleStatus: status === 'suspended' ? 'SUSPENDED' : 'ACTIVE', providerAction: ['new', 'updated', 'suspended'].includes(status) ? status.toUpperCase() : 'UPDATED',
    providerRecordId: offer.offer_id, providerStore: offer.store || previous?.store || null, providerSource: offer.source || null, providerRating: Number.isFinite(Number(offer.rating)) ? Number(offer.rating) : null,
    startsAt: isoDate(offer.start_date), expiresAt: isoDate(offer.end_date, true), regions: regions(offer.locations || offer.primary_location),
    discountAmount: terms.discountAmount, discountPercent: terms.discountPercent, minimumSpend: terms.minimumSpend,
    minimumSpendBasis: Number.isFinite(terms.minimumSpend) ? 'UNKNOWN' : 'UNKNOWN', currency: terms.currency, discountCurrency: terms.currency,
    url: offer.url || offer.merchant_home_page || null };
}

function createCouponApiAdapter(options = {}) {
  const apiKey = options.apiKey || process.env.COUPONAPI_KEY;
  const initialExtract = options.initialExtract || process.env.COUPONAPI_INITIAL_EXTRACT || null;
  return { id: 'couponapi', sourceGroup: 'couponapi', category: 'VERIFIED_PROVIDER', trust: 0.72, mode: 'INCREMENTAL',
    enabled: options.enabled !== false && !!apiKey, disabledReason: apiKey ? null : 'COUPONAPI_KEY is not configured',
    async fetch(context = {}) {
      if (!this.enabled) throw new ProviderError('AUTH_REQUIRED', this.disabledReason);
      const state = context.providerState?.[this.id] || {}; const url = new URL('https://couponapi.org/api/getIncrementalFeed/');
      url.searchParams.set('API_KEY', apiKey); url.searchParams.set('format', 'json'); url.searchParams.set('off_record', context.offRecord ? '1' : '0');
      if (state.lastExtract || initialExtract) url.searchParams.set('last_extract', String(state.lastExtract || initialExtract));
      const payload = await requestJson(url.href, { fetchImpl: context.fetchImpl, sleep: context.sleep, timeoutMs: context.timeoutMs, retries: context.retries });
      if (payload?.result !== true || !Array.isArray(payload.offers)) throw new ProviderError('INVALID_RESPONSE', 'CouponAPI response did not contain offers');
      const recordIndex = { ...(state.recordIndex || {}) }; const rows = [];
      for (const offer of payload.offers) {
        const recordId = offer.offer_id === undefined || offer.offer_id === null ? null : String(offer.offer_id); const previous = recordId ? recordIndex[recordId] : null;
        const aliExpress = merchantIsAliExpress(offer) || previous?.aliExpress === true; const normalized = normalizeOffer(offer, previous);
        if (aliExpress && String(offer.type || 'Code').toLowerCase() === 'code' && normalized.code) rows.push(normalized);
        if (recordId) { if (normalized.lifecycleStatus === 'SUSPENDED') delete recordIndex[recordId]; else if (normalized.code) recordIndex[recordId] = { code: normalized.code, store: normalized.providerStore, aliExpress }; }
      }
      const boundedIndex = Object.fromEntries(Object.entries(recordIndex).slice(-10_000));
      return { rows, state: { lastExtract: Math.floor((context.nowMs ?? Date.now()) / 1000), lastSuccessfulSync: new Date(context.nowMs ?? Date.now()).toISOString(), recordIndex: boundedIndex }, rawCount: payload.offers.length };
    },
    normalize(value) { return value; }
  };
}

module.exports = { createCouponApiAdapter, merchantIsAliExpress, extractTerms, normalizeOffer };
