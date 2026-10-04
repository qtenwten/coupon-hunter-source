(() => {
  'use strict';
  if (window.__COUPON_HUNTER_PROMO_TESTER_V300__) return;
  window.__COUPON_HUNTER_PROMO_TESTER_V300__ = true;

  const P = globalThis.CouponHunterParser;
  const C = globalThis.CouponHunterCheckoutCore;
  const Store = globalThis.CouponHunterStorage;
  const Safety = globalThis.CouponHunterSafety;
  const Engine = globalThis.CouponHunterVerifierEngine;
  const Limits = globalThis.CouponHunterPromoConstants || { HARD_LIVE_ATTEMPT_LIMIT: 50 };
  const MAX_CODES = Limits.HARD_LIVE_ATTEMPT_LIMIT;
  const APPLY_WORD = /(?:^|\b|\s)(?:apply|redeem|use|применить|активировать|использовать)(?:\b|\s|$)/i;
  const REMOVE_WORD = /(?:^|\b|\s)(?:remove|clear|delete|удалить|убрать|очистить)(?:\b|\s|$)/i;
  const PROMO_WORD = /(?:promo(?:\s*code)?|coupon|voucher|discount(?:\s*code)?|code|промокод|купон|скидк|код\s*скидки)/i;
  const NEGATIVE_APPLY = /(?:coins?|points?|balance|rewards?|bonus|gift\s*card|credit|loan|address|job|application|монет|балл|баланс|бонус|наград|подарочн(?:ая|ой)\s*карт|сертификат|кредит|адрес|заявк)/i;
  const APPLIED_TEXT = /(?:promo(?:\s*code)?|coupon|voucher|discount|промокод|купон|скидк).{0,40}(?:applied|active|selected|примен[её]н|активирован|выбран)|(?:applied|примен[её]н[ао]?).{0,40}(?:promo|coupon|voucher|discount|промокод|купон|скидк)/i;
  let running = false;
  let cancelRequested = false;
  let summaryRootCache = null;

  const normalize = C.normalize;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function sanitizeFeedback(value) {
    return normalize(value)
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email hidden]')
      .replace(/(?:\+?\d[\s()-]*){10,16}/g, '[phone hidden]')
      .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[number hidden]')
      .slice(0, 3000);
  }

  function normalizeCodes(value) {
    const values = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
    return [...new Set(values.map((row) => typeof row === 'object' ? Store.normalizeCode(row.code) : Store.normalizeCode(row)).filter(Boolean))].slice(0, MAX_CODES);
  }

  function normalizeCandidateQueue(rows = []) {
    const order = []; const map = new Map();
    for (const raw of rows) {
      const normalized = Store.candidate(raw); if (!normalized || map.has(normalized.code)) continue;
      const row = { ...raw, ...normalized }; order.push(row.code); map.set(row.code, row);
      if (order.length >= MAX_CODES) break;
    }
    return order.map((code) => map.get(code));
  }

  function inputScore(input) {
    const signature = normalize([input.name, input.id, input.placeholder, input.autocomplete, input.getAttribute?.('aria-label'), input.getAttribute?.('data-testid')].filter(Boolean).join(' ')).toLowerCase();
    let score = 0;
    if (/promo|promocode|promotion/.test(signature)) score += 110;
    if (/coupon|voucher|купон/.test(signature)) score += 95;
    if (/промокод|код скидки|discount code/.test(signature)) score += 120;
    if (/gift|card|сертификат|address|phone|email|payment/.test(signature)) score -= 180;
    if (['text', 'search', ''].includes(input.type || '')) score += 15;
    if (Safety.isVisible(input) && !input.disabled && !input.readOnly) score += 40;
    return score;
  }

  function findPromoInput() {
    return Array.from(document.querySelectorAll('input')).map((element) => ({ element, score: inputScore(element) }))
      .filter((row) => row.score >= 100).sort((a, b) => b.score - a.score)[0]?.element || null;
  }

  function scopedControls(input) {
    const result = []; let node = input?.parentElement;
    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      result.push(...Array.from(node.querySelectorAll?.('button,[role="button"],input[type="submit"]') || []));
      if (/^(FORM|SECTION|ASIDE)$/i.test(node.tagName || '')) break;
    }
    return [...new Set(result)];
  }

  function localControlContext(control, depthLimit = 3) {
    const parts = []; let node = control;
    for (let depth = 0; node && depth < depthLimit; depth += 1, node = node.parentElement) {
      const text = normalize(node.innerText || node.textContent || '');
      if (text && text.length <= 700) parts.push(text);
    }
    return normalize(parts.join(' '));
  }

  function scoreApplyControl(control, input, scoped = null) {
    const label = Safety.labelOf(control); const context = localControlContext(control);
    if (!Safety.isVisible(control) || control.disabled || control.getAttribute?.('aria-disabled') === 'true') return -Infinity;
    const explicitPromoAction = PROMO_WORD.test(label);
    if (Safety.isForbiddenActionLabel(label) || !APPLY_WORD.test(label) || NEGATIVE_APPLY.test(label) || (!explicitPromoAction && NEGATIVE_APPLY.test(context))) return -Infinity;
    let score = 55;
    if (explicitPromoAction) score += 100;
    if (PROMO_WORD.test(context)) score += 35;
    if ((scoped || scopedControls(input)).includes(control)) score += 45;
    if (/^(?:apply|redeem|use|применить|активировать|использовать)$/i.test(label)) score += 15;
    return score;
  }

  function findApplyButton(input) {
    const scoped = scopedControls(input);
    return scoped.map((element) => ({ element, score: scoreApplyControl(element, input, scoped) }))
      .filter((row) => row.score >= 90).sort((a, b) => b.score - a.score)[0]?.element || null;
  }

  function scoreRemoveControl(control, { code = null, input = null, scoped = null } = {}) {
    const label = Safety.labelOf(control); const context = localControlContext(control, 4); const upper = String(code || '').toUpperCase();
    if (!Safety.isVisible(control) || control.disabled || control.getAttribute?.('aria-disabled') === 'true') return -Infinity;
    if (Safety.isForbiddenActionLabel(label) || !REMOVE_WORD.test(label)) return -Infinity;
    let score = 50;
    if (PROMO_WORD.test(label)) score += 55;
    if (PROMO_WORD.test(context)) score += 55;
    if (upper && context.toUpperCase().includes(upper)) score += 55;
    if (input && (scoped || scopedControls(input)).includes(control)) score += 25;
    return score;
  }

  function findRemoveButton(code, input = findPromoInput()) {
    const scoped = input ? scopedControls(input) : [];
    return Array.from(document.querySelectorAll('button,[role="button"],a')).slice(0, 1400)
      .map((element) => ({ element, score: scoreRemoveControl(element, { code, input, scoped }) }))
      .filter((row) => row.score >= 100).sort((a, b) => b.score - a.score)[0]?.element || null;
  }

  function findRevealControl() {
    return Array.from(document.querySelectorAll('button,[role="button"],summary')).slice(0, 1200).find((element) => {
      const label = Safety.labelOf(element);
      return Safety.isVisible(element) && label.length <= 120 && PROMO_WORD.test(label) && !Safety.isForbiddenActionLabel(label);
    }) || null;
  }

  async function ensurePromoInput() {
    let input = findPromoInput(); if (input) return input;
    const reveal = findRevealControl(); if (!reveal) return null;
    Safety.safeClick(reveal, { purpose: 'Открытие поля промокода', intent: 'PROMO_SURFACE', requirePattern: PROMO_WORD });
    await waitForCondition(() => findPromoInput(), 4000); input = findPromoInput(); return input;
  }

  function nativeSetInput(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function waitForDomSignal(timeoutMs = 350) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (reason) => { if (done) return; done = true; observer.disconnect(); clearTimeout(timer); resolve(reason); };
      const observer = new MutationObserver(() => { summaryRootCache = null; finish('mutation'); });
      observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'aria-live', 'aria-busy', 'aria-checked', 'disabled', 'value'] });
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
    });
  }

  async function waitForCondition(predicate, timeoutMs = 6000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) { const value = predicate(); if (value) return value; await waitForDomSignal(350); }
    return null;
  }

  function summaryRoots() {
    if (summaryRootCache?.every((element) => element?.isConnected !== false)) return summaryRootCache;
    const selector = '[data-testid*="summary" i],[data-pl*="summary" i],[data-pl*="total" i],[class*="order-summary" i],[class*="checkout-summary" i],[aria-label*="order summary" i]';
    summaryRootCache = Array.from(document.querySelectorAll(selector)).filter(Safety.isVisible).slice(0, 80);
    return summaryRootCache;
  }

  function rowsFromNodes(nodes, source, visited) {
    const rows = [];
    for (const element of nodes) {
      if (visited.has(element) || !Safety.isVisible(element)) continue; visited.add(element);
      const text = normalize(element.innerText || element.textContent || '');
      if (!text || text.length > 260) continue;
      const kind = C.classifySummaryLabel(text); if (!kind) continue;
      const quote = P.extractPriceQuotes(text, 'CHECKOUT_SUMMARY').filter((row) => !row.isRange).at(-1); if (!quote) continue;
      let confidence = source === 'FALLBACK' ? 45 : 65;
      if (/(grand\s*total|order\s*total|к\s*оплате|итого\s*к\s*оплате)/i.test(text)) confidence += 25;
      if (element.matches?.('[data-pl*="total" i],[data-testid*="total" i],[aria-label*="total" i]')) confidence += 10;
      rows.push({ kind, value: quote.value, currency: quote.currency, confidence, source, text });
    }
    return rows;
  }

  function summaryRows() {
    const visited = new Set(); const specific = [];
    const directSelector = '[data-pl*="total" i],[data-testid*="total" i],[data-testid*="subtotal" i],[data-testid*="shipping" i],[data-testid*="tax" i],[aria-label*="total" i],[class*="total" i]';
    specific.push(...Array.from(document.querySelectorAll(directSelector)).slice(0, 500));
    for (const root of summaryRoots()) specific.push(root, ...Array.from(root.querySelectorAll?.('div,li,p,span') || []).slice(0, 600));
    let rows = rowsFromNodes(specific, 'SPECIFIC_SUMMARY', visited);
    if (rows.some((row) => row.kind === 'total')) return rows;
    const fallback = Array.from(document.querySelectorAll('div,li,p')).slice(0, 900);
    rows = rows.concat(rowsFromNodes(fallback, 'FALLBACK', visited));
    return rows;
  }

  function readBreakdown() { return C.buildBreakdown(summaryRows()); }

  function attributeFrom(root, names) {
    for (const name of names) { const value = root.getAttribute?.(name); if (value) return String(value); }
    return null;
  }

  function itemIdFromLink(link) {
    const href = String(link?.href || link?.getAttribute?.('href') || '');
    if (!href) return null;
    const pathMatch = href.match(/\/item\/(\d{6,})(?:\.html)?/i); if (pathMatch) return pathMatch[1];
    try {
      const url = new URL(href, location.href);
      const value = url.searchParams.get('itemId') || url.searchParams.get('productId');
      return /^\d{6,}$/.test(value || '') ? value : null;
    } catch (_) { return null; }
  }

  function isRecommendationLink(link) {
    let node = link;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      const signature = normalize([node.id, node.className, node.getAttribute?.('data-testid'), node.getAttribute?.('data-pl')].filter(Boolean).join(' '));
      if (/(recommend|suggest|similar|you.?may.?like|also.?like|рекоменд|похож)/i.test(signature)) return true;
    }
    return false;
  }

  function visibleItemLinks() {
    return Array.from(document.querySelectorAll('a[href*="/item/"],a[href*="itemId="],a[href*="productId="]')).slice(0, 500)
      .filter((link) => Safety.isVisible(link) && !isRecommendationLink(link) && !!itemIdFromLink(link));
  }

  function itemRootForLink(link) {
    let node = link;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      const signature = normalize([node.id, node.className, node.getAttribute?.('data-testid'), node.getAttribute?.('data-pl')].filter(Boolean).join(' '));
      if (/(?:^|[-_\s])(cart|order|checkout|line|product|sku)[-_\s]?(?:item|info|content|row)?(?:$|[-_\s])/i.test(signature) || attributeFrom(node, ['data-item-id', 'data-itemid', 'data-product-id', 'data-productid'])) return node;
    }
    return link;
  }

  function checkoutIdentityScopePresent() {
    if (['CART', 'CHECKOUT'].includes(P.parsePageType(location.href))) return true;
    const marker = document.querySelector('[data-testid*="checkout" i],[data-pl*="checkout" i],[data-testid*="order-confirm" i],[data-pl*="order-confirm" i],[id*="checkout" i],[class*="checkout-page" i],[class*="order-confirm" i]');
    if (marker && Safety.isVisible(marker)) return true;
    const headings = Array.from(document.querySelectorAll('h1,h2,[role="heading"],[aria-level]')).filter(Safety.isVisible).slice(0, 120);
    if (headings.some((element) => /^(?:оформление\s+заказа|подтверждение\s+заказа|checkout|order\s+(?:confirmation|review)|shopping\s+cart|корзина)(?:\s|$)/i.test(normalize(element.innerText || element.textContent || '')))) return true;
    return Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"]')).filter(Safety.isVisible).slice(0, 500)
      .some((element) => /^(?:оформить\s+заказ|разместить\s+заказ|подтвердить\s+заказ|place\s+order|submit\s+order|confirm\s+order)$/i.test(Safety.labelOf(element)));
  }

  let structuredItemCache = null;
  function structuredCheckoutItems(visibleIds) {
    if (!visibleIds.size) return [];
    const scripts = Array.from(document.querySelectorAll('script[type="application/json"],script#__NEXT_DATA__,script[data-state],script[data-hydration]')).slice(0, 40);
    const pathname = (() => { try { return new URL(location.href).pathname; } catch (_) { return ''; } })();
    const visibleKey = [...visibleIds].sort().join(','); const lengths = scripts.map((script) => String(script.textContent || '').length);
    if (structuredItemCache?.pathname === pathname && structuredItemCache.visibleKey === visibleKey && structuredItemCache.scripts.length === scripts.length &&
      structuredItemCache.scripts.every((script, index) => script === scripts[index] && structuredItemCache.lengths[index] === lengths[index])) return structuredItemCache.items;
    const result = []; let visited = 0; let totalBytes = 0;
    const field = (object, names) => {
      for (const name of names) {
        const key = Object.keys(object).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
        const value = key ? object[key] : null;
        if (typeof value === 'string') return value;
        if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
      }
      return null;
    };
    const walk = (value) => {
      if (!value || typeof value !== 'object' || visited++ > 60_000) return;
      if (!Array.isArray(value)) {
        const itemId = field(value, ['itemId', 'item_id', 'productId', 'product_id']);
        if (itemId && visibleIds.has(itemId)) {
          const rawSku = field(value, ['skuId', 'sku_id', 'selectedSkuId', 'selected_sku_id', 'variantId', 'variant_id']);
          const rawQuantity = field(value, ['quantity', 'qty', 'buyCount', 'buy_count']);
          const quantity = Number.isFinite(Number(rawQuantity)) && Number(rawQuantity) > 0 && Number(rawQuantity) <= 999 ? Number(rawQuantity) : null;
          result.push({ itemId, skuId: rawSku && /^[A-Za-z0-9_-]{1,100}$/.test(rawSku) ? rawSku : null, quantity, sellerId: null, rootEvidence: true, evidenceSource: 'STRUCTURED' });
        }
      }
      for (const child of Array.isArray(value) ? value : Object.values(value)) walk(child);
    };
    for (const script of scripts) {
      const text = String(script.textContent || '').trim(); totalBytes += text.length;
      if (!text || text.length > 1_000_000 || totalBytes > 2_000_000 || !/^[{[]/.test(text)) continue;
      try { walk(JSON.parse(text)); } catch (_) {}
    }
    const grouped = new Map();
    for (const row of result.slice(0, 300)) {
      const group = grouped.get(row.itemId) || { itemId: row.itemId, skuIds: new Set(), quantities: new Set() };
      if (row.skuId) group.skuIds.add(row.skuId); if (Number.isFinite(row.quantity)) group.quantities.add(row.quantity); grouped.set(row.itemId, group);
    }
    const items = [...grouped.values()].map((group) => ({
      itemId: group.itemId,
      skuId: group.skuIds.size === 1 ? [...group.skuIds][0] : null,
      quantity: group.quantities.size === 1 ? [...group.quantities][0] : null,
      sellerId: null,
      rootEvidence: true,
      evidenceSource: 'STRUCTURED'
    }));
    structuredItemCache = { pathname, visibleKey, scripts, lengths, items }; return items;
  }

  function mergeCheckoutItems(rows) {
    const merged = [];
    for (const row of rows) {
      if (!(row.itemId || row.skuId)) continue;
      const sameItem = row.itemId ? merged.filter((candidate) => candidate.itemId === row.itemId) : [];
      let existing = merged.find((candidate) => row.skuId && candidate.skuId === row.skuId);
      existing ||= sameItem.find((candidate) => !candidate.skuId || !row.skuId);
      if (!existing && row.evidenceSource === 'STRUCTURED' && sameItem.some((candidate) => candidate.evidenceSource === 'DOM')) continue;
      if (!existing) { merged.push({ ...row }); continue; }
      for (const key of ['itemId', 'skuId', 'quantity', 'sellerId']) if (existing[key] === null || existing[key] === undefined) existing[key] = row[key] ?? null;
      existing.rootEvidence = existing.rootEvidence || row.rootEvidence;
    }
    return merged;
  }

  function checkoutItems() {
    const selector = '[data-item-id],[data-itemid],[data-product-id],[data-productid],[data-sku-id],[data-skuid],[data-variant-id],[class*="cart-item" i],[class*="order-item" i],[data-testid*="cart-item" i],[data-testid*="order-item" i],[data-testid*="line-item" i],[data-testid*="product-item" i]';
    const itemRootSelector = '[data-item-id],[data-itemid],[data-product-id],[data-productid],[class*="cart-item" i],[class*="order-item" i],[data-testid*="cart-item" i],[data-testid*="order-item" i],[data-testid*="line-item" i],[data-testid*="product-item" i]';
    const raw = Array.from(document.querySelectorAll(selector)).filter(Safety.isVisible).slice(0, 600);
    const links = checkoutIdentityScopePresent() ? visibleItemLinks() : [];
    const roots = [...new Set([...raw.map((element) => element.closest?.(itemRootSelector) || element), ...links.map(itemRootForLink)])]; const rows = [];
    for (const root of roots) {
      const link = root.tagName === 'A' && itemIdFromLink(root) ? root : root.querySelector?.('a[href*="/item/"],a[href*="itemId="],a[href*="productId="]');
      const itemId = attributeFrom(root, ['data-item-id', 'data-itemid', 'data-product-id', 'data-productid']) || itemIdFromLink(link);
      const skuElement = attributeFrom(root, ['data-sku-id', 'data-skuid', 'data-sku', 'data-variant-id']) ? root : root.querySelector?.('[data-sku-id],[data-skuid],[data-sku],[data-variant-id]');
      const skuId = attributeFrom(skuElement || root, ['data-sku-id', 'data-skuid', 'data-sku', 'data-variant-id']);
      const quantityElement = root.querySelector?.('input[name*="quant" i],input[id*="quant" i],input[aria-label*="quant" i],select[name*="quant" i],[data-quantity]');
      const quantityText = attributeFrom(root, ['data-quantity']) || quantityElement?.value || normalize(root.innerText || root.textContent || '').match(/(?:qty|quantity|кол(?:-?во|ичество)|×|x)\s*[:×x]?\s*(\d{1,3})/i)?.[1];
      const quantity = quantityText !== null && quantityText !== undefined && quantityText !== '' && Number.isFinite(Number(quantityText)) ? Number(quantityText) : null;
      const sellerElement = root.matches?.('[data-seller-id],[data-store-id]') ? root : root.querySelector?.('[data-seller-id],[data-store-id]');
      const sellerId = attributeFrom(sellerElement || root, ['data-seller-id', 'data-store-id']);
      const rootEvidence = !!(itemId || skuId || root.matches?.(itemRootSelector));
      if (!rootEvidence) continue;
      rows.push({ itemId, skuId, quantity, sellerId, rootEvidence, evidenceSource: 'DOM' });
    }
    const visibleIds = new Set(links.map(itemIdFromLink).filter(Boolean));
    return mergeCheckoutItems([...rows, ...structuredCheckoutItems(visibleIds)]);
  }

  function selectedShippingMethod() {
    const selectors = [
      'input[type="radio"][name*="ship" i]:checked', 'input[type="radio"][name*="deliver" i]:checked',
      '[aria-checked="true"][class*="ship" i]', '[aria-checked="true"][data-testid*="ship" i]'
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector); if (!element) continue;
      const stableId = element.getAttribute?.('data-shipping-method-id') || element.getAttribute?.('data-method-id') || element.value || null;
      if (stableId && !/^(?:on|true|false)$/i.test(String(stableId))) return String(stableId).slice(0, 120);
    }
    return null;
  }

  function readCheckout() {
    const breakdown = readBreakdown();
    const financial = C.buildFinancialSnapshot(breakdown);
    const fingerprint = C.buildCheckoutFingerprint({ currency: financial.currency, items: checkoutItems(), shippingMethodId: selectedShippingMethod() });
    return { breakdown, financial, fingerprint };
  }

  function checkoutSurfaceEvidence({ pageType = P.parsePageType(location.href), checkout = null } = {}) {
    const state = checkout || readCheckout(); const signals = [];
    const urlMatched = ['CART', 'CHECKOUT'].includes(pageType); if (urlMatched) signals.push(`URL_${pageType}`);
    const markerSelector = '[data-testid*="checkout" i],[data-pl*="checkout" i],[data-testid*="order-confirm" i],[data-pl*="order-confirm" i],[id*="checkout" i],[class*="checkout-page" i],[class*="order-confirm" i]';
    const markerFound = Array.from(document.querySelectorAll(markerSelector)).slice(0, 120).some(Safety.isVisible);
    if (markerFound) signals.push('CHECKOUT_MARKER');
    const headings = Array.from(document.querySelectorAll('h1,h2,[role="heading"],[aria-level]')).filter(Safety.isVisible).slice(0, 160);
    const headingFound = headings.some((element) => /^(?:оформление\s+заказа|подтверждение\s+заказа|checkout|order\s+(?:confirmation|review)|shopping\s+cart|корзина)(?:\s|$)/i.test(normalize(element.innerText || element.textContent || element.getAttribute?.('aria-label') || '')));
    if (headingFound) signals.push('CHECKOUT_HEADING');
    const promoFound = !!(findPromoInput() || findRevealControl()); if (promoFound) signals.push('PROMO_CONTROL');
    const totalFound = Number.isFinite(state.financial?.total) && (state.breakdown?.candidates || []).some((row) => row.kind === 'total');
    if (totalFound) signals.push('ORDER_TOTAL');
    const orderActionFound = Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"]')).filter(Safety.isVisible).slice(0, 800).some((element) => /^(?:оформить\s+заказ|разместить\s+заказ|подтвердить\s+заказ|place\s+order|submit\s+order|confirm\s+order)$/i.test(Safety.labelOf(element)));
    if (orderActionFound) signals.push('ORDER_ACTION_READ_ONLY');
    const candidate = urlMatched || markerFound || headingFound || orderActionFound || (promoFound && totalFound);
    const detected = urlMatched || (markerFound && (headingFound || promoFound || totalFound || orderActionFound)) || (headingFound && (promoFound || totalFound || orderActionFound)) || (promoFound && totalFound && orderActionFound);
    return { candidate, detected, pageClass: pageType === 'CART' ? 'CART' : 'CHECKOUT', signals, urlMatched, markerFound, headingFound, promoFound, totalFound, orderActionFound };
  }

  function effectiveCheckoutBinding(checkout = null) {
    const pageType = P.parsePageType(location.href); const surface = checkoutSurfaceEvidence({ pageType, checkout });
    return { binding: C.checkoutBinding(location.href, surface.detected ? surface.pageClass : pageType), pageType, surface };
  }

  function safeWidgetDiagnostics(context, checkout) {
    const fingerprint = checkout.fingerprint || {}; const items = fingerprint.items || [];
    let pathname = null; try { pathname = new URL(location.href).pathname; } catch (_) {}
    const input = findPromoInput(); const selectors = { inputFound: !!input, applyFound: !!findApplyButton(input), revealFound: !!findRevealControl() };
    return {
      pathname,
      pageType: context.pageType,
      checkoutSurfaceDetected: context.checkoutSurfaceDetected,
      checkoutSurfaceSignals: context.checkoutSurfaceSignals,
      financial: C.buildFinancialSnapshot(checkout.financial),
      fingerprint: { quality: fingerprint.quality || 'WEAK', componentsUsed: Array.isArray(fingerprint.componentsUsed) ? fingerprint.componentsUsed.slice() : [] },
      items: {
        count: items.length,
        itemIdDetected: items.filter((row) => !!row.itemId).length,
        skuIdDetected: items.filter((row) => !!row.skuId).length,
        quantityDetected: items.filter((row) => Number.isFinite(row.quantity)).length
      },
      selectors: { inputFound: selectors.inputFound, applyFound: selectors.applyFound, revealFound: selectors.revealFound }
    };
  }

  function checkoutSignature(checkout) {
    return C.financialSignature(checkout?.financial || checkout?.breakdown || {});
  }

  async function waitForStableCheckout(timeoutMs = 9000, quietWindowMs = 1000) {
    const started = Date.now(); let lastSignature = null; let lastChangedAt = Date.now(); let last = readCheckout();
    while (Date.now() - started < timeoutMs) {
      const current = readCheckout(); const signature = checkoutSignature(current);
      if (signature !== lastSignature) { lastSignature = signature; lastChangedAt = Date.now(); }
      last = current; lastSignature = signature;
      if (Number.isFinite(current.financial.total) && Date.now() - lastChangedAt >= quietWindowMs) return current;
      const remaining = Math.max(1, Math.min(350, timeoutMs - (Date.now() - started), quietWindowMs - (Date.now() - lastChangedAt)));
      await waitForDomSignal(remaining);
    }
    return last;
  }

  function feedbackText(input) {
    const blocks = []; let node = input?.parentElement;
    for (let depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
      const text = normalize(node.innerText || node.textContent || ''); if (text && text.length <= 700) blocks.push(text);
    }
    for (const element of Array.from(document.querySelectorAll('[role="alert"],[aria-live],[class*="error" i],[class*="success" i],[class*="message" i],[class*="toast" i]')).slice(0, 150)) {
      if (Safety.isVisible(element)) blocks.push(normalize(element.innerText || element.textContent || ''));
    }
    return sanitizeFeedback([...new Set(blocks.filter(Boolean))].join('\n'));
  }

  function appliedIndicator(code, input = findPromoInput()) {
    const upper = String(code || '').toUpperCase(); const candidates = []; let node = input?.parentElement;
    for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) candidates.push(node);
    candidates.push(...Array.from(document.querySelectorAll('[class*="promo" i],[class*="coupon" i],[class*="voucher" i],[class*="discount" i],[aria-live],[role="status"],[role="alert"]')).slice(0, 600));
    let best = { applied: false, confidence: 0, evidenceType: null, snippet: null };
    for (const element of [...new Set(candidates)]) {
      if (!Safety.isVisible(element)) continue;
      const text = normalize(element.innerText || element.textContent || element.getAttribute?.('aria-label') || ''); if (!text || text.length > 1200) continue;
      const context = normalize(`${text} ${element.parentElement?.innerText || element.parentElement?.textContent || ''}`).slice(0, 1800);
      let confidence = 0; let evidenceType = null;
      if (upper && context.toUpperCase().includes(upper) && /(?:applied|active|selected|примен[её]н|актив|удалить|remove)/i.test(context)) { confidence = 95; evidenceType = 'CODE_AND_STATE'; }
      else if (APPLIED_TEXT.test(context) && PROMO_WORD.test(context)) { confidence = 82; evidenceType = 'PROMO_SUCCESS_TEXT'; }
      const remove = Array.from(element.querySelectorAll?.('button,[role="button"],a') || []).find((control) => scoreRemoveControl(control, { code, input }) >= 100);
      if (remove && confidence < 85) { confidence = 85; evidenceType = 'PROMO_REMOVE_CONTROL'; }
      if ((input?.disabled || input?.readOnly || input?.getAttribute?.('aria-disabled') === 'true') && PROMO_WORD.test(context) && confidence < 65) { confidence = 65; evidenceType = 'PROMO_INPUT_STATE'; }
      if (confidence > best.confidence) best = { applied: confidence >= 65, confidence, evidenceType, snippet: P.safeSnippet(element) };
    }
    return best;
  }

  function existingPlatformCode() {
    const codePattern = /\b[A-Z0-9][A-Z0-9_-]{3,31}\b/g;
    const genericTokens = new Set(['PROMO', 'CODE', 'COUPON', 'APPLIED', 'REMOVE', 'DISCOUNT', 'VOUCHER']);
    for (const element of Array.from(document.querySelectorAll('[class*="promo" i],[class*="coupon" i],[class*="voucher" i],[role="status"]')).slice(0, 600)) {
      if (!Safety.isVisible(element)) continue;
      const text = normalize(element.innerText || element.textContent || ''); if (!APPLIED_TEXT.test(text) && !/(active|selected|remove|удалить)/i.test(text)) continue;
      const code = (text.match(codePattern) || []).map(Store.normalizeCode).find((value) => value && !genericTokens.has(value)); if (code) return code;
      if (PROMO_WORD.test(text) && element.querySelector?.('button,[role="button"]')) return 'ACTIVE_PROMO';
    }
    return null;
  }

  function safetyStopStatus() {
    const text = normalize(document.body?.innerText || '').slice(0, 120_000); const status = C.textOutcome(text);
    return [C.STATUS.CAPTCHA, C.STATUS.RATE_LIMITED].includes(status) ? status : null;
  }

  async function saveSession(session) { await chrome.storage.local.set({ promoTestSession: session }); }

  const domAdapter = {
    now: () => Date.now(),
    getBinding: () => effectiveCheckoutBinding().binding,
    normalizeCandidates: (rows) => normalizeCandidateQueue(rows),
    normalizeCandidate: (row) => ({ ...row, ...P.normalizePromotion({ ...row, type: P.PROMOTION_TYPES.PLATFORM_PROMO_CODE, source: row.source || 'USER', confidence: row.confidence || 50 }) }),
    ensureReady: async () => ({ ok: !!await ensurePromoInput(), message: 'Поле промокода не найдено' }),
    existingCode: async () => existingPlatformCode(),
    readCheckout: async () => readCheckout(),
    readStableCheckout: async (timeout) => waitForStableCheckout(timeout),
    enterCode: async (code) => {
      const input = await ensurePromoInput(); if (!input) return { ok: false, message: 'Поле промокода не найдено' };
      nativeSetInput(input, ''); await waitForDomSignal(120); nativeSetInput(input, code); return { ok: true };
    },
    clickApply: async () => {
      const input = findPromoInput();
      const button = await waitForCondition(() => findApplyButton(input), 2500);
      if (!button) return { ok: false, message: 'AliExpress не показал безопасную кнопку применения; результат кода не подтверждён' };
      Safety.safeClick(button, { purpose: 'Применение промокода', intent: 'APPLY_PROMO' }); return { ok: true };
    },
    observe: async (code) => {
      const input = findPromoInput();
      return { checkout: readCheckout(), feedbackText: feedbackText(input), appliedEvidence: appliedIndicator(code, input), safetyStatus: safetyStopStatus() };
    },
    waitForSignal: (ms) => waitForDomSignal(ms),
    removeCode: async (code) => {
      const button = findRemoveButton(code); if (!button) return { ok: false, message: 'AliExpress не показал безопасную кнопку удаления применённого промокода' };
      Safety.safeClick(button, { purpose: 'Удаление проверенного промокода', intent: 'REMOVE_PROMO' }); return { ok: true };
    },
    clearCode: async () => { const input = findPromoInput(); if (input) nativeSetInput(input, ''); },
    safetyStatus: async () => safetyStopStatus(),
    isCancelled: () => cancelRequested,
    delay: (ms) => sleep(ms),
    persist: saveSession
  };

  const verifier = Engine.createVerifier(domAdapter, { maxCodes: MAX_CODES });

  async function testCodes(candidates, queueMeta = null) {
    const session = await verifier.run(candidates);
    if (queueMeta) {
      session.promoIntelligence = queueMeta;
      const best = session.results?.find((row) => row.code === session.bestCode);
      const unresolved = (session.results || []).some((row) => row.verificationStatus === C.STATUS.UNKNOWN_ERROR && (!Number.isFinite(row.theoreticalMaxSaving) || row.theoreticalMaxSaving > (best?.saving || 0)));
      session.bestKnownProven = session.status === 'COMPLETE' && !!session.bestCode && queueMeta.queueCoversAllEligible === true && !unresolved;
      await saveSession(session);
    }
    const verificationContext = { currency: session.currency || null, itemIds: (session.checkoutFingerprint?.items || []).map((item) => item.itemId).filter(Boolean), sellerIds: (session.checkoutFingerprint?.items || []).map((item) => item.sellerId).filter(Boolean) };
    await Store.upsert((session.results || []).map((row) => ({ ...row, lastStatus: row.verificationStatus, lastMessage: row.verificationMessage, lastDiscount: row.saving, lastVerificationContext: verificationContext })));
    return session;
  }

  async function applyBestExplicitly(code) {
    const normalized = Store.normalizeCode(code); const { promoTestSession: session } = await chrome.storage.local.get('promoTestSession');
    const response = await verifier.applyBest(normalized, session);
    if (response.status === 'APPLIED') { session.bestApplied = true; session.bestAppliedAt = new Date().toISOString(); session.bestApplicationResult = response.result; await saveSession(session); }
    return response;
  }

  function selectorDiagnostics() {
    const input = findPromoInput(); const apply = findApplyButton(input); const reveal = findRevealControl();
    return {
      inputFound: !!input, input: P.safeSnippet(input), applyFound: !!apply, apply: P.safeSnippet(apply), applyScore: apply ? scoreApplyControl(apply, input) : null,
      revealFound: !!reveal, reveal: P.safeSnippet(reveal), existingPlatformCode: existingPlatformCode()
    };
  }

  function safeUrl() { try { const url = new URL(location.href); return `${url.origin}${url.pathname}`; } catch (_) { return null; } }

  function checkoutContext() {
    const checkout = readCheckout();
    const { binding, pageType, surface } = effectiveCheckoutBinding(checkout);
    const fingerprint = checkout.fingerprint || {};
    const financial = checkout.financial || {};
    const supportedPage = surface.detected && ['CART', 'CHECKOUT'].includes(binding.pageClass);
    const reliableIdentity = verifier.fingerprintIsReliable(fingerprint);
    const hasTotal = Number.isFinite(financial.total);
    const context = {
      available: supportedPage && reliableIdentity && hasTotal,
      pageType,
      binding,
      checkoutSurfaceDetected: surface.detected,
      checkoutSurfaceCandidate: surface.candidate,
      checkoutSurfaceSignals: surface.signals.slice(),
      checkoutFingerprint: fingerprint,
      currency: financial.currency || fingerprint.currency || null,
      subtotal: financial.subtotal,
      orderTotal: financial.total,
      total: financial.total,
      itemIds: (fingerprint.items || []).map((row) => row.itemId).filter(Boolean),
      sellerIds: (fingerprint.items || []).map((row) => row.sellerId).filter(Boolean),
      region: null,
      regionConfidence: 0,
      isNewUser: null,
      newUserStatusConfidence: 0,
      fingerprintQuality: fingerprint.quality || 'WEAK',
      reason: !supportedPage ? 'Не удалось распознать страницу checkout' : !reliableIdentity ? 'Не удалось надёжно определить состав заказа' : !hasTotal ? 'Не удалось определить итоговую сумму' : null
    };
    context.diagnostics = safeWidgetDiagnostics(context, checkout); return context;
  }

  async function diagnostics() {
    const { promoTestSession = null, couponCandidates = [] } = await chrome.storage.local.get(['promoTestSession', 'couponCandidates']); const checkout = readCheckout();
    return { pageType: P.parsePageType(location.href), url: safeUrl(), locale: document.documentElement?.lang || navigator.language || null, checkoutState: checkout.financial, checkoutFingerprint: checkout.fingerprint, selectorMatches: selectorDiagnostics(), couponCandidates, verificationResults: promoTestSession?.results || [], parserVersion: P.parserVersion, timestamp: new Date().toISOString() };
  }

  async function executeCommand(message = {}) {
    if (message.type === 'CH_PROMO_TESTER_STATUS') {
      const context = checkoutContext();
      return { available: context.available, pageType: context.pageType, message: context.available ? 'Checkout готов к проверке промокодов' : context.reason };
    }
    if (message.type === 'CH_TEST_PROMOS') {
      if (running) return { status: 'BUSY', message: 'Проверка уже выполняется' };
      running = true; cancelRequested = false;
      try { return await testCodes(message.candidates || message.codes || [], message.queueMeta || null); }
      catch (error) {
        const result = { status: 'ERROR', stopReason: error?.message || String(error), results: [] };
        await saveSession(result).catch(() => {}); return result;
      } finally { running = false; }
    }
    if (message.type === 'CH_CANCEL_PROMO_TEST') { cancelRequested = true; return { status: running ? 'CANCELLING' : 'IDLE' }; }
    if (message.type === 'CH_APPLY_BEST_PROMO') {
      try { return await applyBestExplicitly(message.code); }
      catch (error) { return { status: 'ERROR', message: error?.message || String(error) }; }
    }
    if (message.type === 'CH_GET_CHECKOUT_DIAGNOSTICS') return diagnostics();
    return null;
  }

  globalThis.CouponHunterPromoTester = {
    normalizeCodes, normalizeCandidateQueue, inputScore, scoreApplyControl, scoreRemoveControl, findApplyButton, findRemoveButton,
    readBreakdown, readCheckout, summaryRows, checkoutItems, selectedShippingMethod, appliedIndicator, existingPlatformCode, selectorDiagnostics, diagnostics,
    checkoutContext, checkoutSurfaceEvidence, effectiveCheckoutBinding, safeWidgetDiagnostics, executeCommand,
    isForbiddenActionLabel: Safety.isForbiddenActionLabel
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const supported = new Set(['CH_PROMO_TESTER_STATUS', 'CH_TEST_PROMOS', 'CH_CANCEL_PROMO_TEST', 'CH_APPLY_BEST_PROMO', 'CH_GET_CHECKOUT_DIAGNOSTICS']);
    if (!supported.has(message?.type)) return false;
    executeCommand(message).then(sendResponse);
    return true;
  });
})();
