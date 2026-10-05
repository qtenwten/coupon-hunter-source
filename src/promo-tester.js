(() => {
  'use strict';
  if (window.__COUPON_HUNTER_PROMO_TESTER_V341__) return;
  window.__COUPON_HUNTER_PROMO_TESTER_V341__ = true;

  const P = globalThis.CouponHunterParser;
  const C = globalThis.CouponHunterCheckoutCore;
  const Store = globalThis.CouponHunterStorage;
  const Safety = globalThis.CouponHunterSafety;
  const Engine = globalThis.CouponHunterVerifierEngine;
  const Country = globalThis.CouponHunterCountryProfile;
  const Limits = globalThis.CouponHunterPromoConstants || { HARD_LIVE_ATTEMPT_LIMIT: 50 };
  const MAX_CODES = Limits.HARD_LIVE_ATTEMPT_LIMIT;
  const RECENT_PRODUCT_CONTEXT_TTL_MS = 30 * 60 * 1000;
  const APPLY_WORD = /(?:^|\b|\s)(?:apply|redeem|use|применить|активировать|использовать)(?:\b|\s|$)/i;
  const REMOVE_WORD = /(?:^|\b|\s)(?:remove|clear|delete|удалить|убрать|очистить)(?:\b|\s|$)/i;
  const PROMO_WORD = /(?:promo(?:\s*code)?|coupon|voucher|discount(?:\s*code)?|code|промокод|купон|скидк|код\s*скидки)/i;
  const NEGATIVE_APPLY = /(?:coins?|points?|balance|rewards?|bonus|gift\s*card|credit|loan|address|job|application|монет|балл|баланс|бонус|наград|подарочн(?:ая|ой)\s*карт|сертификат|кредит|адрес|заявк)/i;
  const APPLIED_TEXT = /(?:promo(?:\s*code)?|coupon|voucher|discount|промокод|купон|скидк).{0,40}(?:applied|active|selected|примен[её]н|активирован|выбран)|(?:applied|примен[её]н[ао]?).{0,40}(?:promo|coupon|voucher|discount|промокод|купон|скидк)/i;
  const PLATFORM_PROMO_CONTROL = /(?:promo(?:tion)?\s*code|voucher\s*code|discount\s*code|промокод|код\s*скидки)/i;
  const GENERIC_COUPON_ACTION = /(?:apply|collect|get|use|применить|получить|использовать).{0,40}(?:coupon|купон)|(?:seller|store|item|продавц|магазин|товар).{0,40}(?:coupon|купон)/i;
  const ALIEXPRESS_ICON_APPLY_TEST_ID = 'buttonApply';
  const SAFE_APPLY_LABEL = /(?:^|\b|\s)(?:apply|redeem|use|применить|активировать|использовать)(?:\b|\s|$)|(?:^|\s)buttonApply(?:\s|$)/i;
  let running = false;
  let cancelRequested = false;
  let summaryRootCache = null;
  let recentProductContextCache = null;
  let activePromoResponseCapture = null;

  const normalize = C.normalize;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function sanitizeRecentProductContext(value) {
    if (!value || typeof value !== 'object' || !/^\d{6,24}$/.test(String(value.itemId || '')) || !/^[A-Za-z0-9_-]{1,100}$/.test(String(value.skuId || ''))) return null;
    if (!Number.isFinite(Number(value.price)) || !String(value.currency || '').match(/^[A-Z]{3}$/) || !Number.isFinite(Number(value.timestamp))) return null;
    return {
      itemId: String(value.itemId), skuId: String(value.skuId),
      titleHash: typeof value.titleHash === 'string' ? value.titleHash.slice(0, 32) : null,
      variantHash: typeof value.variantHash === 'string' ? value.variantHash.slice(0, 32) : null,
      price: Number(value.price), currency: String(value.currency), timestamp: Number(value.timestamp)
    };
  }

  function setRecentProductContext(value) {
    recentProductContextCache = sanitizeRecentProductContext(value); structuredItemCache = null;
    return recentProductContextCache;
  }

  function recentProductContextState(now = Date.now()) {
    const context = recentProductContextCache; const available = !!context;
    const age = available ? Number(now) - context.timestamp : Infinity;
    const fresh = available && age >= -5 * 60 * 1000 && age <= RECENT_PRODUCT_CONTEXT_TTL_MS;
    return { available, fresh, context: fresh ? context : null };
  }

  async function refreshRecentProductContext() {
    const stored = await chrome.storage.local.get('recentProductContext');
    return setRecentProductContext(stored?.recentProductContext || null);
  }

  function sanitizeFeedback(value) {
    return normalize(value)
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email hidden]')
      .replace(/(?:\+?\d[\s()-]*){10,16}/g, '[phone hidden]')
      .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[number hidden]')
      .slice(0, 3000);
  }

  const PRIVATE_RESPONSE_TEXT = /(?:recipient|получател|delivery\s*address|адрес\s*достав|shipping\s*address|phone|телефон|e-?mail|payment|оплат|bank\s*card|card\s*(?:number|holder)|номер\s*карт|cvv|cvc)/i;
  const RESPONSE_PRIVATE_SECTION = /(?:recipient|получател|address|адрес|payment|оплат|delivery|достав)/i;
  const RESPONSE_WIDE_CONTAINER = /(?:order[-_\s]*summary|checkout[-_\s]*summary)/i;
  const RESPONSE_CONTAINER_SEMANTIC = /(?:coupon|couponv2|promo(?:code)?|voucher|промокод|купон)/i;
  const RESPONSE_HELPER_SELECTOR = '[role="alert"],[aria-live],[class*="helper" i],[class*="hint" i],[class*="error" i],[class*="tip" i],[class*="notice" i],[class*="validation" i],[data-testid*="error" i],[data-testid*="message" i]';

  function safePromoResponseText(value) {
    const text = sanitizeFeedback(value).replace(/[\r\n]+/g, ' ').slice(0, 200);
    if (!text || PRIVATE_RESPONSE_TEXT.test(text)) return null;
    return text;
  }

  function responseContainerMetadata(node) {
    return normalize(`${node?.className || ''} ${node?.id || ''} ${node?.getAttribute?.('data-testid') || ''} ${node?.getAttribute?.('aria-label') || ''}`);
  }

  function compactPromoResponseContainer(node, input, applyButton) {
    if (!node || /^(?:BODY|HTML|MAIN)$/i.test(node.tagName || '') || !Safety.isVisible(node) || !isWithin(node, input) || !isWithin(node, applyButton)) return false;
    const text = normalize(node.innerText || node.textContent || ''); const metadata = responseContainerMetadata(node); const rect = node.getBoundingClientRect?.() || {};
    if (text.length > 2400 || Number(rect.width) > 1100 || Number(rect.height) > 600 || RESPONSE_PRIVATE_SECTION.test(text) || RESPONSE_PRIVATE_SECTION.test(metadata) || (RESPONSE_WIDE_CONTAINER.test(metadata) && !RESPONSE_CONTAINER_SEMANTIC.test(metadata))) return false;
    const controls = Array.from(node.querySelectorAll?.('button,[role="button"],input[type="submit"]') || []).slice(0, 30);
    if (controls.length > 8 || controls.some((control) => control !== applyButton && Safety.isForbiddenActionLabel(Safety.labelOf(control)))) return false;
    const inputs = Array.from(node.querySelectorAll?.('input') || []).slice(0, 10);
    return inputs.length <= 4;
  }

  function promoApplyContainer(input, applyButton) {
    if (!input || !applyButton || !isConfirmedPromoApplyControl(applyButton, input)) return null;
    const strict = findPromoInputContainer(input); if (strict && isWithin(strict, applyButton)) return strict;
    let node = input.parentElement;
    for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
      if (/^(?:BODY|HTML|MAIN)$/i.test(node.tagName || '')) break;
      if (isWithin(node, applyButton)) return node;
    }
    return null;
  }

  function resolvePromoResponseContainer(input, applyButton = null) {
    const applyContainer = promoApplyContainer(input, applyButton); if (!applyContainer) return { element: null, strategy: null };
    const candidates = []; let node = applyContainer;
    for (let depth = 0; node && depth <= 3; depth += 1, node = node.parentElement) {
      if (/^(?:BODY|HTML|MAIN)$/i.test(node.tagName || '')) break;
      if (compactPromoResponseContainer(node, input, applyButton)) candidates.push(node);
    }
    const semantic = candidates.find((candidate) => RESPONSE_CONTAINER_SEMANTIC.test(responseContainerMetadata(candidate)));
    if (semantic) return { element: semantic, strategy: semantic === applyContainer ? 'CONFIRMED_PROMO_CONTAINER' : 'COUPON_SEMANTIC_ANCESTOR' };
    const fallback = candidates.find((candidate) => PLATFORM_PROMO_CONTROL.test(normalize(candidate.innerText || candidate.textContent || '')) || /^(?:LABEL|FORM|SECTION)$/i.test(candidate.tagName || ''));
    return fallback ? { element: fallback, strategy: 'BOUNDED_PROMO_ANCESTOR' } : { element: null, strategy: null };
  }

  function findPromoResponseContainer(input, applyButton = null) {
    return resolvePromoResponseContainer(input, applyButton).element;
  }

  function promoResponseScope(input, applyButton = null) {
    return findPromoResponseContainer(input, applyButton);
  }

  function describedResponseNodes(input) {
    const rows = [];
    for (const [attribute, source] of [['aria-errormessage', 'ARIA_ERRORMESSAGE'], ['aria-describedby', 'ARIA_DESCRIBEDBY']]) {
      const ids = normalize(input?.getAttribute?.(attribute) || '').split(/\s+/).filter(Boolean).slice(0, 5);
      for (const id of ids) { const element = document.getElementById?.(id); if (element) rows.push({ element, source }); }
    }
    return rows;
  }

  function collectPromoResponseFragments(input, applyButton = null, scope = promoResponseScope(input, applyButton)) {
    const candidates = []; const add = (element, source, requirePromo = false) => {
      if (!element || element === input || element === applyButton || !Safety.isVisible(element)) return;
      const text = safePromoResponseText(element.innerText || element.textContent || element.getAttribute?.('aria-label') || '');
      if (!text || (requirePromo && !PROMO_WORD.test(text))) return;
      candidates.push({ text, source });
    };
    for (const row of describedResponseNodes(input)) add(row.element, row.source);
    for (const anchor of [input, applyButton]) {
      add(anchor?.previousElementSibling, 'PROMO_SIBLING'); add(anchor?.nextElementSibling, 'PROMO_SIBLING');
      for (const child of Array.from(anchor?.parentElement?.children || []).slice(0, 20)) add(child, 'PROMO_SIBLING');
    }
    for (const element of Array.from(scope?.querySelectorAll?.(RESPONSE_HELPER_SELECTOR) || []).slice(0, 80)) add(element, element.getAttribute?.('role') === 'alert' ? 'ROLE_ALERT' : element.getAttribute?.('aria-live') !== null ? 'ARIA_LIVE' : 'PROMO_HELPER');
    return [...new Map(candidates.map((row) => [`${row.source}|${row.text}`, row])).values()].slice(0, 20);
  }

  function recordPromoResponseFragment(capture, element, source = 'PROMO_MUTATION') {
    if (!capture || !element || !Safety.isVisible(element)) return;
    const text = safePromoResponseText(element.innerText || element.textContent || element.getAttribute?.('aria-label') || '');
    if (!text || capture.beforeTexts.has(text) || capture.fragments.some((row) => row.text === text)) return;
    capture.fragments.push({ text, source }); capture.fragments = capture.fragments.slice(0, 5);
    if (capture.responseDetectedAt === null) capture.responseDetectedAt = Date.now();
  }

  function inputValidationSignature(input) {
    return JSON.stringify([
      input?.getAttribute?.('aria-invalid') || null,
      input?.getAttribute?.('aria-describedby') || null,
      input?.getAttribute?.('aria-errormessage') || null
    ]);
  }

  function updatePromoResponseCapture(capture = activePromoResponseCapture) {
    if (!capture) return null;
    for (const row of collectPromoResponseFragments(capture.input, capture.applyButton, capture.scope)) {
      if (!capture.beforeTexts.has(row.text) && !capture.fragments.some((known) => known.text === row.text)) {
        capture.fragments.push(row); if (capture.responseDetectedAt === null) capture.responseDetectedAt = Date.now();
      }
    }
    capture.fragments = capture.fragments.slice(0, 5);
    const rawInvalid = capture.input?.getAttribute?.('aria-invalid');
    const inputInvalid = rawInvalid === 'true' ? true : rawInvalid === 'false' ? false : null;
    const first = capture.fragments[0] || null;
    return {
      applyClicked: capture.applyClicked === true,
      responseContainerFound: !!capture.scope,
      responseContainerStrategy: capture.responseContainerStrategy,
      promoMutationSeen: capture.promoMutationSeen === true,
      inputInvalid,
      inputValidationChanged: inputValidationSignature(capture.input) !== capture.beforeInputValidation,
      applyButtonFound: !!capture.applyButton,
      appliedIndicatorFound: false,
      responseTextFound: !!first,
      responseSource: first?.source || null,
      responseSnippet: first?.text || null,
      classificationLatencyMs: capture.responseDetectedAt === null ? null : Math.max(0, capture.responseDetectedAt - capture.startedAt),
      elapsedMs: Math.max(0, Date.now() - capture.startedAt)
    };
  }

  function startPromoResponseCapture(input, applyButton) {
    if (activePromoResponseCapture?.observer) activePromoResponseCapture.observer.disconnect();
    const resolution = resolvePromoResponseContainer(input, applyButton); const scope = resolution.element;
    const beforeTexts = new Set(collectPromoResponseFragments(input, applyButton, scope).map((row) => row.text));
    const capture = { input, applyButton, scope, responseContainerStrategy: resolution.strategy, beforeTexts, beforeInputValidation: inputValidationSignature(input), fragments: [], promoMutationSeen: false, applyClicked: false, responseDetectedAt: null, startedAt: Date.now(), observer: null };
    if (scope) {
      capture.observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (!capture.applyClicked) continue;
          const target = mutation.target?.nodeType === 3 ? mutation.target.parentElement : mutation.target;
          if (!target || !isWithin(scope, target)) continue;
          capture.promoMutationSeen = true; recordPromoResponseFragment(capture, target);
          for (const node of Array.from(mutation.addedNodes || []).slice(0, 20)) recordPromoResponseFragment(capture, node.nodeType === 3 ? node.parentElement : node);
        }
      });
      capture.observer.observe(scope, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-invalid', 'aria-describedby', 'aria-errormessage', 'disabled', 'value', 'class'] });
    }
    activePromoResponseCapture = capture; return capture;
  }

  function finishPromoResponseCapture() {
    const capture = activePromoResponseCapture; if (!capture) return null;
    const evidence = updatePromoResponseCapture(capture); capture.observer?.disconnect(); activePromoResponseCapture = null; return evidence;
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
    if (PLATFORM_PROMO_CONTROL.test(signature) || /promocode/.test(signature)) score += 140;
    if (/coupon/.test(signature) && !PLATFORM_PROMO_CONTROL.test(signature)) score -= 40;
    if (/gift|card|сертификат|address|phone|email|payment/.test(signature)) score -= 180;
    if (['text', 'search', ''].includes(input.type || '')) score += 15;
    if (Safety.isVisible(input) && !input.disabled && !input.readOnly) score += 40;
    return score;
  }

  function findPlatformPromoInput() {
    return Array.from(document.querySelectorAll('input')).map((element) => ({ element, score: inputScore(element) }))
      .filter((row) => row.score >= 100 && Safety.isVisible(row.element) && !row.element.disabled && !row.element.readOnly)
      .sort((a, b) => b.score - a.score)[0]?.element || null;
  }

  function scopedControls(input) {
    const result = []; let node = input?.parentElement;
    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      result.push(...Array.from(node.querySelectorAll?.('button,[role="button"],input[type="submit"]') || []));
      if (/^(FORM|SECTION|ASIDE)$/i.test(node.tagName || '')) break;
    }
    return [...new Set(result)];
  }

  function controlTestId(control) { return String(control?.getAttribute?.('data-testid') || ''); }

  function basicApplyControlSafety(control) {
    const label = Safety.labelOf(control); const type = normalize(control?.getAttribute?.('type') || control?.type || '').toLowerCase();
    const buttonRole = control?.tagName === 'BUTTON' || control?.getAttribute?.('role') === 'button';
    return buttonRole && type !== 'submit' && Safety.isVisible(control) && !control.disabled && control.getAttribute?.('aria-disabled') !== 'true' && !Safety.isForbiddenActionLabel(label);
  }

  function compactPromoWrapper(node) {
    if (!node || /^(?:BODY|HTML|MAIN)$/i.test(node.tagName || '') || !Safety.isVisible(node)) return false;
    const text = normalize(node.innerText || node.textContent || ''); const rect = node.getBoundingClientRect?.() || {};
    if (text.length > 800 || Number(rect.width) > 900 || Number(rect.height) > 360) return false;
    const controls = Array.from(node.querySelectorAll?.('button,[role="button"],input[type="submit"]') || []).slice(0, 20);
    if (controls.length > 6 || controls.some((control) => Safety.isForbiddenActionLabel(Safety.labelOf(control)))) return false;
    const inputs = Array.from(node.querySelectorAll?.('input') || []).slice(0, 10);
    return inputs.length <= 3;
  }

  function findPromoInputContainer(input) {
    if (!input || findPlatformPromoInput() !== input) return null;
    let node = input.parentElement;
    for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
      if (/^(?:BODY|HTML|MAIN)$/i.test(node.tagName || '')) break;
      const candidates = Array.from(node.querySelectorAll?.('button,[role="button"]') || []).filter((control) => controlTestId(control) === ALIEXPRESS_ICON_APPLY_TEST_ID);
      const boundary = /^(?:LABEL|FORM)$/i.test(node.tagName || '');
      const signature = normalize(`${node.className || ''} ${node.id || ''} ${node.getAttribute?.('data-testid') || ''} ${node.getAttribute?.('aria-label') || ''} ${node.innerText || node.textContent || ''}`);
      const semanticWrapper = boundary || /(?:simpleinput|couponv2|promo|voucher)/i.test(signature) || PLATFORM_PROMO_CONTROL.test(signature);
      if (candidates.length) {
        if (candidates.length !== 1 || !semanticWrapper || !compactPromoWrapper(node) || !basicApplyControlSafety(candidates[0])) return null;
        return node;
      }
      if (boundary) return null;
    }
    return null;
  }

  function isAliExpressIconApply(control, input) {
    if (controlTestId(control) !== ALIEXPRESS_ICON_APPLY_TEST_ID || !basicApplyControlSafety(control)) return false;
    const container = findPromoInputContainer(input); if (!container || !isWithin(container, control)) return false;
    const candidates = Array.from(container.querySelectorAll?.('button,[role="button"]') || []).filter((element) => controlTestId(element) === ALIEXPRESS_ICON_APPLY_TEST_ID);
    return candidates.length === 1 && candidates[0] === control;
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
    const aliExpressIconApply = isAliExpressIconApply(control, input);
    const explicitPromoAction = PROMO_WORD.test(label);
    if (Safety.isForbiddenActionLabel(label) || (!aliExpressIconApply && !APPLY_WORD.test(label)) || NEGATIVE_APPLY.test(label) || (!aliExpressIconApply && !explicitPromoAction && NEGATIVE_APPLY.test(context))) return -Infinity;
    if (aliExpressIconApply) return 260 + (normalize(control.getAttribute?.('type') || control.type || '').toLowerCase() === 'button' ? 20 : 0);
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

  function isConfirmedPromoApplyControl(control, input) {
    if (!control || !input || Safety.isForbiddenActionLabel(Safety.labelOf(control))) return false;
    if (isAliExpressIconApply(control, input)) return true;
    return scopedControls(input).includes(control) && scoreApplyControl(control, input) >= 90;
  }

  function clickConfirmedPromoApply(control, input, capture) {
    if (!capture || !isConfirmedPromoApplyControl(control, input)) return false;
    Safety.safeClick(control, { purpose: 'Применение промокода', intent: 'APPLY_PROMO', requirePattern: SAFE_APPLY_LABEL });
    capture.applyClicked = true; return true;
  }

  function applyControlDiagnostics(input = findPlatformPromoInput()) {
    const scoped = input ? scopedControls(input) : [];
    const rawCandidates = scoped.filter((control) => controlTestId(control) === ALIEXPRESS_ICON_APPLY_TEST_ID || APPLY_WORD.test(Safety.labelOf(control)));
    const selected = findApplyButton(input); const responseResolution = resolvePromoResponseContainer(input, selected); const evidenceTypes = [];
    if (selected && isAliExpressIconApply(selected, input)) {
      evidenceTypes.push('DATA_TESTID_BUTTON_APPLY', 'SAME_PLATFORM_PROMO_CONTAINER');
      if (normalize(selected.getAttribute?.('type') || selected.type || '').toLowerCase() === 'button') evidenceTypes.push('TYPE_BUTTON');
    } else if (selected) {
      evidenceTypes.push('TEXT_APPLY_ACTION', 'SCOPED_TO_PLATFORM_PROMO_INPUT');
    }
    return {
      applyCandidateCount: rawCandidates.length,
      selectedApplyFound: !!selected,
      selectedApplyEvidenceTypes: evidenceTypes,
      selectedApplyTestId: selected ? controlTestId(selected) || null : null,
      selectedApplyForbiddenLabel: selected ? Safety.isForbiddenActionLabel(Safety.labelOf(selected)) : null,
      responseContainerFound: !!responseResolution.element,
      responseContainerStrategy: responseResolution.strategy
    };
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

  function findRemoveButton(code, input = findPlatformPromoInput()) {
    const scoped = input ? scopedControls(input) : [];
    return Array.from(document.querySelectorAll('button,[role="button"],a')).slice(0, 1400)
      .map((element) => ({ element, score: scoreRemoveControl(element, { code, input, scoped }) }))
      .filter((row) => row.score >= 100).sort((a, b) => b.score - a.score)[0]?.element || null;
  }

  function findPlatformPromoRevealControl() {
    return Array.from(document.querySelectorAll('button,[role="button"],summary')).slice(0, 1200).find((element) => {
      const label = Safety.labelOf(element);
      return Safety.isVisible(element) && label.length <= 120 && PLATFORM_PROMO_CONTROL.test(label) && !GENERIC_COUPON_ACTION.test(label) && !Safety.isForbiddenActionLabel(label);
    }) || null;
  }

  async function ensurePromoInput() {
    let input = findPlatformPromoInput(); if (input) return input;
    const reveal = findPlatformPromoRevealControl(); if (!reveal) return null;
    Safety.safeClick(reveal, { purpose: 'Открытие поля промокода', intent: 'PROMO_SURFACE', requirePattern: PLATFORM_PROMO_CONTROL });
    await waitForCondition(() => findPlatformPromoInput(), 4000); input = findPlatformPromoInput(); return input;
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
      const observer = new MutationObserver((mutations) => {
        summaryRootCache = null;
        if (mutations.some((mutation) => mutation.target?.tagName === 'SCRIPT' || mutation.target?.parentElement?.tagName === 'SCRIPT' || Array.from(mutation.addedNodes || []).some((node) => node?.tagName === 'SCRIPT'))) structuredItemCache = null;
        finish('mutation');
      });
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
    if (summaryRootCache?.length && summaryRootCache.every((element) => element?.isConnected !== false)) return summaryRootCache;
    const selector = '[data-testid*="summary" i],[data-pl*="summary" i],[data-pl*="total" i],[class*="order-summary" i],[class*="checkout-summary" i],[aria-label*="order summary" i]';
    summaryRootCache = Array.from(document.querySelectorAll(selector)).filter(Safety.isVisible).slice(0, 80);
    return summaryRootCache;
  }

  function rowsFromNodes(nodes, source, visited) {
    const rows = [];
    for (const element of nodes) {
      if (visited.has(element) || !Safety.isVisible(element)) continue; visited.add(element);
      const text = normalize(element.innerText || element.textContent || '');
      if (!text || text.length > 220) continue;
      const conceptPatterns = {
        total: /(?:grand\s*total|order\s*total|amount\s*due|к\s*оплате|итого\s*к\s*оплате|общая\s*сумма|^(?:total|итого)(?:\s|:|$))/i,
        subtotal: /(?:sub\s*total|товар(?:ы|ов)?\s*(?:на|:)|сумма\s*товар|стоимость\s*товар|^(?:товары|items|merchandise)(?:\s|:|$))/i,
        shipping: /(?:shipping|delivery|достав|перевоз)/i,
        tax: /(?:tax|vat|ндс|налог|пошлин|тамож)/i,
        discount: /(?:discount|promotion|promo|coupon|скидк|купон|промокод|эконом)/i
      };
      const concepts = Object.entries(conceptPatterns).filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
      if (concepts.length !== 1) continue;
      const visibleChildren = Array.from(element.children || []).filter(Safety.isVisible).filter((child) => normalize(child.innerText || child.textContent || ''));
      if (visibleChildren.length > 3) continue;
      const kind = concepts[0];
      const quotes = P.extractPriceQuotes(text, 'CHECKOUT_SUMMARY').filter((row) => !row.isRange);
      const uniqueQuotes = [...new Map(quotes.map((row) => [`${row.value}|${row.currency || ''}`, row])).values()];
      const freeShipping = kind === 'shipping' && /(?:^|\s)(?:free|бесплатно)(?:\s|$)/i.test(text) && uniqueQuotes.length === 0;
      if (!freeShipping && uniqueQuotes.length !== 1) continue;
      const quote = freeShipping ? { value: 0, currency: null } : uniqueQuotes[0];
      let confidence = source === 'FALLBACK' ? 45 : 65;
      if (/(grand\s*total|order\s*total|к\s*оплате|итого\s*к\s*оплате)/i.test(text)) confidence += 25;
      if (freeShipping) confidence += 25;
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

  function safeIdentityHash(value) { return P.identityTextHash(normalize(value)); }

  let lastVisibleLineDetection = { strategy: 'NONE', anchorSignals: [] };

  function isWithin(root, element) {
    for (let node = element; node; node = node.parentElement) if (node === root) return true;
    return false;
  }

  function isOldLinePrice(element) {
    for (let node = element, depth = 0; node && depth < 3; node = node.parentElement, depth += 1) {
      if (/^(?:DEL|S)$/i.test(node.tagName || '') || /(?:old|original|line-through)/i.test(normalize(`${node.className || ''} ${node.getAttribute?.('data-testid') || ''}`))) return true;
      const decoration = getComputedStyle(node).textDecorationLine || getComputedStyle(node).textDecoration || '';
      if (/line-through/i.test(decoration)) return true;
    }
    return false;
  }

  function explicitLineQuantity(root, descendants = []) {
    const quantityElement = root.querySelector?.('input[name*="quant" i],input[id*="quant" i],input[aria-label*="quant" i],select[name*="quant" i],[data-quantity]');
    const explicit = attributeFrom(root, ['data-quantity']) || quantityElement?.value || normalize(root.innerText || root.textContent || '').match(/(?:qty|quantity|кол(?:-?во|ичество))\s*[:×x]?\s*(\d{1,3})(?:\s|$)/i)?.[1] || normalize(root.innerText || root.textContent || '').match(/(?:^|\s)(\d{1,3})\s*(?:шт\.?|pcs?|pieces?)(?:\s|$)/i)?.[1];
    if (explicit !== null && explicit !== undefined && explicit !== '' && Number.isFinite(Number(explicit)) && Number(explicit) > 0 && Number(explicit) <= 999) return { value: Number(explicit), control: !!quantityElement || /(?:qty|quantity|кол(?:-?во|ичество)|шт\.?|pcs?|pieces?)/i.test(normalize(root.innerText || root.textContent || '')) };
    const controls = descendants.filter(Safety.isVisible).map((element, index) => ({ element, index, label: normalize(element.innerText || element.textContent || element.getAttribute?.('aria-label') || '') }));
    const minus = controls.find((row) => /^(?:-|−|–|minus|decrement|уменьшить)$/i.test(row.label));
    const plus = controls.find((row) => /^(?:\+|plus|increment|увеличить)$/i.test(row.label));
    if (!minus || !plus || minus.index >= plus.index) return { value: null, control: false };
    const number = controls.find((row) => row.index > minus.index && row.index < plus.index && /^\d{1,3}$/.test(row.label));
    const value = number ? Number(number.label) : null;
    return { value: Number.isFinite(value) && value > 0 && value <= 999 ? value : null, control: Number.isFinite(value) && value > 0 && value <= 999 };
  }

  function linePriceFromElements(elements, recent = null) {
    const matches = [];
    for (const element of elements) {
      if (!Safety.isVisible(element) || isOldLinePrice(element)) continue;
      const text = normalize(element.innerText || element.textContent || '');
      if (!text || text.length > 120 || /(?:shipping|delivery|достав|итого|order\s*total|total|tax|налог)/i.test(text)) continue;
      const quotes = P.extractPriceQuotes(text, 'CHECKOUT_LINE').filter((row) => !row.isRange && row.currency);
      for (const quote of quotes) {
        if (recent && (quote.currency !== recent.currency || Math.abs(quote.value - recent.price) > 0.01)) continue;
        matches.push({ value: quote.value, currency: quote.currency, element });
      }
    }
    const unique = [...new Map(matches.map((row) => [`${row.value}|${row.currency}`, row])).values()];
    return unique.length === 1 ? unique[0] : null;
  }

  function selectorCheckoutLines(scope) {
    if (!scope.strong) return [];
    const selector = '[data-testid*="line-item" i],[data-pl*="line-item" i],[data-testid*="order-item" i],[data-pl*="order-item" i],[data-testid*="cart-item" i],[data-pl*="cart-item" i],[class*="checkout-item" i],[class*="order-item" i],[class*="cart-item" i]';
    const rawRoots = [...new Set(Array.from(document.querySelectorAll(selector)).filter(Safety.isVisible).slice(0, 120))];
    const roots = rawRoots.filter((root) => !rawRoots.some((candidate) => candidate !== root && root.contains?.(candidate)));
    const safeText = (element) => {
      const text = normalize(element?.innerText || element?.textContent || element?.getAttribute?.('aria-label') || '');
      if (!text || text.length > 260 || /(?:recipient|получател|телефон|phone|address|адрес|достав|shipping|итого|total|tax|налог)/i.test(text)) return null;
      return text;
    };
    const findText = (root, selectors) => {
      for (const childSelector of selectors) { const text = safeText(root.querySelector?.(childSelector)); if (text) return text; }
      return null;
    };
    const lines = [];
    for (const root of roots) {
      if (isRecommendationLink(root)) continue;
      const title = findText(root, ['[data-testid*="title" i]', '[data-pl*="title" i]', '[class*="item-title" i]', '[class*="product-title" i]', 'a[href*="/item/"]']);
      const variant = findText(root, ['[data-testid*="variant" i]', '[data-testid*="option" i]', '[data-pl*="variant" i]', '[class*="variant" i]', '[class*="sku-info" i]', '[class*="option" i]'])
        ?.replace(/^(?:цвет|color|вариант|variant|variation|комплектация|configuration|версия|version|размер|size)\s*:\s*/i, '') || null;
      const descendants = Array.from(root.querySelectorAll?.('button,[role="button"],span,input,select') || []).slice(0, 250);
      const quantity = explicitLineQuantity(root, descendants).value;
      const priceElements = [];
      for (const priceSelector of ['[data-testid*="line-price" i]', '[data-testid*="item-price" i]', '[data-pl*="line-price" i]', '[data-pl*="item-price" i]', '[class*="line-price" i]', '[class*="item-price" i]', '[class*="product-price" i]']) {
        const element = root.querySelector?.(priceSelector); if (element) priceElements.push(element);
      }
      const price = linePriceFromElements([...new Set(priceElements)]);
      if (!(title || variant || Number.isFinite(quantity) || price)) continue;
      lines.push({ titleHash: safeIdentityHash(title), variantHash: safeIdentityHash(variant), quantity, price: price?.value ?? null, currency: price?.currency || null });
    }
    return lines;
  }

  function recentHashAnchorCheckoutLines(scope) {
    const recentState = recentProductContextState(); const recent = recentState.context;
    if (!scope.strong || !recent?.titleHash || !Number.isFinite(recent.price) || !recent.currency) return [];
    const compact = Array.from(document.querySelectorAll('div,span,p,a,strong,b,label')).filter(Safety.isVisible).slice(0, 3500)
      .filter((element) => { const text = normalize(element.innerText || element.textContent || ''); return text && text.length <= 260; });
    const titleAnchors = compact.filter((element) => safeIdentityHash(element.innerText || element.textContent || '') === recent.titleHash);
    const variantAnchors = recent.variantHash ? compact.filter((element) => safeIdentityHash((element.innerText || element.textContent || '').replace(/^(?:цвет|color|вариант|variant|variation|комплектация|configuration|версия|version|размер|size)\s*:\s*/i, '')) === recent.variantHash) : [];
    const observedSignals = new Set(); if (titleAnchors.length) observedSignals.add('TITLE_HASH'); if (variantAnchors.length) observedSignals.add('VARIANT_HASH');
    const bestByAnchor = [];
    for (const anchor of titleAnchors.slice(0, 8)) {
      const candidates = []; let root = anchor.parentElement;
      for (let depth = 0; root && depth < 8; depth += 1, root = root.parentElement) {
        if (/^(?:BODY|HTML)$/i.test(root.tagName || '') || !Safety.isVisible(root)) continue;
        const text = normalize(root.innerText || root.textContent || ''); const rect = root.getBoundingClientRect?.() || {};
        if (!text || text.length > 1200 || Number(rect.width) > 1800 || Number(rect.height) > 720) continue;
        if (/(?:recipient|получател|телефон|phone|address|адрес|итого|order\s*total|доставка|shipping|налог|tax)/i.test(text)) continue;
        const titlesInside = titleAnchors.filter((element) => isWithin(root, element));
        if (titlesInside.length !== 1) continue;
        const variantInside = recent.variantHash ? variantAnchors.filter((element) => isWithin(root, element)) : [];
        if (recent.variantHash && variantInside.length !== 1) continue;
        const descendants = compact.filter((element) => element !== root && isWithin(root, element));
        const price = linePriceFromElements(descendants, recent); if (!price) continue;
        const quantity = explicitLineQuantity(root, descendants); const image = root.querySelector?.('img,picture,[role="img"]');
        const signals = ['TITLE_HASH', 'LINE_PRICE']; if (recent.variantHash) signals.push('VARIANT_HASH');
        if (quantity.control) signals.push('QUANTITY_CONTROL'); if (image && Safety.isVisible(image)) signals.push('PRODUCT_VISUAL');
        candidates.push({ root, textLength: text.length, area: Math.max(0, Number(rect.width) || 0) * Math.max(0, Number(rect.height) || 0), line: { titleHash: recent.titleHash, variantHash: recent.variantHash || null, quantity: quantity.value, price: price.value, currency: price.currency }, signals });
      }
      candidates.sort((a, b) => a.textLength - b.textLength || a.area - b.area);
      if (candidates[0]) bestByAnchor.push(candidates[0]);
    }
    const uniqueRoots = [...new Map(bestByAnchor.map((row) => [row.root, row])).values()];
    if (uniqueRoots.length !== 1) { lastVisibleLineDetection = { strategy: 'NONE', anchorSignals: [...observedSignals] }; return []; }
    uniqueRoots[0].signals.forEach((signal) => observedSignals.add(signal));
    lastVisibleLineDetection = { strategy: 'RECENT_HASH_ANCHOR', anchorSignals: [...observedSignals] };
    return [uniqueRoots[0].line];
  }

  function visibleCheckoutLines(scope) {
    lastVisibleLineDetection = { strategy: 'NONE', anchorSignals: [] };
    const selectorLines = selectorCheckoutLines(scope);
    if (selectorLines.length) {
      const signals = new Set();
      if (selectorLines.some((line) => line.titleHash)) signals.add('TITLE_HASH');
      if (selectorLines.some((line) => line.variantHash)) signals.add('VARIANT_HASH');
      if (selectorLines.some((line) => Number.isFinite(line.price))) signals.add('LINE_PRICE');
      if (selectorLines.some((line) => Number.isFinite(line.quantity))) signals.add('QUANTITY_CONTROL');
      lastVisibleLineDetection = { strategy: 'SELECTOR', anchorSignals: [...signals] };
      return selectorLines;
    }
    return recentHashAnchorCheckoutLines(scope);
  }

  function checkoutIdentityScopeEvidence() {
    const pageType = P.parsePageType(location.href); const evidenceTypes = [];
    const routeMatched = ['CART', 'CHECKOUT'].includes(pageType); if (routeMatched) evidenceTypes.push(`CHECKOUT_${pageType}_ROUTE`);
    const marker = document.querySelector('[data-testid*="checkout" i],[data-pl*="checkout" i],[data-testid*="order-confirm" i],[data-pl*="order-confirm" i],[id*="checkout" i],[class*="checkout-page" i],[class*="order-confirm" i]');
    const markerFound = !!(marker && Safety.isVisible(marker)); if (markerFound) evidenceTypes.push('CHECKOUT_DOM_MARKER');
    const headings = Array.from(document.querySelectorAll('h1,h2,[role="heading"],[aria-level]')).filter(Safety.isVisible).slice(0, 120);
    const headingFound = headings.some((element) => /^(?:оформление\s+заказа|подтверждение\s+заказа|checkout|order\s+(?:confirmation|review)|shopping\s+cart|корзина)(?:\s|$)/i.test(normalize(element.innerText || element.textContent || '')));
    if (headingFound) evidenceTypes.push('CHECKOUT_HEADING');
    const promoFound = !!(findPlatformPromoInput() || findPlatformPromoRevealControl()); if (promoFound) evidenceTypes.push('CHECKOUT_PROMO_CONTROL');
    const orderActionFound = Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"]')).filter(Safety.isVisible).slice(0, 500)
      .some((element) => /^(?:оформить\s+заказ|разместить\s+заказ|подтвердить\s+заказ|place\s+order|submit\s+order|confirm\s+order)$/i.test(Safety.labelOf(element)));
    if (orderActionFound) evidenceTypes.push('CHECKOUT_ORDER_ACTION_READ_ONLY');
    const strong = routeMatched || (markerFound && (headingFound || promoFound || orderActionFound)) || (headingFound && (promoFound || orderActionFound)) || (promoFound && orderActionFound);
    return { strong, pageType, routeMatched, markerFound, headingFound, promoFound, orderActionFound, evidenceTypes };
  }

  let structuredItemCache = null;
  function emptyStructuredDiagnostics(scopeEvidence = []) {
    const recent = recentProductContextState();
    return {
      structuredCandidateCount: 0, structuredCheckoutScopedCount: 0, structuredUniqueItemIds: 0, structuredUniqueSkuIds: 0,
      structuredConflicts: [], structuredEvidenceTypes: scopeEvidence.slice(),
      recentProductContextAvailable: recent.available, recentProductContextFresh: recent.fresh,
      recentProductExactItemMatchCount: 0, recentProductExactSkuMatchCount: 0,
      visibleLineCount: 0, visibleLinesWithTitle: 0, visibleLinesWithVariant: 0, visibleLinesWithQuantity: 0, visibleLinesWithPrice: 0,
      visibleLineDetectionStrategy: 'NONE', visibleLineAnchorSignals: [],
      structuredMatchedLineCount: 0, structuredUnmatchedCandidateCount: 0, winningEvidenceTypes: []
    };
  }
  let lastStructuredDiagnostics = emptyStructuredDiagnostics();

  function correlationEvidence(group, line, recentState) {
    const evidence = []; const skuId = group.skuIds.size === 1 ? [...group.skuIds][0] : null;
    const recent = recentState.context;
    const recentExactItem = !!(recent && group.itemId === recent.itemId);
    const recentExactSku = !!(recent && skuId && skuId === recent.skuId);
    const recentCompatible = recentExactItem && recentExactSku &&
      !(line.variantHash && recent.variantHash && line.variantHash !== recent.variantHash) &&
      !(Number.isFinite(line.price) && (line.currency !== recent.currency || Math.abs(line.price - recent.price) > 0.01));
    const titleMatch = !!(line.titleHash && (group.titleHashes.has(line.titleHash) || (recentCompatible && recent.titleHash === line.titleHash)));
    const variantMatch = !!(line.variantHash && (group.variantHashes.has(line.variantHash) || (recentCompatible && recent.variantHash === line.variantHash)));
    const quantityMatch = Number.isFinite(line.quantity) && group.quantities.size === 1 && group.quantities.has(line.quantity);
    const priceMatch = Number.isFinite(line.price) && (
      [...group.prices].some((value) => Math.abs(value - line.price) <= 0.01) && (!group.currencies.size || group.currencies.has(line.currency)) ||
      recentCompatible && Math.abs(recent.price - line.price) <= 0.01 && recent.currency === line.currency
    );
    if (titleMatch) evidence.push('TITLE_MATCH');
    if (variantMatch) evidence.push('VARIANT_MATCH');
    if (quantityMatch) evidence.push('QUANTITY_MATCH');
    if (priceMatch) evidence.push('LINE_PRICE_MATCH');
    if (recentExactItem && recentCompatible) evidence.push('RECENT_ITEM_MATCH');
    if (recentExactSku && recentCompatible) evidence.push('RECENT_SKU_MATCH');
    if (skuId) evidence.push('EXPLICIT_SKU');
    const visibleCount = evidence.filter((value) => ['TITLE_MATCH', 'VARIANT_MATCH', 'QUANTITY_MATCH', 'LINE_PRICE_MATCH'].includes(value)).length;
    const usesRecent = evidence.includes('RECENT_ITEM_MATCH') || evidence.includes('RECENT_SKU_MATCH');
    const eligible = group.skuIds.size <= 1 && visibleCount >= 2 && (!usesRecent || (evidence.includes('RECENT_ITEM_MATCH') && evidence.includes('RECENT_SKU_MATCH')));
    const score = visibleCount * 10 + (evidence.includes('RECENT_ITEM_MATCH') ? 3 : 0) + (evidence.includes('RECENT_SKU_MATCH') ? 3 : 0) + (skuId ? 2 : 0);
    return { group, line, evidence, visibleCount, eligible, score };
  }

  function selectCorroboratedStructuredGroup(groups, visibleLines, recentState) {
    if (groups.length < 2 || visibleLines.length !== 1) return null;
    const ranked = groups.map((group) => correlationEvidence(group, visibleLines[0], recentState)).sort((a, b) => b.score - a.score);
    const winner = ranked[0]; const runnerUp = ranked[1];
    if (!winner?.eligible || !runnerUp || winner.score - runnerUp.score < 8) return null;
    if (ranked.filter((row) => row.score === winner.score).length !== 1) return null;
    return winner;
  }

  function structuredCheckoutItems(visibleIds, scope = checkoutIdentityScopeEvidence(), visibleLines = []) {
    if (!scope.strong && !visibleIds.size) {
      lastStructuredDiagnostics = emptyStructuredDiagnostics(scope.evidenceTypes);
      return [];
    }
    const scripts = Array.from(document.querySelectorAll('script[type="application/json"],script#__NEXT_DATA__,script[id*="data" i],script[id*="state" i],script[data-state],script[data-hydration]')).slice(0, 40);
    const pathname = (() => { try { return new URL(location.href).pathname; } catch (_) { return ''; } })();
    const recentState = recentProductContextState();
    const visibleKey = [...visibleIds].sort().join(','); const lengths = scripts.map((script) => String(script.textContent || '').length); const scopeKey = `${scope.strong}|${scope.evidenceTypes.join(',')}`;
    const correlationKey = JSON.stringify({ visibleLines, recent: recentState.context });
    if (structuredItemCache?.pathname === pathname && structuredItemCache.visibleKey === visibleKey && structuredItemCache.scopeKey === scopeKey && structuredItemCache.correlationKey === correlationKey && structuredItemCache.scripts.length === scripts.length &&
      structuredItemCache.scripts.every((script, index) => script === scripts[index] && structuredItemCache.lengths[index] === lengths[index])) {
      lastStructuredDiagnostics = structuredItemCache.diagnostics; return structuredItemCache.items;
    }
    const accepted = []; const evidenceTypes = new Set(scope.evidenceTypes); let visited = 0; let totalBytes = 0; let candidateCount = 0; let scopedCount = 0;
    const field = (object, names) => {
      for (const name of names) {
        const key = Object.keys(object).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
        const value = key ? object[key] : null;
        if (typeof value === 'string') return value;
        if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
      }
      return null;
    };
    const walk = (value, path = []) => {
      if (!value || typeof value !== 'object' || visited++ > 60_000) return;
      if (!Array.isArray(value)) {
        const rawItemId = field(value, ['itemId', 'item_id', 'productId', 'product_id']);
        const itemId = /^\d{6,24}$/.test(rawItemId || '') ? rawItemId : null;
        if (itemId) {
          candidateCount += 1;
          const pathText = path.join('.').toLowerCase();
          const excluded = /(recommend|suggest|similar|search|history|recent|wishlist|favorite|you.?may.?like)/i.test(pathText);
          const checkoutScoped = !excluded && (/(?:checkout|order|cart|purchase|trade)[^.]*\.(?:[^.]*\.){0,2}(?:items?|lines?|products?)(?:\.|$)|(?:checkoutitems?|orderitems?|cartitems?|lineitems?|orderlines?|purchaseitems?)(?:\.|$)/i.test(pathText));
          if (checkoutScoped) scopedCount += 1;
          if (excluded) evidenceTypes.add('EXCLUDED_NON_PURCHASE_COLLECTION');
          const visibleMatch = visibleIds.has(itemId);
          const permitted = visibleIds.size ? visibleMatch : scope.strong && checkoutScoped;
          if (!permitted || excluded) {
            for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
            return;
          }
          evidenceTypes.add(visibleMatch ? 'VISIBLE_ITEM_MATCH' : 'CHECKOUT_SCOPED_JSON');
          const rawSku = field(value, ['skuId', 'sku_id', 'selectedSkuId', 'selected_sku_id', 'variantId', 'variant_id']);
          const rawQuantity = field(value, ['quantity', 'qty', 'buyCount', 'buy_count']);
          const quantity = Number.isFinite(Number(rawQuantity)) && Number(rawQuantity) > 0 && Number(rawQuantity) <= 999 ? Number(rawQuantity) : null;
          const rawTitle = field(value, ['title', 'itemTitle', 'item_title', 'productTitle', 'product_title', 'name']);
          const rawVariant = field(value, ['variant', 'variantName', 'variant_name', 'skuName', 'sku_name', 'selectedVariant', 'selected_variant', 'options']);
          const rawCurrency = field(value, ['currency', 'currencyCode', 'currency_code', 'priceCurrency']);
          const rawPrice = field(value, ['linePrice', 'line_price', 'itemPrice', 'item_price', 'salePrice', 'sale_price', 'price']);
          const price = P.parseLocalizedNumber(rawPrice);
          accepted.push({
            itemId, skuId: rawSku && /^[A-Za-z0-9_-]{1,100}$/.test(rawSku) ? rawSku : null, quantity, sellerId: null,
            titleHash: safeIdentityHash(rawTitle), variantHash: safeIdentityHash(rawVariant),
            price: Number.isFinite(price) ? price : null, currency: /^[A-Z]{3}$/.test(String(rawCurrency || '').toUpperCase()) ? String(rawCurrency).toUpperCase() : null,
            rootEvidence: true, evidenceSource: 'STRUCTURED'
          });
        }
      }
      if (Array.isArray(value)) value.forEach((child) => walk(child, [...path, '[]']));
      else for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
    };
    for (const script of scripts) {
      const text = String(script.textContent || '').trim(); totalBytes += text.length;
      if (!text || text.length > 1_000_000 || totalBytes > 2_000_000 || !/^[{[]/.test(text)) continue;
      try { walk(JSON.parse(text), []); } catch (_) {}
    }
    const grouped = new Map(); const conflicts = [];
    for (const row of accepted.slice(0, 300)) {
      const group = grouped.get(row.itemId) || { itemId: row.itemId, skuIds: new Set(), quantities: new Set(), titleHashes: new Set(), variantHashes: new Set(), prices: new Set(), currencies: new Set() };
      if (row.skuId) group.skuIds.add(row.skuId);
      if (Number.isFinite(row.quantity)) group.quantities.add(row.quantity);
      if (row.titleHash) group.titleHashes.add(row.titleHash);
      if (row.variantHash) group.variantHashes.add(row.variantHash);
      if (Number.isFinite(row.price)) group.prices.add(row.price);
      if (row.currency) group.currencies.add(row.currency);
      grouped.set(row.itemId, group);
    }
    for (const group of grouped.values()) {
      if (group.skuIds.size > 1) conflicts.push('CONFLICTING_SKU_IDS');
      if (group.quantities.size > 1) conflicts.push('CONFLICTING_QUANTITIES');
    }
    const groupedValues = [...grouped.values()];
    const corroborated = !visibleIds.size ? selectCorroboratedStructuredGroup(groupedValues, visibleLines, recentState) : null;
    if (!visibleIds.size && grouped.size > 1 && !corroborated) conflicts.push('COMPETING_ITEM_IDS_WITHOUT_DOM_CORROBORATION');
    if (corroborated) { conflicts.push('COMPETING_ITEM_IDS_RESOLVED_BY_CORROBORATION'); corroborated.evidence.forEach((value) => evidenceTypes.add(value)); }
    const selectedGroups = !visibleIds.size && grouped.size > 1 ? (corroborated ? [corroborated.group] : []) : groupedValues;
    const items = selectedGroups.map((group) => ({
      itemId: group.itemId,
      skuId: group.skuIds.size === 1 ? [...group.skuIds][0] : null,
      quantity: group.quantities.size === 1 ? [...group.quantities][0] : null,
      sellerId: null,
      rootEvidence: true,
      evidenceSource: 'STRUCTURED'
    }));
    const uniqueSkus = new Set(accepted.map((row) => row.skuId).filter(Boolean));
    const recent = recentState.context;
    const diagnostics = {
      structuredCandidateCount: candidateCount,
      structuredCheckoutScopedCount: scopedCount,
      structuredUniqueItemIds: grouped.size,
      structuredUniqueSkuIds: uniqueSkus.size,
      structuredConflicts: [...new Set(conflicts)],
      structuredEvidenceTypes: [...evidenceTypes],
      recentProductContextAvailable: recentState.available,
      recentProductContextFresh: recentState.fresh,
      recentProductExactItemMatchCount: recent ? groupedValues.filter((group) => group.itemId === recent.itemId).length : 0,
      recentProductExactSkuMatchCount: recent ? groupedValues.filter((group) => group.skuIds.has(recent.skuId)).length : 0,
      visibleLineCount: visibleLines.length,
      visibleLinesWithTitle: visibleLines.filter((line) => !!line.titleHash).length,
      visibleLinesWithVariant: visibleLines.filter((line) => !!line.variantHash).length,
      visibleLinesWithQuantity: visibleLines.filter((line) => Number.isFinite(line.quantity)).length,
      visibleLinesWithPrice: visibleLines.filter((line) => Number.isFinite(line.price) && !!line.currency).length,
      visibleLineDetectionStrategy: lastVisibleLineDetection.strategy,
      visibleLineAnchorSignals: lastVisibleLineDetection.anchorSignals.slice(),
      structuredMatchedLineCount: corroborated ? 1 : 0,
      structuredUnmatchedCandidateCount: Math.max(0, grouped.size - (corroborated ? 1 : items.length)),
      winningEvidenceTypes: corroborated ? corroborated.evidence.slice() : []
    };
    lastStructuredDiagnostics = diagnostics;
    structuredItemCache = { pathname, visibleKey, scopeKey, correlationKey, scripts, lengths, items, diagnostics }; return items;
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
    const scope = checkoutIdentityScopeEvidence();
    const visibleLines = visibleCheckoutLines(scope);
    const links = scope.strong ? visibleItemLinks() : [];
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
    return mergeCheckoutItems([...rows, ...structuredCheckoutItems(visibleIds, scope, visibleLines)]);
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
    const platformPromoInputFound = !!findPlatformPromoInput();
    const platformPromoRevealFound = !!findPlatformPromoRevealControl();
    const promoFound = platformPromoInputFound || platformPromoRevealFound; if (promoFound) signals.push('PROMO_CONTROL');
    const totalFound = Number.isFinite(state.financial?.total) && (state.breakdown?.candidates || []).some((row) => row.kind === 'total');
    if (totalFound) signals.push('ORDER_TOTAL');
    const orderActionFound = Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"]')).filter(Safety.isVisible).slice(0, 800).some((element) => /^(?:оформить\s+заказ|разместить\s+заказ|подтвердить\s+заказ|place\s+order|submit\s+order|confirm\s+order)$/i.test(Safety.labelOf(element)));
    if (orderActionFound) signals.push('ORDER_ACTION_READ_ONLY');
    const candidate = urlMatched || markerFound || headingFound || orderActionFound || (promoFound && totalFound);
    const detected = urlMatched || (markerFound && (headingFound || promoFound || totalFound || orderActionFound)) || (headingFound && (promoFound || totalFound || orderActionFound)) || (promoFound && totalFound && orderActionFound);
    return { candidate, detected, pageClass: pageType === 'CART' ? 'CART' : 'CHECKOUT', signals, urlMatched, markerFound, headingFound, promoFound, platformPromoInputFound, platformPromoRevealFound, totalFound, orderActionFound };
  }

  function effectiveCheckoutBinding(checkout = null) {
    const pageType = P.parsePageType(location.href); const surface = checkoutSurfaceEvidence({ pageType, checkout });
    return { binding: C.checkoutBinding(location.href, surface.detected ? surface.pageClass : pageType), pageType, surface };
  }

  function safeWidgetDiagnostics(context, checkout) {
    const fingerprint = checkout.fingerprint || {}; const items = fingerprint.items || [];
    let pathname = null; try { pathname = new URL(location.href).pathname; } catch (_) {}
    const input = findPlatformPromoInput(); const reveal = findPlatformPromoRevealControl(); const applyDiagnostics = applyControlDiagnostics(input);
    const selectors = { inputFound: !!input, applyFound: applyDiagnostics.selectedApplyFound, revealFound: !!reveal, ...applyDiagnostics };
    return {
      pathname,
      pageType: context.pageType,
      checkoutSurfaceDetected: context.checkoutSurfaceDetected,
      checkoutSurfaceSignals: context.checkoutSurfaceSignals,
      promoTestingSurface: context.promoTestingSurface,
      countryDetection: { countryCode: context.countryCode || null, source: context.countrySource || 'NONE', strong: context.countrySignal?.strong === true },
      platformPromoInputFound: selectors.inputFound,
      platformPromoRevealFound: selectors.revealFound,
      financial: C.buildFinancialSnapshot(checkout.financial),
      fingerprint: { quality: fingerprint.quality || 'WEAK', componentsUsed: Array.isArray(fingerprint.componentsUsed) ? fingerprint.componentsUsed.slice() : [] },
      items: {
        count: items.length,
        itemIdDetected: items.filter((row) => !!row.itemId).length,
        skuIdDetected: items.filter((row) => !!row.skuId).length,
        quantityDetected: items.filter((row) => Number.isFinite(row.quantity)).length
      },
      structured: {
        structuredCandidateCount: lastStructuredDiagnostics.structuredCandidateCount,
        structuredCheckoutScopedCount: lastStructuredDiagnostics.structuredCheckoutScopedCount,
        structuredUniqueItemIds: lastStructuredDiagnostics.structuredUniqueItemIds,
        structuredUniqueSkuIds: lastStructuredDiagnostics.structuredUniqueSkuIds,
        structuredConflicts: lastStructuredDiagnostics.structuredConflicts.slice(),
        structuredEvidenceTypes: lastStructuredDiagnostics.structuredEvidenceTypes.slice(),
        recentProductContextAvailable: lastStructuredDiagnostics.recentProductContextAvailable,
        recentProductContextFresh: lastStructuredDiagnostics.recentProductContextFresh,
        recentProductExactItemMatchCount: lastStructuredDiagnostics.recentProductExactItemMatchCount,
        recentProductExactSkuMatchCount: lastStructuredDiagnostics.recentProductExactSkuMatchCount,
        visibleLineCount: lastStructuredDiagnostics.visibleLineCount,
        visibleLinesWithTitle: lastStructuredDiagnostics.visibleLinesWithTitle,
        visibleLinesWithVariant: lastStructuredDiagnostics.visibleLinesWithVariant,
        visibleLinesWithQuantity: lastStructuredDiagnostics.visibleLinesWithQuantity,
        visibleLinesWithPrice: lastStructuredDiagnostics.visibleLinesWithPrice,
        visibleLineDetectionStrategy: lastStructuredDiagnostics.visibleLineDetectionStrategy,
        visibleLineAnchorSignals: lastStructuredDiagnostics.visibleLineAnchorSignals.slice(),
        structuredMatchedLineCount: lastStructuredDiagnostics.structuredMatchedLineCount,
        structuredUnmatchedCandidateCount: lastStructuredDiagnostics.structuredUnmatchedCandidateCount,
        winningEvidenceTypes: lastStructuredDiagnostics.winningEvidenceTypes.slice()
      },
      selectors: { inputFound: selectors.inputFound, applyFound: selectors.applyFound, revealFound: selectors.revealFound, applyCandidateCount: selectors.applyCandidateCount, selectedApplyFound: selectors.selectedApplyFound, selectedApplyEvidenceTypes: selectors.selectedApplyEvidenceTypes.slice(), selectedApplyTestId: selectors.selectedApplyTestId, selectedApplyForbiddenLabel: selectors.selectedApplyForbiddenLabel, responseContainerFound: selectors.responseContainerFound, responseContainerStrategy: selectors.responseContainerStrategy }
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
    if (activePromoResponseCapture) {
      const evidence = updatePromoResponseCapture(); return evidence?.responseSnippet || '';
    }
    return collectPromoResponseFragments(input).map((row) => row.text).slice(0, 5).join('\n');
  }

  async function waitForPromoResponseCleared(previousSnippet, timeoutMs = 650) {
    const input = findPlatformPromoInput(); const applyButton = findApplyButton(input); const scope = findPromoResponseContainer(input, applyButton);
    if (!input || !scope) return false;
    const previous = safePromoResponseText(previousSnippet || ''); const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const fragments = collectPromoResponseFragments(input, applyButton, scope);
      const unchanged = previous && fragments.some((row) => row.text === previous);
      if (!unchanged && input.getAttribute?.('aria-invalid') !== 'true') return true;
      await waitForDomSignal(Math.max(1, Math.min(175, timeoutMs - (Date.now() - started))));
    }
    return false;
  }

  function appliedIndicator(code, input = findPlatformPromoInput()) {
    const upper = String(code || '').toUpperCase(); const localCandidates = []; let node = input?.parentElement; let localRoot = null;
    for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
      localCandidates.push(node);
      const metadata = responseContainerMetadata(node); const text = normalize(node.innerText || node.textContent || '');
      if (!localRoot && (RESPONSE_CONTAINER_SEMANTIC.test(metadata) || PLATFORM_PROMO_CONTROL.test(text) || (depth === 0 && APPLIED_TEXT.test(text) && PROMO_WORD.test(text)))) localRoot = node;
    }
    const localDescendants = Array.from(localRoot?.querySelectorAll?.('[class*="promo" i],[class*="coupon" i],[class*="voucher" i],[aria-live],[role="status"],[role="alert"]') || []).slice(0, 120);
    const globalCandidates = Array.from(document.querySelectorAll('[class*="promo" i],[class*="coupon" i],[class*="voucher" i],[aria-live],[role="status"],[role="alert"]')).slice(0, 600);
    const candidates = [...new Set([...localCandidates, ...localDescendants, ...globalCandidates])];
    let best = { applied: false, confidence: 0, evidenceType: null, snippet: null };
    for (const element of candidates) {
      if (!Safety.isVisible(element)) continue;
      const text = normalize(element.innerText || element.textContent || element.getAttribute?.('aria-label') || ''); if (!text || text.length > 1200) continue;
      const context = normalize(`${text} ${element.parentElement?.innerText || element.parentElement?.textContent || ''}`).slice(0, 1800);
      const promoLocal = !!localRoot && isWithin(localRoot, element); let confidence = 0; let evidenceType = null;
      if (upper && context.toUpperCase().includes(upper) && /(?:applied|active|selected|примен[её]н|актив|удалить|remove)/i.test(context)) { confidence = 95; evidenceType = 'CODE_AND_STATE'; }
      else if (promoLocal && APPLIED_TEXT.test(context) && PROMO_WORD.test(context)) { confidence = 82; evidenceType = 'LOCAL_PROMO_SUCCESS_TEXT'; }
      const remove = promoLocal ? Array.from(element.querySelectorAll?.('button,[role="button"],a') || []).find((control) => scoreRemoveControl(control, { code, input }) >= 100) : null;
      if (remove && confidence < 85) { confidence = 85; evidenceType = 'PROMO_REMOVE_CONTROL'; }
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

  const CHALLENGE_SELECTOR = 'iframe,[role="dialog"],[aria-modal="true"],[role="alert"],[id*="captcha" i],[class*="captcha" i],[data-testid*="captcha" i],[id*="geetest" i],[class*="geetest" i],[id*="challenge" i],[class*="challenge" i],[id*="security" i],[class*="security" i],[class*="modal" i]';
  const CHALLENGE_STRONG_TEXT = /(?:captcha|geetest|security\s*verification|verify\s*(?:you\s*are\s*)?human|robot\s*verification|slide\s*to\s*verify|провер(?:ка|ьте).*(?:робот|безопасност)|验证码|滑块)/i;
  const CHALLENGE_BRANDED_TEXT = /(?:(?:aliexpress|alibaba).{0,40}(?:security|challenge)|(?:security|challenge).{0,40}(?:aliexpress|alibaba)|security\s*challenge)/i;
  const CHALLENGE_METADATA = /(?:captcha|geetest|(?:^|[-_\s])challenge(?:[-_\s]|$)|security[^\s]{0,50}(?:challenge|verification|verify|check)|human[-_\s]*verification|robot[-_\s]*verification)/i;

  function visibleSecurityChallenge() {
    const candidates = Array.from(document.querySelectorAll(CHALLENGE_SELECTOR)).slice(0, 500);
    for (const element of candidates) {
      if (!Safety.isVisible(element)) continue;
      const metadata = normalize(`${element.id || ''} ${element.className || ''} ${element.getAttribute?.('data-testid') || ''} ${element.getAttribute?.('aria-label') || ''} ${element.getAttribute?.('title') || ''} ${element.getAttribute?.('src') || ''} ${element.getAttribute?.('name') || ''}`).slice(0, 1000);
      const text = normalize(element.innerText || element.textContent || '').slice(0, 2000);
      const iframe = String(element.tagName || '').toUpperCase() === 'IFRAME'; const dialog = element.getAttribute?.('role') === 'dialog' || element.getAttribute?.('aria-modal') === 'true' || /modal/i.test(String(element.className || ''));
      if (CHALLENGE_STRONG_TEXT.test(text) || CHALLENGE_BRANDED_TEXT.test(text) || CHALLENGE_BRANDED_TEXT.test(metadata) || CHALLENGE_METADATA.test(metadata) || (dialog && /challenge/i.test(text) && /(?:verify|security|human|robot|aliexpress|alibaba)/i.test(text))) {
        return { detected: true, evidenceType: iframe ? 'VISIBLE_CHALLENGE_IFRAME' : dialog ? 'VISIBLE_CHALLENGE_DIALOG' : 'VISIBLE_CHALLENGE_CONTAINER', tag: String(element.tagName || '').toLowerCase() };
      }
    }
    return { detected: false, evidenceType: null, tag: null };
  }

  function safetyStopStatus() {
    if (visibleSecurityChallenge().detected) return C.STATUS.CAPTCHA;
    const text = normalize(document.body?.innerText || '').slice(0, 120_000); const status = C.textOutcome(text);
    return status === C.STATUS.RATE_LIMITED ? status : null;
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
      const initialSafety = safetyStopStatus(); if (initialSafety) return { ok: false, safetyStatus: initialSafety, message: initialSafety };
      const input = await ensurePromoInput(); if (!input) return { ok: false, message: 'Поле промокода не найдено' };
      const readySafety = safetyStopStatus(); if (readySafety) return { ok: false, safetyStatus: readySafety, message: readySafety };
      nativeSetInput(input, ''); await waitForDomSignal(120); nativeSetInput(input, code); return { ok: true };
    },
    clickApply: async () => {
      const input = findPlatformPromoInput();
      const button = await waitForCondition(() => findApplyButton(input), 2500);
      const safety = safetyStopStatus(); if (safety) return { ok: false, safetyStatus: safety, message: safety, responseEvidence: { applyClicked: false, applyButtonFound: !!button } };
      const confirmed = isConfirmedPromoApplyControl(button, input); const capture = startPromoResponseCapture(input, confirmed ? button : null);
      if (!confirmed) return { ok: false, message: 'AliExpress не показал безопасную кнопку применения; результат кода не подтверждён', responseEvidence: updatePromoResponseCapture(capture) };
      clickConfirmedPromoApply(button, input, capture);
      return { ok: true, responseEvidence: updatePromoResponseCapture(capture) };
    },
    observe: async (code) => {
      const input = findPlatformPromoInput();
      const appliedEvidence = appliedIndicator(code, input); const responseEvidence = updatePromoResponseCapture();
      if (responseEvidence) responseEvidence.appliedIndicatorFound = appliedEvidence.applied === true;
      return { checkout: readCheckout(), feedbackText: feedbackText(input), responseEvidence, appliedEvidence, safetyStatus: safetyStopStatus() };
    },
    finishResponseCapture: async () => finishPromoResponseCapture(),
    waitForSignal: (ms) => waitForDomSignal(ms),
    removeCode: async (code) => {
      const button = findRemoveButton(code); if (!button) return { ok: false, message: 'AliExpress не показал безопасную кнопку удаления применённого промокода' };
      Safety.safeClick(button, { purpose: 'Удаление проверенного промокода', intent: 'REMOVE_PROMO' }); return { ok: true };
    },
    clearCode: async () => { const input = findPlatformPromoInput(); if (input) nativeSetInput(input, ''); },
    waitForRejectedClear: (previousSnippet, timeoutMs) => waitForPromoResponseCleared(previousSnippet, timeoutMs),
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
    const verificationContext = { country: Country?.normalizeCountry(queueMeta?.countryCode), currency: session.currency || null, itemIds: (session.checkoutFingerprint?.items || []).map((item) => item.itemId).filter(Boolean), sellerIds: (session.checkoutFingerprint?.items || []).map((item) => item.sellerId).filter(Boolean) };
    await Store.upsert((session.results || []).map((row) => ({ ...row, lastStatus: row.verificationStatus, lastMessage: row.verificationMessage, lastDiscount: row.saving, lastVerificationContext: verificationContext })));
    return session;
  }

  async function applyBestExplicitly(code) {
    const normalized = Store.normalizeCode(code); const { promoTestSession: session } = await chrome.storage.local.get('promoTestSession');
    const settings = Country?.sanitizeSettings(await chrome.storage.local.get(['promoCountryMode', 'promoCountry', 'includeUnknownCountryCodes']));
    const target = Country?.resolveTarget(settings, Country.detectDocumentCountry(document));
    const sessionCountry = Country?.normalizeCountry(session?.promoIntelligence?.countryCode);
    if (sessionCountry && sessionCountry !== target?.code) return { status: 'CART_CHANGED', message: 'Страна промокодов отличается от страны проверенной сессии' };
    const response = await verifier.applyBest(normalized, session);
    if (response.status === 'APPLIED') { session.bestApplied = true; session.bestAppliedAt = new Date().toISOString(); session.bestApplicationResult = response.result; await saveSession(session); }
    return response;
  }

  function selectorDiagnostics() {
    const input = findPlatformPromoInput(); const apply = findApplyButton(input); const reveal = findPlatformPromoRevealControl(); const applyDiagnostics = applyControlDiagnostics(input);
    return {
      inputFound: !!input, input: P.safeSnippet(input), applyFound: !!apply,
      apply: apply ? { tag: String(apply.tagName || '').toLowerCase(), testId: controlTestId(apply) || null, ariaLabel: normalize(apply.getAttribute?.('aria-label') || '').slice(0, 120) || null } : null,
      applyScore: apply ? scoreApplyControl(apply, input) : null, ...applyDiagnostics,
      revealFound: !!reveal, reveal: P.safeSnippet(reveal), existingPlatformCode: existingPlatformCode()
    };
  }

  function safeUrl() { try { const url = new URL(location.href); return `${url.origin}${url.pathname}`; } catch (_) { return null; } }

  function checkoutContext() {
    const initialPageType = P.parsePageType(location.href);
    const checkout = initialPageType === 'CART'
      ? { breakdown: C.emptyBreakdown(), financial: C.buildFinancialSnapshot(C.emptyBreakdown()), fingerprint: C.buildCheckoutFingerprint({ items: [] }) }
      : readCheckout();
    const { binding, pageType, surface } = effectiveCheckoutBinding(checkout);
    const fingerprint = checkout.fingerprint || {};
    const financial = checkout.financial || {};
    const countrySignal = Country?.detectDocumentCountry(document) || { code: null, strong: false, source: 'NONE' };
    const promoTestingSurface = pageType === 'CHECKOUT' && surface.detected && (surface.platformPromoInputFound || surface.platformPromoRevealFound);
    const checkoutWidgetVisible = pageType === 'CHECKOUT' && surface.detected;
    const reliableIdentity = verifier.fingerprintIsReliable(fingerprint);
    const hasTotal = Number.isFinite(financial.total);
    const context = {
      available: promoTestingSurface && reliableIdentity && hasTotal,
      pageType,
      binding,
      checkoutSurfaceDetected: surface.detected,
      checkoutSurfaceCandidate: surface.candidate,
      checkoutWidgetVisible,
      promoTestingSurface,
      checkoutSurfaceSignals: surface.signals.slice(),
      checkoutFingerprint: fingerprint,
      currency: financial.currency || fingerprint.currency || null,
      subtotal: financial.subtotal,
      orderTotal: financial.total,
      total: financial.total,
      itemIds: (fingerprint.items || []).map((row) => row.itemId).filter(Boolean),
      sellerIds: (fingerprint.items || []).map((row) => row.sellerId).filter(Boolean),
      countryCode: countrySignal.code || null,
      countrySource: countrySignal.source || 'NONE',
      countrySignal,
      region: null,
      regionConfidence: 0,
      isNewUser: null,
      newUserStatusConfidence: 0,
      fingerprintQuality: fingerprint.quality || 'WEAK',
      reason: pageType === 'CART' ? 'Проверка platform promo code доступна на этапе оформления заказа' :
        !checkoutWidgetVisible ? 'Не удалось распознать страницу checkout' : !promoTestingSurface ? 'Поле platform promo code на checkout не найдено' :
          !reliableIdentity ? 'Не удалось надёжно определить состав заказа' : !hasTotal ? 'Не удалось определить итоговую сумму' : null
    };
    context.diagnostics = safeWidgetDiagnostics(context, checkout); return context;
  }

  async function diagnostics() {
    const { promoTestSession = null, couponCandidates = [] } = await chrome.storage.local.get(['promoTestSession', 'couponCandidates']); const checkout = readCheckout();
    const countrySignal = Country?.detectDocumentCountry(document) || { code: null, strong: false, source: 'NONE' };
    return { pageType: P.parsePageType(location.href), url: safeUrl(), locale: document.documentElement?.lang || navigator.language || null, countryCode: countrySignal.code || null, countrySource: countrySignal.source || 'NONE', checkoutState: checkout.financial, checkoutFingerprint: checkout.fingerprint, selectorMatches: selectorDiagnostics(), couponCandidates, verificationResults: promoTestSession?.results || [], parserVersion: P.parserVersion, timestamp: new Date().toISOString() };
  }

  async function executeCommand(message = {}) {
    if (message.type === 'CH_PROMO_TESTER_STATUS') {
      const context = checkoutContext();
      return { available: context.available, pageType: context.pageType, message: context.available ? 'Checkout готов к проверке промокодов' : context.reason };
    }
    if (message.type === 'CH_TEST_PROMOS') {
      if (running) return { status: 'BUSY', message: 'Проверка уже выполняется' };
      await refreshRecentProductContext().catch(() => {});
      const context = checkoutContext();
      if (!context.available) return { status: 'UNAVAILABLE', stopReason: context.reason, results: [] };
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
    normalizeCodes, normalizeCandidateQueue, inputScore, findPlatformPromoInput, findPlatformPromoRevealControl, ensurePromoInput, findPromoInputContainer, findPromoResponseContainer, isAliExpressIconApply, isConfirmedPromoApplyControl, clickConfirmedPromoApply, applyControlDiagnostics, scoreApplyControl, scoreRemoveControl, findApplyButton, findRemoveButton,
    safePromoResponseText, promoResponseScope, collectPromoResponseFragments, startPromoResponseCapture, updatePromoResponseCapture, finishPromoResponseCapture, waitForPromoResponseCleared,
    readBreakdown, readCheckout, summaryRows, checkoutItems, selectedShippingMethod, appliedIndicator, existingPlatformCode, visibleSecurityChallenge, safetyStopStatus, selectorDiagnostics, diagnostics,
    checkoutContext, checkoutSurfaceEvidence, effectiveCheckoutBinding, safeWidgetDiagnostics, visibleCheckoutLines,
    refreshRecentProductContext, setRecentProductContext, recentProductContextState, executeCommand,
    isForbiddenActionLabel: Safety.isForbiddenActionLabel
  };

  refreshRecentProductContext().catch(() => {});
  chrome.storage.onChanged?.addListener?.((changes, area) => {
    if (area === 'local' && changes.recentProductContext) setRecentProductContext(changes.recentProductContext.newValue || null);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const supported = new Set(['CH_PROMO_TESTER_STATUS', 'CH_TEST_PROMOS', 'CH_CANCEL_PROMO_TEST', 'CH_APPLY_BEST_PROMO', 'CH_GET_CHECKOUT_DIAGNOSTICS']);
    if (!supported.has(message?.type)) return false;
    executeCommand(message).then(sendResponse);
    return true;
  });
})();
