(() => {
  'use strict';
  if (globalThis.CouponHunterParser?.parserVersion === '3.3.2') return;

  const PARSER_VERSION = '3.3.2';
  const PROMOTION_TYPES = Object.freeze({
    PLATFORM_PROMO_CODE: 'PLATFORM_PROMO_CODE', ALIEXPRESS_COUPON: 'ALIEXPRESS_COUPON',
    SELLER_COUPON: 'SELLER_COUPON', STORE_DISCOUNT: 'STORE_DISCOUNT', SELECT_COUPON: 'SELECT_COUPON',
    COINS: 'COINS', EVENT_DISCOUNT: 'EVENT_DISCOUNT', INSTANT_DISCOUNT: 'INSTANT_DISCOUNT',
    NEW_USER_DISCOUNT: 'NEW_USER_DISCOUNT', UNKNOWN: 'UNKNOWN'
  });
  const CURRENCIES = [
    { code: 'RUB', token: '(?:₽|RUB|RUR|руб\\.?)' },
    { code: 'USD', token: '(?:US\\s*\\$|USD|\\$)' },
    { code: 'EUR', token: '(?:EUR|€)' }
  ];
  const NUMBER = '[0-9][0-9\\s\\u00A0\\u202F.,]*[0-9]|[0-9]';
  const normalizeSpace = (value = '') => String(value).replace(/[\s\u00A0\u202F]+/g, ' ').trim();

  function parseLocalizedNumber(value) {
    let text = String(value || '').replace(/[\s\u00A0\u202F]/g, '').replace(/[^0-9.,-]/g, '');
    if (!text || !/\d/.test(text)) return null;
    const negative = text.startsWith('-');
    text = text.replace(/-/g, '');
    const separator = Math.max(text.lastIndexOf('.'), text.lastIndexOf(','));
    let normalized;
    if (separator >= 0) {
      const fractionLength = text.length - separator - 1;
      const decimal = fractionLength > 0 && fractionLength <= 2;
      normalized = decimal
        ? text.slice(0, separator).replace(/[.,]/g, '') + '.' + text.slice(separator + 1).replace(/[.,]/g, '')
        : text.replace(/[.,]/g, '');
    } else normalized = text;
    const number = Number(normalized) * (negative ? -1 : 1);
    return Number.isFinite(number) && Math.abs(number) <= 100_000_000 ? number : null;
  }

  function rangesOverlap(aStart, aLength, bStart, bLength) {
    return Math.max(aStart, bStart) < Math.min(aStart + aLength, bStart + bLength);
  }

  function extractPriceQuotes(text, source = 'TEXT', defaultCurrency = null) {
    const input = normalizeSpace(text);
    const quotes = [];
    const add = (row) => {
      if (!Number.isFinite(row.value) && !Number.isFinite(row.min)) return;
      if (!row.isRange && quotes.some((x) => x.isRange && x.currency === row.currency && rangesOverlap(x.index, x.raw.length, row.index, row.raw.length) && (x.min === row.value || x.max === row.value))) return;
      if (quotes.some((x) => x.currency === row.currency && x.value === row.value && x.min === row.min && x.max === row.max && rangesOverlap(x.index, x.raw.length, row.index, row.raw.length))) return;
      quotes.push(row);
    };
    for (const currency of CURRENCIES) {
      const repeatedPrefixRange = new RegExp(`(${currency.token})\\s*(${NUMBER})\\s*(?:[-–—]|до|to)\\s*(?:${currency.token})\\s*(${NUMBER})`, 'giu');
      const repeatedSuffixRange = new RegExp(`(${NUMBER})\\s*(?:${currency.token})\\s*(?:[-–—]|до|to)\\s*(${NUMBER})\\s*(${currency.token})`, 'giu');
      const suffixRange = new RegExp(`(${NUMBER})\\s*(?:[-–—]|до|to)\\s*(${NUMBER})\\s*(${currency.token})`, 'giu');
      const prefixRange = new RegExp(`(${currency.token})\\s*(${NUMBER})\\s*(?:[-–—]|до|to)\\s*(${NUMBER})`, 'giu');
      const suffix = new RegExp(`(${NUMBER})\\s*(${currency.token})`, 'giu');
      const prefix = new RegExp(`(${currency.token})\\s*(${NUMBER})`, 'giu');
      let match;
      while ((match = repeatedPrefixRange.exec(input))) {
        const a = parseLocalizedNumber(match[2]); const b = parseLocalizedNumber(match[3]);
        if (Number.isFinite(a) && Number.isFinite(b)) add({ value: null, currency: currency.code, isRange: true, min: Math.min(a, b), max: Math.max(a, b), raw: match[0], index: match.index, source, confidence: 72 });
      }
      while ((match = repeatedSuffixRange.exec(input))) {
        const a = parseLocalizedNumber(match[1]); const b = parseLocalizedNumber(match[2]);
        if (Number.isFinite(a) && Number.isFinite(b)) add({ value: null, currency: currency.code, isRange: true, min: Math.min(a, b), max: Math.max(a, b), raw: match[0], index: match.index, source, confidence: 72 });
      }
      while ((match = suffixRange.exec(input))) {
        const a = parseLocalizedNumber(match[1]); const b = parseLocalizedNumber(match[2]);
        if (Number.isFinite(a) && Number.isFinite(b)) add({ value: null, currency: currency.code, isRange: true, min: Math.min(a, b), max: Math.max(a, b), raw: match[0], index: match.index, source, confidence: 70 });
      }
      while ((match = prefixRange.exec(input))) {
        const a = parseLocalizedNumber(match[2]); const b = parseLocalizedNumber(match[3]);
        if (Number.isFinite(a) && Number.isFinite(b)) add({ value: null, currency: currency.code, isRange: true, min: Math.min(a, b), max: Math.max(a, b), raw: match[0], index: match.index, source, confidence: 70 });
      }
      while ((match = suffix.exec(input))) {
        const value = parseLocalizedNumber(match[1]);
        add({ value, currency: currency.code, isRange: false, min: value, max: value, raw: match[0], index: match.index, source, confidence: 75 });
      }
      while ((match = prefix.exec(input))) {
        const value = parseLocalizedNumber(match[2]);
        add({ value, currency: currency.code, isRange: false, min: value, max: value, raw: match[0], index: match.index, source, confidence: 75 });
      }
    }
    if (!quotes.length && /^\s*[0-9][0-9\s\u00A0\u202F.,]*\s*$/.test(input)) {
      const value = parseLocalizedNumber(input);
      if (Number.isFinite(value)) add({ value, currency: defaultCurrency, isRange: false, min: value, max: value, raw: input, index: 0, source, confidence: 38 });
    }
    return quotes.sort((a, b) => a.index - b.index || Number(a.isRange) - Number(b.isRange));
  }

  function extractMoney(text) {
    const out = [];
    for (const quote of extractPriceQuotes(text)) {
      if (quote.isRange) {
        out.push({ value: quote.min, currency: quote.currency, raw: quote.raw, index: quote.index, isRange: true });
        if (quote.max !== quote.min) out.push({ value: quote.max, currency: quote.currency, raw: quote.raw, index: quote.index, isRange: true });
      } else out.push({ value: quote.value, currency: quote.currency, raw: quote.raw, index: quote.index, isRange: false });
    }
    return out;
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function safeSnippet(el) {
    if (!el) return null;
    return {
      tag: String(el.tagName || '').toLowerCase(), id: String(el.id || '').slice(0, 60) || null,
      class: typeof el.className === 'string' ? el.className.slice(0, 120) : null,
      text: normalizeSpace(el.innerText || el.textContent || '').slice(0, 180) || null,
      ariaLabel: normalizeSpace(el.getAttribute?.('aria-label') || '').slice(0, 120) || null
    };
  }

  function parseItemId(urlString) {
    try {
      const url = new URL(urlString);
      return url.pathname.match(/\/item\/(\d+)(?:\.html)?/i)?.[1] || url.searchParams.get('item_id') || url.searchParams.get('productId') || null;
    } catch (_) { return null; }
  }

  function selectedSkuInfo(doc, urlString) {
    let urlSku = null;
    try { const url = new URL(urlString); urlSku = url.searchParams.get('sku_id') || url.searchParams.get('skuId'); } catch (_) {}
    const selectors = [
      '[data-sku-id][aria-checked="true"]', '[data-sku-id][aria-selected="true"]', '[data-sku-id][data-selected="true"]',
      '[data-sku-id].selected', '[data-sku-id][class*="selected" i]', '[data-sku-id][class*="active" i]'
    ];
    let selected = null;
    for (const selector of selectors) { selected = doc.querySelector(selector); if (selected) break; }
    const domSku = selected?.getAttribute('data-sku-id') || selected?.getAttribute('data-sku') || null;
    const skuId = domSku || urlSku || null;
    const labels = [];
    const add = (value) => {
      const text = normalizeSpace(value).replace(/^(?:цвет|color|вариант|variation|комплектация|configuration|версия|version|размер|size)\s*:\s*/i, '');
      if (text && text.length <= 100 && !/^(true|selected|выбрано)$/i.test(text) && !labels.includes(text)) labels.push(text);
    };
    if (selected) add(selected.getAttribute('title') || selected.getAttribute('aria-label') || selected.textContent);
    for (const el of Array.from(doc.querySelectorAll('div,span,p,label')).slice(0, 4500)) {
      const text = normalizeSpace(el.textContent || '');
      const match = text.match(/^(?:цвет|color|вариант|variation|комплектация|configuration|версия|version|размер|size)\s*:\s*(.{1,100})$/i);
      if (match && isVisible(el)) add(match[1]);
      if (labels.length >= 4) break;
    }
    return {
      skuId, urlSkuId: urlSku, domSkuId: domSku,
      selectionConflict: !!(urlSku && domSku && String(urlSku) !== String(domSku)),
      selectedVariant: labels.join(' · ') || null, hasExplicitSelection: !!selected || !!urlSku, element: selected
    };
  }

  function localContext(el, limit = 320) {
    let node = el; let best = normalizeSpace(el?.textContent || '');
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const text = normalizeSpace(node.textContent || '');
      if (text && text.length <= limit) best = text; else if (text.length > limit) break;
    }
    return best;
  }

  function isOldPrice(el) {
    if (/^(DEL|S)$/i.test(el?.tagName || '')) return true;
    let node = el;
    for (let i = 0; node && i < 3; i++, node = node.parentElement) {
      const decoration = getComputedStyle(node).textDecorationLine || getComputedStyle(node).textDecoration || '';
      if (/line-through/i.test(decoration)) return true;
    }
    return false;
  }

  function isRecommendation(el) {
    let node = el;
    for (let i = 0; node && i < 6; i++, node = node.parentElement) {
      const signature = `${node.id || ''} ${node.className || ''} ${node.getAttribute?.('data-widget-cid') || ''} ${node.getAttribute?.('aria-label') || ''}`;
      if (/(recommend|related|similar|also.like|more.to.love|рекоменд|похож|с этим покуп)/i.test(signature)) return true;
    }
    return false;
  }

  function addPriceCandidate(list, candidate) {
    const reference = candidate.isRange ? candidate.min : candidate.value;
    if (!Number.isFinite(reference) || reference <= 0 || reference > 100_000_000) return;
    const key = `${candidate.source}|${candidate.currency}|${candidate.isRange ? `${candidate.min}-${candidate.max}` : candidate.value}|${candidate.skuId || ''}`;
    if (!list.some((row) => row.key === key)) list.push({ ...candidate, key });
  }

  function structuredNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    return parseLocalizedNumber(value);
  }

  function walkStructured(value, path, out, inherited = {}) {
    if (!value || typeof value !== 'object' || path.length > 260) return;
    if (Array.isArray(value)) { value.slice(0, 200).forEach((row, i) => walkStructured(row, `${path}[${i}]`, out, inherited)); return; }
    const ownSku = value.skuId || value.sku_id || value.skuID || null;
    const skuId = ownSku ? String(ownSku) : inherited.skuId;
    const currency = String(value.priceCurrency || value.currency || value.currencyCode || inherited.currency || '').toUpperCase() || null;
    for (const [key, raw] of Object.entries(value)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (/^(?:price|salePrice|currentPrice|skuPrice|activityPrice|discountPrice|lowPrice|highPrice)$/i.test(key) && !/(shipping|delivery|tax|installment|coupon|discountAmount|saving|recommend)/i.test(nextPath)) {
        const number = structuredNumber(typeof raw === 'object' ? raw?.value ?? raw?.amount : raw);
        if (Number.isFinite(number)) out.push({ value: number, currency, skuId, path: nextPath, key });
      }
      if (raw && typeof raw === 'object') walkStructured(raw, nextPath, out, { skuId, currency });
    }
  }

  function balancedJsonAt(text, start) {
    const opening = text[start]; if (!'{['.includes(opening)) return null;
    const stack = [opening]; let string = false; let escaped = false;
    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];
      if (string) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') string = false;
        continue;
      }
      if (char === '"') { string = true; continue; }
      if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        const expected = char === '}' ? '{' : '[';
        if (stack.pop() !== expected) return null;
        if (!stack.length) return text.slice(start, index + 1);
      }
    }
    return null;
  }

  function parseJsonScripts(script) {
    const text = String(script.textContent || '').trim();
    if (!text || text.length > 1_000_000) return [];
    try { return [JSON.parse(text)]; } catch (_) {}
    const starts = [];
    const assignment = /(?:^|[=;])\s*([\[{])/g; let match;
    while ((match = assignment.exec(text)) && starts.length < 24) starts.push(match.index + match[0].lastIndexOf(match[1]));
    const payloads = [];
    for (const start of starts) {
      const raw = balancedJsonAt(text, start); if (!raw) continue;
      try { payloads.push(JSON.parse(raw)); } catch (_) {}
    }
    return payloads;
  }

  function collectStructuredPriceCandidates(doc, sku) {
    const list = [];
    const declaredCurrency = normalizeSpace(doc.querySelector('meta[itemprop="priceCurrency"]')?.getAttribute('content') || doc.querySelector('meta[property="product:price:currency"]')?.getAttribute('content') || '').toUpperCase() || null;
    const metaSelectors = ['meta[itemprop="price"]', 'meta[property="product:price:amount"]', 'meta[property="og:price:amount"]'];
    for (const selector of metaSelectors) for (const el of doc.querySelectorAll(selector)) {
      const value = structuredNumber(el.getAttribute('content'));
      if (Number.isFinite(value)) addPriceCandidate(list, { value, min: value, max: value, isRange: false, currency: declaredCurrency || null, source: 'STRUCTURED_META', confidence: 82, raw: el.getAttribute('content'), path: selector, skuId: null, skuAssociation: 'NONE' });
    }
    let bytes = 0;
    for (const script of Array.from(doc.querySelectorAll('script')).slice(0, 140)) {
      const text = String(script.textContent || ''); bytes += Math.min(text.length, 1_000_000); if (bytes > 7_000_000) break;
      for (const data of parseJsonScripts(script)) {
        const rows = []; walkStructured(data, script.type === 'application/ld+json' ? 'ldjson' : 'hydration', rows);
        for (const row of rows.slice(0, 800)) {
          let confidence = /ldjson.*offers?.*price/i.test(row.path) ? 86 : 64;
          if (row.skuId && sku.skuId && String(row.skuId) === String(sku.skuId)) confidence += 26;
          else if (row.skuId && sku.skuId) confidence -= 40;
          if (/highPrice/i.test(row.key)) confidence -= 12;
          const skuAssociation = row.skuId && sku.skuId && String(row.skuId) === String(sku.skuId) ? 'EXPLICIT' : 'NONE';
          addPriceCandidate(list, { value: row.value, min: row.value, max: row.value, isRange: false, currency: row.currency || declaredCurrency || null, source: /ldjson/.test(row.path) ? 'LD_JSON' : 'HYDRATION_JSON', confidence, raw: String(row.value), path: row.path, skuId: row.skuId || null, skuAssociation });
        }
      }
    }
    return list;
  }

  function collectDomPriceCandidates(doc, sku) {
    const list = [];
    const title = doc.querySelector('h1');
    const selectors = ['[data-pl="product-price"]', '[data-widget-cid*="price" i]', '[data-spm-anchor-id*="price" i]', '[class*="product-price" i]', '[class*="sale-price" i]', '[class*="price--current" i]', '[class*="price-current" i]', '[class*="price" i]'];
    const semanticSelectors = ['[aria-label*="price" i]', '[aria-label*="цена" i]', '[role="status"]'];
    const visited = new Set();
    const defaultCurrency = normalizeSpace(doc.querySelector('meta[itemprop="priceCurrency"]')?.getAttribute('content') || doc.querySelector('meta[property="product:price:currency"]')?.getAttribute('content') || '').toUpperCase() || null;
    const explicitSkuFor = (element) => {
      let node = element;
      for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
        const value = node.getAttribute?.('data-sku-id') || node.getAttribute?.('data-sku') || node.getAttribute?.('data-variant-id');
        if (value) return String(value);
      }
      return null;
    };
    const scan = (selector, sourceBase) => {
      let nodes = []; try { nodes = Array.from(doc.querySelectorAll(selector)).slice(0, 900); } catch (_) {}
      for (const el of nodes) {
        if (visited.has(el)) continue; visited.add(el);
        const text = normalizeSpace(el.textContent || el.getAttribute?.('aria-label') || '');
        if (!text || text.length > 260) continue;
        for (const quote of extractPriceQuotes(text, sourceBase, defaultCurrency)) {
          let confidence = sourceBase === 'VISIBLE_DOM' ? 42 : 48;
          const visible = isVisible(el); if (visible) confidence += 20;
          const signature = `${el.className || ''} ${el.getAttribute?.('data-pl') || ''} ${el.getAttribute?.('data-widget-cid') || ''}`;
          if (/(product.price|sale.price|current|price--current)/i.test(signature)) confidence += 24;
          const context = localContext(el);
          if (/(shipping|delivery|достав|почт|курьер|самовывоз)/i.test(context)) confidence -= 75;
          if (/(tax|vat|ндс|налог|пошлин|тамож)/i.test(context)) confidence -= 70;
          if (/(cashback|кэшбэк|coins?|монет|купон|coupon|promo|промокод|эконом)/i.test(context)) confidence -= 48;
          if (/(installment|pay\s*in\s*\d|рассроч|в месяц|\/\s*мес)/i.test(context)) confidence -= 65;
          if (isOldPrice(el)) confidence -= 65;
          const recommendation = isRecommendation(el); if (recommendation) confidence -= 100;
          if (quote.isRange && sku.hasExplicitSelection) confidence -= 45;
          if (title && visible) {
            const a = el.getBoundingClientRect(); const b = title.getBoundingClientRect();
            const distance = Math.abs(a.top - b.top) + Math.abs(a.left - b.left) * 0.15;
            if (distance < 500) confidence += 14; else if (distance > 1600) confidence -= 12;
          }
          const font = visible ? parseFloat(getComputedStyle(el).fontSize) || 0 : 0;
          if (font >= 24) confidence += 22; else if (font >= 18) confidence += 10;
          const elementSkuId = explicitSkuFor(el);
          const skuAssociation = elementSkuId && sku.skuId && elementSkuId === String(sku.skuId) ? 'EXPLICIT' : sku.hasExplicitSelection && !elementSkuId ? 'INFERRED' : 'NONE';
          if (elementSkuId && sku.skuId && elementSkuId !== String(sku.skuId)) confidence -= 55;
          if (skuAssociation === 'EXPLICIT') confidence += 10;
          addPriceCandidate(list, { ...quote, source: sourceBase, confidence, raw: quote.raw, context: context.slice(0, 220), selector, skuId: elementSkuId, skuAssociation, recommendation, oldPrice: isOldPrice(el), snippet: safeSnippet(el) });
        }
      }
    };
    selectors.forEach((selector) => scan(selector, 'VISIBLE_DOM'));
    semanticSelectors.forEach((selector) => scan(selector, 'SEMANTIC_DOM'));
    return list;
  }

  function pickPriceCandidate(candidates, sku) {
    if (!candidates.length) return null;
    const scored = candidates.map((row) => {
      const confirmations = candidates.filter((other) => other.currency === row.currency && !other.isRange && !row.isRange && Math.abs(other.value - row.value) < 0.01 && other.source !== row.source).length;
      return { ...row, confidence: Math.max(0, Math.min(100, row.confidence + Math.min(12, confirmations * 4))) };
    });
    const exact = scored.filter((row) => !row.isRange && row.confidence >= 45 && !row.recommendation);
    const pool = sku.hasExplicitSelection && exact.length ? exact : scored.filter((row) => row.confidence >= 20 && !row.recommendation);
    return (pool.length ? pool : scored).sort((a, b) => b.confidence - a.confidence || Number(a.isRange) - Number(b.isRange) || (a.value || a.min) - (b.value || b.min))[0];
  }

  function detectedPriceFromWinner(winner, sku) {
    if (!winner) return { value: null, currency: null, isRange: false, min: null, max: null, source: null, confidence: 0, skuAssociation: 'NONE', skuMatched: false };
    const rangeWithoutSkuPrice = winner.isRange && sku.hasExplicitSelection;
    return { value: rangeWithoutSkuPrice ? null : (winner.isRange ? winner.min : winner.value), currency: winner.currency || null, isRange: !!winner.isRange, min: winner.min ?? winner.value ?? null, max: winner.max ?? winner.value ?? null, source: winner.source, confidence: Math.round(winner.confidence), skuAssociation: winner.skuAssociation || 'NONE', skuMatched: winner.skuAssociation === 'EXPLICIT' };
  }

  function findOldPrice(doc, detectedPrice) {
    if (!Number.isFinite(detectedPrice?.value)) return null;
    const values = [];
    for (const el of Array.from(doc.querySelectorAll('del,s,[class*="old-price" i],[class*="original-price" i],[class*="price--original" i]')).slice(0, 240)) {
      if (!isVisible(el) || isRecommendation(el)) continue;
      for (const quote of extractPriceQuotes(el.textContent || '')) if (!quote.isRange && quote.currency === detectedPrice.currency && quote.value > detectedPrice.value) values.push(quote.value);
    }
    return values.length ? Math.min(...values) : null;
  }

  function stableHash(value) {
    let hash = 2166136261;
    for (const char of String(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(36);
  }

  function promotionType(title, code) {
    const text = normalizeSpace(title).toLowerCase();
    if (/select\s*coupon|спец.*купон|выбороч.*купон/.test(text)) return PROMOTION_TYPES.SELECT_COUPON;
    if (/coin|монет/.test(text)) return PROMOTION_TYPES.COINS;
    if (/new\s*user|нов.*польз|перв.*заказ/.test(text)) return PROMOTION_TYPES.NEW_USER_DISCOUNT;
    if (/seller\s*coupon|store\s*coupon|купон\s*(?:продав|магазин)/.test(text)) return PROMOTION_TYPES.SELLER_COUPON;
    if (/aliexpress\s*coupon|купон\s*aliexpress/.test(text)) return PROMOTION_TYPES.ALIEXPRESS_COUPON;
    if (code) return PROMOTION_TYPES.PLATFORM_PROMO_CODE;
    if (/instant|мгновенн/.test(text)) return PROMOTION_TYPES.INSTANT_DISCOUNT;
    if (/event|распродаж|11\.11|choice\s*day|anniversary/.test(text)) return PROMOTION_TYPES.EVENT_DISCOUNT;
    if (/store|seller|магазин|продав/.test(text) && /discount|скид/.test(text)) return PROMOTION_TYPES.STORE_DISCOUNT;
    return PROMOTION_TYPES.UNKNOWN;
  }

  function normalizePromotion(input = {}) {
    const code = input.code ? String(input.code).trim().toUpperCase() : null;
    const type = input.type || promotionType(input.title, code);
    const title = normalizeSpace(input.title || (code ? `Промокод ${code}` : 'Акция'));
    return {
      id: input.id || `promotion-${stableHash(`${type}|${code || ''}|${title}|${input.sellerId || ''}`)}`,
      code, type, title, source: input.source || 'UNKNOWN', sellerId: input.sellerId || null,
      itemId: input.itemId || null, skuId: input.skuId || null, currency: input.currency || null,
      discountAmount: Number.isFinite(input.discountAmount) ? input.discountAmount : null,
      discountPercent: Number.isFinite(input.discountPercent) ? input.discountPercent : null,
      minimumSpend: Number.isFinite(input.minimumSpend) ? input.minimumSpend : null,
      maximumDiscount: Number.isFinite(input.maximumDiscount) ? input.maximumDiscount : null,
      startAt: input.startAt || null, expiresAt: input.expiresAt || null, region: input.region || null,
      applicable: typeof input.applicable === 'boolean' ? input.applicable : null,
      collected: typeof input.collected === 'boolean' ? input.collected : null,
      verified: input.verified === true, verificationStatus: input.verificationStatus || null,
      verificationMessage: input.verificationMessage || null, priceBefore: input.priceBefore || null,
      priceAfter: input.priceAfter || null, saving: Number.isFinite(input.saving) ? input.saving : null,
      lastVerifiedAt: input.lastVerifiedAt || null, confidence: Math.max(0, Math.min(100, Number(input.confidence) || 0))
    };
  }

  function extractPromotionsFromText(text, context = {}) {
    const fragments = String(text || '').replace(/\r/g, '\n').split(/\n|[|•]/).map(normalizeSpace).filter((line) => line.length >= 4 && line.length <= 260 && /(промокод|promo\s*code|купон|coupon|voucher|скидк|discount|эконом|save\s|coin|монет)/i.test(line));
    const result = [];
    for (const title of fragments.slice(0, 300)) {
      const codeMatch = title.match(/(?:промокод|promo(?:tion)?\s*code|coupon\s*code|voucher\s*code|\bкод)\s*[:—-]?\s*([A-Z0-9][A-Z0-9_-]{3,31})\b/i);
      const code = codeMatch?.[1]?.toUpperCase() || null;
      const percent = Number(title.match(/(\d{1,2}(?:[.,]\d+)?)\s*%/)?.[1]?.replace(',', '.')) || null;
      const prices = extractPriceQuotes(title);
      const minMatch = title.match(/(?:от|over|min(?:imum)?\s*spend|при\s*(?:заказе|покупке))\s*([^;|]+)/i);
      const minQuote = minMatch ? extractPriceQuotes(minMatch[1])[0] : null;
      const minimumSpend = minQuote?.isRange ? minQuote.min : minQuote?.value ?? null;
      const discountQuote = prices.find((quote) => !minimumSpend || Math.abs((quote.value ?? quote.min) - minimumSpend) > 0.001) || null;
      const collected = /(?:получен|собран|collected|claimed)/i.test(title) ? true : /(?:получить|collect|claim)/i.test(title) ? false : null;
      result.push(normalizePromotion({ code, type: promotionType(title, code), title, source: context.source || 'TEXT_SEMANTIC', sellerId: context.sellerId, itemId: context.itemId, skuId: context.skuId, currency: discountQuote?.currency || minQuote?.currency || context.currency || null, discountAmount: discountQuote && !discountQuote.isRange ? discountQuote.value : null, discountPercent: percent, minimumSpend, collected, confidence: context.confidence || 55 }));
    }
    const map = new Map();
    for (const row of result) { const key = row.code ? `code:${row.code}` : `${row.type}:${row.title.toLowerCase()}`; if (!map.has(key) || map.get(key).confidence < row.confidence) map.set(key, row); }
    return [...map.values()];
  }

  function collectPromotions(doc, context) {
    const all = []; const selectorMatches = [];
    const groups = [
      { source: 'VISIBLE_DOM', confidence: 64, selector: '[class*="coupon" i],[class*="promo" i],[class*="discount" i],[data-pl*="coupon" i],[data-widget-cid*="promo" i]' },
      { source: 'TEXT_SEMANTIC', confidence: 70, selector: 'button,[role="button"],[aria-label*="coupon" i],[aria-label*="promo" i],[aria-label*="купон" i]' },
      { source: 'OPEN_DIALOG', confidence: 84, selector: '[role="dialog"],[role="menu"],[class*="popover" i],[class*="modal" i]' }
    ];
    for (const group of groups) {
      let nodes = []; try { nodes = Array.from(doc.querySelectorAll(group.selector)).slice(0, 300); } catch (_) {}
      let matched = 0;
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        const text = String(el.innerText || el.textContent || '');
        if (!/(promo|coupon|voucher|промокод|купон|скид|discount|coin|монет)/i.test(text)) continue;
        matched += 1; all.push(...extractPromotionsFromText(text, { ...context, source: group.source, confidence: group.confidence }));
      }
      selectorMatches.push({ selector: group.selector, source: group.source, matched });
    }
    all.push(...extractPromotionsFromText(String(doc.body?.innerText || '').slice(0, 100_000), { ...context, source: 'VISIBLE_TEXT', confidence: 48 }));
    let bytes = 0;
    for (const script of Array.from(doc.querySelectorAll('script')).slice(0, 140)) {
      const text = String(script.textContent || ''); if (!text || text.length > 1_000_000) continue;
      bytes += text.length; if (bytes > 7_000_000) break;
      if (!/(promo|coupon|voucher)/i.test(text)) continue;
      const codeRe = /["'](?:promo(?:tion)?Code|couponCode|voucherCode)["']\s*:\s*["']([A-Z0-9][A-Z0-9_-]{3,31})["']/gi;
      let match; while ((match = codeRe.exec(text))) all.push(normalizePromotion({ ...context, code: match[1], type: PROMOTION_TYPES.PLATFORM_PROMO_CODE, title: `Промокод ${match[1].toUpperCase()}`, source: 'STRUCTURED_DATA', confidence: 72 }));
    }
    const map = new Map();
    for (const row of all) { const key = row.code ? `code:${row.code}` : `${row.type}:${row.title.toLowerCase()}`; const previous = map.get(key); if (!previous || previous.confidence < row.confidence) map.set(key, row); }
    return { promotions: [...map.values()].slice(0, 50), selectorMatches };
  }

  function parseSeller(doc, baseUrl) {
    const selectors = ['[class*="store-name" i]', '[class*="shop-name" i]', 'a[href*="/store/"]', 'a[href*="storeId="]'];
    for (const selector of selectors) for (const el of Array.from(doc.querySelectorAll(selector)).slice(0, 40)) {
      if (!isVisible(el)) continue;
      const title = normalizeSpace(el.textContent || el.getAttribute('title') || '').replace(/\s*(?:рейтинг|followers?|подписчик).*$/i, '');
      let sellerId = el.getAttribute('data-store-id') || null;
      try { const url = new URL(el.href || '', baseUrl); sellerId ||= url.searchParams.get('storeId') || url.pathname.match(/\/store\/(\d+)/)?.[1] || null; } catch (_) {}
      if (title.length >= 2 && title.length <= 120) return { title, sellerId };
    }
    return { title: null, sellerId: null };
  }

  function parseTitle(doc) {
    return normalizeSpace(doc.querySelector('h1')?.textContent || doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || doc.title || '').replace(/\s*[|—-]\s*AliExpress.*$/i, '');
  }

  function parsePageType(urlString) {
    try {
      const path = new URL(urlString).pathname.toLowerCase();
      if (/\/item\//.test(path)) return 'PRODUCT';
      const checkoutRoute = /(?:^|\/)checkout(?:\/|$)|\/trade\/(?:order\/)?confirm(?:\.html)?(?:\/|$)|\/order\/confirm(?:ation)?(?:\.html)?(?:\/|$)|\/order\/create(?:\.html)?(?:\/|$)/;
      const cartRoute = /(?:^|\/)(?:shoppingcart|cart)(?:\/|\.html|$)/;
      if (checkoutRoute.test(path)) return 'CHECKOUT';
      if (cartRoute.test(path)) return 'CART';
      if (/(wholesale|search)/.test(path)) return 'SEARCH';
    } catch (_) {}
    return 'ALIEXPRESS_OTHER';
  }

  function calculateDiscount(currentPrice, oldPrice) {
    if (!Number.isFinite(currentPrice) || !Number.isFinite(oldPrice) || oldPrice <= currentPrice) return null;
    return Math.round((1 - currentPrice / oldPrice) * 100);
  }

  function parseProduct(doc = document, url = location.href) {
    const itemId = parseItemId(url); const sku = selectedSkuInfo(doc, url); const seller = parseSeller(doc, url);
    const priceCandidates = [...collectStructuredPriceCandidates(doc, sku), ...collectDomPriceCandidates(doc, sku)];
    const winner = pickPriceCandidate(priceCandidates, sku); const detectedPrice = detectedPriceFromWinner(winner, sku);
    const oldPrice = findOldPrice(doc, detectedPrice);
    const promotionData = collectPromotions(doc, { itemId, skuId: sku.skuId, sellerId: seller.sellerId, currency: detectedPrice.currency });
    const debugCandidates = priceCandidates.slice().sort((a, b) => b.confidence - a.confidence).slice(0, 30).map((row) => ({ value: row.value ?? null, currency: row.currency || null, isRange: !!row.isRange, min: row.min ?? null, max: row.max ?? null, source: row.source, confidence: Math.round(row.confidence), skuId: row.skuId || null, skuAssociation: row.skuAssociation || 'NONE', path: row.path || null, selector: row.selector || null, context: row.context || null, recommendation: !!row.recommendation, oldPrice: !!row.oldPrice, snippet: row.snippet || null }));
    return {
      pageType: parsePageType(url), itemId, skuId: sku.skuId, key: `${itemId || 'unknown'}:${sku.skuId || 'default'}`,
      title: parseTitle(doc), selectedVariant: sku.selectedVariant, seller: seller.title, sellerId: seller.sellerId,
      detectedPrice, price: detectedPrice.value, oldPrice, currency: detectedPrice.currency,
      discountPercent: calculateDiscount(detectedPrice.value, oldPrice), promotions: promotionData.promotions,
      url, locale: doc.documentElement?.lang || globalThis.navigator?.language || null, parsedAt: new Date().toISOString(),
      confidence: detectedPrice.confidence, parserVersion: PARSER_VERSION,
      debug: { winningSource: winner?.source || null, candidateCount: priceCandidates.length, priceCandidates: debugCandidates, selectorMatches: promotionData.selectorMatches, selectedSku: { skuId: sku.skuId, domSkuId: sku.domSkuId, urlSkuId: sku.urlSkuId, selectionConflict: sku.selectionConflict, selectedVariant: sku.selectedVariant, hasExplicitSelection: sku.hasExplicitSelection, snippet: safeSnippet(sku.element) } }
    };
  }

  globalThis.CouponHunterParser = { parserVersion: PARSER_VERSION, PROMOTION_TYPES, normalizeSpace, parseLocalizedNumber, extractPriceQuotes, extractMoney, parseItemId, selectedSkuInfo, normalizePromotion, extractPromotionsFromText, calculateDiscount, parsePageType, parseProduct, safeSnippet };
})();
