(() => {
  'use strict';
  if (globalThis.CouponHunterCheckoutCore) return;

  const STATES = Object.freeze({
    IDLE: 'IDLE', ENTERING: 'ENTERING', APPLYING: 'APPLYING', WAITING_RESPONSE: 'WAITING_RESPONSE',
    APPLIED: 'APPLIED', REJECTED: 'REJECTED', UNKNOWN: 'UNKNOWN', REMOVING: 'REMOVING', RESTORING_BASELINE: 'RESTORING_BASELINE'
  });
  const STATUS = Object.freeze({
    VALID_APPLIED: 'VALID_APPLIED', INVALID: 'INVALID', EXPIRED: 'EXPIRED', NOT_STARTED: 'NOT_STARTED',
    MINIMUM_SPEND_NOT_MET: 'MINIMUM_SPEND_NOT_MET', NOT_APPLICABLE_TO_ITEMS: 'NOT_APPLICABLE_TO_ITEMS',
    REGION_RESTRICTED: 'REGION_RESTRICTED', ACCOUNT_RESTRICTED: 'ACCOUNT_RESTRICTED', ALREADY_USED: 'ALREADY_USED',
    OUT_OF_STOCK: 'OUT_OF_STOCK', NOT_COLLECTED: 'NOT_COLLECTED', RATE_LIMITED: 'RATE_LIMITED',
    CAPTCHA: 'CAPTCHA', UNKNOWN_ERROR: 'UNKNOWN_ERROR'
  });

  const normalize = (value = '') => String(value).replace(/[\s\u00A0\u202F]+/g, ' ').trim();
  const finite = (value) => Number.isFinite(value) ? value : null;

  function stableHash(value) {
    let hash = 2166136261;
    for (const char of String(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(36);
  }

  function emptyBreakdown(currency = null) {
    return { subtotal: null, shipping: null, tax: null, discount: null, total: null, currency, confidence: 0, candidates: [] };
  }

  function classifySummaryLabel(text) {
    const value = normalize(text).toLowerCase();
    if (/(grand\s*total|order\s*total|amount\s*due|к\s*оплате|итого\s*к\s*оплате|общая\s*сумма)/i.test(value)) return 'total';
    if (/(sub\s*total|товар(?:ы|ов)?\s*(?:на|:)|сумма\s*товар|стоимость\s*товар|^(?:товары|items|merchandise)$)/i.test(value)) return 'subtotal';
    if (/(shipping|delivery|достав|перевоз)/i.test(value)) return 'shipping';
    if (/(tax|vat|ндс|налог|пошлин|тамож)/i.test(value)) return 'tax';
    if (/(discount|promotion|promo|coupon|скидк|купон|промокод|эконом)/i.test(value)) return 'discount';
    if (/^(total|итого)(?:\s|:|$)/i.test(value)) return 'total';
    return null;
  }

  function buildBreakdown(rows = []) {
    const result = emptyBreakdown();
    const best = new Map();
    for (const row of rows) {
      const kind = row.kind || classifySummaryLabel(`${row.label || ''} ${row.text || ''}`);
      if (!kind || !Number.isFinite(row.value)) continue;
      const score = Number(row.confidence) || 50;
      const normalized = { kind, value: row.value, currency: row.currency || null, confidence: score, source: row.source || null, text: normalize(row.text || row.label || '').slice(0, 180) };
      result.candidates.push(normalized);
      if (!best.has(kind) || best.get(kind).confidence < score) best.set(kind, normalized);
    }
    for (const key of ['subtotal', 'shipping', 'tax', 'discount', 'total']) {
      result[key] = finite(best.get(key)?.value);
    }
    const currencies = [...best.values()].map((row) => row.currency).filter(Boolean);
    result.currency = currencies[0] || null;
    result.confidence = best.has('total') ? Math.min(100, best.get('total').confidence) : 0;
    result.candidates = result.candidates.slice(0, 30);
    return result;
  }

  function computeSaving(before, after) {
    if (!before || !after || !Number.isFinite(before.total) || !Number.isFinite(after.total)) return null;
    if (before.currency && after.currency && before.currency !== after.currency) return null;
    return Math.round((before.total - after.total) * 100) / 100;
  }

  function buildFinancialSnapshot(input = {}) {
    const source = input?.breakdown || input || {};
    return {
      subtotal: finite(source.subtotal),
      shipping: finite(source.shipping),
      tax: finite(source.tax),
      discount: finite(source.discount),
      total: finite(source.total),
      currency: source.currency || null
    };
  }

  function financialSignature(input = {}) {
    return stableHash(JSON.stringify(buildFinancialSnapshot(input)));
  }

  function financialBaselineMatches(baseline, current, tolerance = 0.01) {
    if (!baseline || !current || !Number.isFinite(baseline.total) || !Number.isFinite(current.total)) return false;
    if ((baseline.currency || null) !== (current.currency || null)) return false;
    if (Math.abs(baseline.total - current.total) > tolerance) return false;
    for (const key of ['subtotal', 'shipping', 'tax', 'discount']) {
      if (Number.isFinite(baseline[key]) && Number.isFinite(current[key]) && Math.abs(baseline[key] - current[key]) > tolerance) return false;
    }
    return true;
  }

  const isBaselineRestored = financialBaselineMatches;

  function buildCheckoutFingerprint(input = {}) {
    const sourceItems = Array.isArray(input.items) ? input.items : [];
    const items = sourceItems.map((row) => ({
      itemId: row?.itemId ? String(row.itemId) : null,
      skuId: row?.skuId ? String(row.skuId) : null,
      quantity: row?.quantity !== null && row?.quantity !== undefined && row?.quantity !== '' && Number.isFinite(Number(row.quantity)) ? Number(row.quantity) : null,
      sellerId: row?.sellerId ? String(row.sellerId) : null
    })).filter((row) => row.itemId || row.skuId || row.quantity !== null || row.sellerId)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const hasCompleteIdentity = items.length > 0 && items.every((row) => row.itemId && row.skuId && row.quantity !== null);
    const hasPartialIdentity = items.length > 0 && items.every((row) => row.itemId || row.skuId || sourceItems.some((source) => source?.rootEvidence));
    const quality = hasCompleteIdentity ? 'STRONG' : hasPartialIdentity ? 'MEDIUM' : 'WEAK';
    const componentsUsed = [];
    if (input.currency || input.breakdown?.currency) componentsUsed.push('currency');
    if (items.some((row) => row.itemId)) componentsUsed.push('items.itemId');
    if (items.some((row) => row.skuId)) componentsUsed.push('items.skuId');
    if (items.some((row) => row.quantity !== null)) componentsUsed.push('items.quantity');
    if (items.some((row) => row.sellerId)) componentsUsed.push('items.sellerId');
    if (input.shippingMethodId) componentsUsed.push('shippingMethodId');
    const canonical = {
      currency: input.currency || input.breakdown?.currency || null,
      items,
      shippingMethodId: normalize(input.shippingMethodId || '') || null
    };
    return { ...canonical, signature: stableHash(JSON.stringify(canonical)), quality, componentsUsed };
  }

  function sameCheckoutFingerprint(left, right) {
    if (!left || !right) return false;
    const a = left.signature || buildCheckoutFingerprint(left).signature;
    const b = right.signature || buildCheckoutFingerprint(right).signature;
    return a === b;
  }

  function checkoutBinding(urlString, pageType = null) {
    try {
      const url = new URL(urlString);
      const checkoutRoute = /(?:^|\/)checkout(?:\/|$)|\/trade\/(?:order\/)?confirm(?:\.html)?(?:\/|$)|\/order\/confirm(?:ation)?(?:\.html)?(?:\/|$)|\/order\/create(?:\.html)?(?:\/|$)/i;
      const cartRoute = /(?:^|\/)(?:shoppingcart|cart)(?:\/|\.html|$)/i;
      const pathClass = String(pageType || '').toUpperCase() || (checkoutRoute.test(url.pathname) ? 'CHECKOUT' : cartRoute.test(url.pathname) ? 'CART' : 'OTHER');
      const normalizedPath = url.pathname.toLowerCase().replace(/[0-9a-f]{8,}/gi, ':id').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
      return { origin: url.origin, pageClass: pathClass, pathClass: normalizedPath };
    } catch (_) { return { origin: null, pageClass: pageType || null, pathClass: null }; }
  }

  function requiresRemovalBeforeNext(result) {
    return result?.verificationStatus === STATUS.VALID_APPLIED || !!result?.appliedEvidence;
  }

  function isBestEligible(result) {
    return result?.verified === true && result?.verificationStatus === STATUS.VALID_APPLIED &&
      Number.isFinite(result?.saving) && result.saving > 0 && result?.baselineRestored === true;
  }

  function textOutcome(text) {
    const value = normalize(text).toLowerCase();
    const rules = [
      [STATUS.CAPTCHA, /(captcha|провер(?:ка|ьте).*(?:робот|безопасност)|security\s*verification|verify\s*(?:you|human)|滑块|验证码)/i],
      [STATUS.RATE_LIMITED, /(too\s*many|слишком\s*много\s*попыт|try\s*again\s*later|повторите\s*позже|rate\s*limit|frequent\s*request|请求频繁)/i],
      [STATUS.EXPIRED, /(expired|ист[её]к|срок.*(?:ист[её]к|законч)|больше\s*не\s*действ)/i],
      [STATUS.NOT_STARTED, /(not\s*started|ещ[её]\s*не\s*(?:начал|действ)|starts?\s*(?:on|at)|будет\s*действ)/i],
      [STATUS.MINIMUM_SPEND_NOT_MET, /(minimum|min\.?\s*spend|order\s*amount|минимальн.*сумм|сумма.*(?:недостат|меньше)|доберите|необходимо.*(?:потратить|заказ))/i],
      [STATUS.NOT_APPLICABLE_TO_ITEMS, /(not\s*applicable|does(?:n't| not)\s*apply|eligible\s*items|не\s*применим|не\s*подходит.*товар|товар.*не\s*участв)/i],
      [STATUS.REGION_RESTRICTED, /(region|country|location|регион|стран|недоступен.*(?:регион|стран)|not\s*available\s*in)/i],
      [STATUS.ACCOUNT_RESTRICTED, /(new\s*user|selected\s*(?:user|account)|account.*(?:not\s*eligible|restricted)|только.*нов.*польз|аккаунт.*не\s*соответ|персональн)/i],
      [STATUS.ALREADY_USED, /(already\s*used|used\s*before|уже\s*использован|ранее\s*использ)/i],
      [STATUS.OUT_OF_STOCK, /(fully\s*redeemed|redemption.*limit|out\s*of\s*stock|законч(?:ил|ились)|исчерпан|лимит.*исчерпан|все\s*купон)/i],
      [STATUS.NOT_COLLECTED, /(collect\s*(?:the\s*)?(?:coupon|code)\s*first|not\s*collected|сначала.*получ|купон.*не\s*получен)/i],
      [STATUS.INVALID, /(invalid|incorrect|not\s*valid|неверн|недейств|такого\s*код|код.*не\s*найден)/i]
    ];
    for (const [status, pattern] of rules) if (pattern.test(value)) return status;
    return null;
  }

  function classifyVerification({ text = '', before = null, after = null, appliedIndicator = false } = {}) {
    const saving = computeSaving(before, after);
    const textual = textOutcome(text);
    if ([STATUS.CAPTCHA, STATUS.RATE_LIMITED].includes(textual)) {
      return { status: textual, verified: false, saving, reason: 'SAFETY_STOP' };
    }
    if (appliedIndicator && Number.isFinite(saving) && saving > 0) {
      return { status: STATUS.VALID_APPLIED, verified: true, saving, reason: 'APPLIED_AND_TOTAL_DECREASED' };
    }
    if (textual && textual !== STATUS.VALID_APPLIED) {
      return { status: textual, verified: true, saving, reason: 'SITE_RESPONSE' };
    }
    if (appliedIndicator && (!Number.isFinite(saving) || saving <= 0)) {
      return { status: STATUS.UNKNOWN_ERROR, verified: false, saving, reason: 'APPLIED_WITHOUT_CONFIRMED_SAVING' };
    }
    if (Number.isFinite(saving) && saving > 0) {
      return { status: STATUS.UNKNOWN_ERROR, verified: false, saving, reason: 'TOTAL_CHANGED_WITHOUT_APPLIED_INDICATOR' };
    }
    return { status: STATUS.UNKNOWN_ERROR, verified: false, saving, reason: 'NO_CONCLUSIVE_SIGNAL' };
  }

  function resultRank(result) {
    if (result?.verified && result.verificationStatus === STATUS.VALID_APPLIED && result.saving > 0) return 400000 + result.saving;
    if ([null, STATUS.MINIMUM_SPEND_NOT_MET, STATUS.NOT_COLLECTED].includes(result?.verificationStatus)) return 300000;
    if (result?.verificationStatus === STATUS.UNKNOWN_ERROR) return 100000;
    return 200000;
  }

  function sortVerificationResults(results = []) {
    return results.slice().sort((a, b) => resultRank(b) - resultRank(a) || String(a.code || '').localeCompare(String(b.code || '')));
  }

  globalThis.CouponHunterCheckoutCore = {
    STATES, STATUS, normalize, emptyBreakdown, classifySummaryLabel, buildBreakdown,
    buildFinancialSnapshot, financialSignature, computeSaving, financialBaselineMatches, isBaselineRestored, buildCheckoutFingerprint, sameCheckoutFingerprint, checkoutBinding,
    requiresRemovalBeforeNext, isBestEligible,
    textOutcome, classifyVerification, sortVerificationResults
  };
})();
