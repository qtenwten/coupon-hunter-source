const { test } = require('./harness');
const { FakeElement, FakeMutationObserver, sandbox, load, fixture } = require('./helpers');

const chrome = { runtime: { onMessage: { addListener() {} } }, storage: { local: { async get() { return {}; }, async set() {} } } };
const doc = { documentElement: { lang: 'ru' }, body: { innerText: '' }, querySelectorAll() { return []; }, querySelector() { return null; } };
const box = load(
  sandbox({ chrome, document: doc, location: { href: 'https://aliexpress.ru/p/trade/confirm.html' }, MutationObserver: FakeMutationObserver, Element: FakeElement }),
  'src/parser-core.js', 'src/checkout-core.js', 'src/verifier-engine.js', 'src/safety.js', 'src/storage.js', 'src/country-profile.js', 'src/promo-tester.js'
);
const T = box.CouponHunterPromoTester;
const P = box.CouponHunterParser;
const C = box.CouponHunterCheckoutCore;

function checkoutFixtureDocument(data, { withIdentity = true, withLink = withIdentity, withStructured = withIdentity } = {}) {
  const heading = new FakeElement({ tag: 'h1', text: data.heading });
  const promo = new FakeElement({ tag: 'button', text: data.promoControl });
  const input = new FakeElement({ tag: 'input', attrs: { 'aria-label': 'Promo code' } });
  const order = new FakeElement({ tag: 'button', text: data.orderAction });
  const total = new FakeElement({ text: data.summary, attrs: { 'data-pl': 'order-total' } });
  const decoys = (data.decoys || []).map((text) => new FakeElement({ text }));
  const link = new FakeElement({ tag: 'a', attrs: { href: data.itemHref } });
  const script = new FakeElement({ tag: 'script', text: JSON.stringify(data.structuredState), attrs: { type: 'application/json' } });
  const querySelectorAll = (selector) => {
    if (selector === 'h1,h2,[role="heading"],[aria-level]') return [heading];
    if (selector === 'button,[role="button"],summary' || selector === 'button,[role="button"],input[type="submit"]') return [promo, order];
    if (selector === 'input') return [input];
    if (selector.startsWith('[data-pl*="total"')) return [total];
    if (selector === 'div,li,p') return decoys;
    if (selector.startsWith('a[href*="/item/"')) return withLink ? [link] : [];
    if (selector.startsWith('script[type="application/json"')) return withStructured ? [script] : [];
    return [];
  };
  return { heading, promo, input, order, total, decoys, link, script, querySelectorAll };
}

function correlationCheckoutDocument(data, { line = data.visibleLine, structuredState = data.structuredState, linePriceText = line?.price || null } = {}) {
  const heading = new FakeElement({ tag: 'h1', text: 'Оформление заказа' });
  const promo = new FakeElement({ tag: 'button', text: 'Ввести промокод' });
  const input = new FakeElement({ tag: 'input', attrs: { 'aria-label': 'Promo code' } });
  const order = new FakeElement({ tag: 'button', text: 'Оформить заказ' });
  const total = new FakeElement({ text: data.total, attrs: { 'data-pl': 'order-total' } });
  const script = new FakeElement({ tag: 'script', text: JSON.stringify(structuredState), attrs: { type: 'application/json' } });
  const root = new FakeElement({ text: line ? `${line.title || ''} ${line.variant || ''} Количество: ${line.quantity ?? ''} ${linePriceText || ''}` : '', attrs: { 'data-testid': 'checkout-line-item' }, className: 'checkout-item' });
  const title = line?.title ? new FakeElement({ text: line.title, attrs: { 'data-testid': 'item-title' } }) : null;
  const variant = line?.variant ? new FakeElement({ text: line.variant, attrs: { 'data-testid': 'item-variant' } }) : null;
  const quantity = Number.isFinite(line?.quantity) ? new FakeElement({ tag: 'input', attrs: { 'aria-label': 'Quantity' } }) : null;
  if (quantity) quantity.value = String(line.quantity);
  const price = linePriceText ? new FakeElement({ text: linePriceText, attrs: { 'data-testid': 'line-price' } }) : null;
  root.querySelector = (selector) => {
    if (/title/i.test(selector)) return title;
    if (/(?:variant|option|sku-info)/i.test(selector)) return variant;
    if (/quant|data-quantity/i.test(selector)) return quantity;
    if (/(?:line-price|item-price|product-price)/i.test(selector)) return price;
    return null;
  };
  const querySelectorAll = (selector) => {
    if (selector === 'h1,h2,[role="heading"],[aria-level]') return [heading];
    if (selector === 'button,[role="button"],summary' || selector === 'button,[role="button"],input[type="submit"]') return [promo, order];
    if (selector === 'input') return [input];
    if (selector.startsWith('[data-pl*="total"')) return [total];
    if (selector.includes('[data-testid*="line-item"')) return line ? [root] : [];
    if (selector.startsWith('script[type="application/json"')) return [script];
    return [];
  };
  return { root, title, variant, quantity, price, script, querySelectorAll };
}

function hashAnchorCheckoutDocument(data, { includePrice = true, huge = false, duplicate = false } = {}) {
  const heading = new FakeElement({ tag: 'h1', text: 'Оформление заказа' });
  const promo = new FakeElement({ tag: 'button', text: 'Ввести промокод' });
  const input = new FakeElement({ tag: 'input', attrs: { 'aria-label': 'Promo code' } });
  const order = new FakeElement({ tag: 'button', text: 'Оформить заказ' });
  const total = new FakeElement({ text: data.total, attrs: { 'data-pl': 'order-total' } });
  const script = new FakeElement({ tag: 'script', text: JSON.stringify(data.structuredState), attrs: { type: 'application/json' } });
  const compact = []; const roots = [];
  const makeRoot = () => {
    const title = new FakeElement({ tag: 'span', text: data.visibleLine.title });
    const variant = new FakeElement({ tag: 'span', text: data.visibleLine.variant });
    const price = includePrice ? new FakeElement({ tag: 'strong', text: data.visibleLine.price }) : null;
    const minus = new FakeElement({ tag: 'button', text: '−', attrs: { 'aria-label': 'Уменьшить' } });
    const quantity = new FakeElement({ tag: 'span', text: data.visibleLine.quantity });
    const plus = new FakeElement({ tag: 'button', text: '+', attrs: { 'aria-label': 'Увеличить' } });
    const quantityGroup = new FakeElement({ tag: 'div', text: `− ${data.visibleLine.quantity} +`, children: [minus, quantity, plus] });
    const image = new FakeElement({ tag: 'img', attrs: { alt: 'Product' } });
    const rootText = huge ? `${data.visibleLine.title} ${data.visibleLine.variant} ${data.visibleLine.price} ${'x'.repeat(1300)}` : `${data.visibleLine.title} ${data.visibleLine.variant} ${includePrice ? data.visibleLine.price : ''} − ${data.visibleLine.quantity} +`;
    const root = new FakeElement({ tag: 'section', text: rootText, children: [title, variant, ...(price ? [price] : []), quantityGroup, image], rect: { width: huge ? 1900 : 620, height: huge ? 900 : 220 } });
    root.querySelector = (selector) => /img|picture|role="img"/.test(selector) ? image : null;
    const page = new FakeElement({ tag: 'main', text: `Получатель hidden ${rootText}`, children: [root], rect: { width: 1600, height: 1200 } });
    compact.push(title, variant, ...(price ? [price] : []), minus, quantity, plus); roots.push({ root, page, title, variant, price, minus, quantity, plus });
  };
  makeRoot(); if (duplicate) makeRoot();
  const querySelectorAll = (selector) => {
    if (selector === 'h1,h2,[role="heading"],[aria-level]') return [heading];
    if (selector === 'button,[role="button"],summary' || selector === 'button,[role="button"],input[type="submit"]') return [promo, order];
    if (selector === 'input') return [input];
    if (selector.startsWith('[data-pl*="total"')) return [total];
    if (selector === 'div,span,p,a,strong,b,label') return compact;
    if (selector.startsWith('script[type="application/json"')) return [script];
    return [];
  };
  return { roots, compact, promo, order, script, querySelectorAll };
}

function recentContext(data, overrides = {}) {
  const recent = data.recentProduct;
  return {
    itemId: recent.itemId, skuId: recent.skuId,
    titleHash: P.identityTextHash(recent.title), variantHash: P.identityTextHash(recent.variant),
    price: recent.price, currency: recent.currency, timestamp: Date.now(), ...overrides
  };
}

function scopedControl(label, context = 'Promo code') {
  const input = new FakeElement({ tag: 'input', attrs: { 'aria-label': 'Promo code' } });
  const button = new FakeElement({ tag: 'button', text: label });
  const container = new FakeElement({ tag: 'section', text: `${context} ${label}` });
  input.parentElement = container; button.parentElement = container;
  container.querySelectorAll = () => [button];
  return { input, button, container };
}

function iconApplySurface(options = {}) {
  const data = fixture('aliexpress-checkout-icon-apply.json');
  const input = new FakeElement({ tag: 'input', attrs: { 'aria-label': options.unrelatedInput ? 'Search products' : data.input.ariaLabel } }); input.value = data.input.value;
  const inputSpan = new FakeElement({ tag: 'span', children: [input] }); const svg = new FakeElement({ tag: 'svg' });
  const makeButton = () => new FakeElement({ tag: 'button', text: options.label || '', attrs: { type: options.type || data.apply.type, ...(options.testId === null ? {} : { 'data-testid': options.testId || data.apply.testId }), ...(options.ariaDisabled ? { 'aria-disabled': 'true' } : {}) }, children: [svg], style: options.hidden ? { display: 'none' } : {} });
  const buttons = options.multiple ? [makeButton(), makeButton()] : [makeButton()]; if (options.disabled) buttons[0].disabled = true;
  const wrapperButtons = options.outside ? [] : buttons;
  const wrapper = new FakeElement({ tag: data.wrapper.tag, text: 'Promo code', className: data.wrapper.className, children: [new FakeElement({ tag: 'span' }), inputSpan, ...wrapperButtons] });
  const outer = new FakeElement({ tag: 'section', text: 'Promo code', children: options.outside ? [wrapper, ...buttons] : [wrapper] });
  const query = (elements) => (selector) => {
    if (selector === 'input') return [input];
    if (selector.includes('button') || selector.includes('[role="button"]')) return elements;
    return [];
  };
  inputSpan.querySelectorAll = query([]); wrapper.querySelectorAll = query(wrapperButtons); outer.querySelectorAll = query(buttons);
  doc.querySelectorAll = (selector) => {
    if (selector === 'input') return [input];
    if (selector === 'button,[role="button"],input[type="submit"]' || selector === 'button,[role="button"],summary') return buttons;
    return [];
  };
  return { data, input, button: buttons[0], buttons, wrapper, outer };
}

function resetPromoDocument() { doc.querySelectorAll = () => []; }

test('verifier accepts normalized known/user codes and enforces hard cap 50', (t) => {
  const many = Array.from({ length: 70 }, (_, index) => `CODE${String(index).padStart(2, '0')}`);
  const normalized = T.normalizeCodes([...many, 'code00', 'bad!']);
  t.equal(normalized.length, 50); t.equal(normalized[0], 'CODE00'); t.equal(new Set(normalized).size, 50);
});

test('prepared intelligence queue preserves deterministic ranking order', (t) => {
  const queue = T.normalizeCandidateQueue([{ code: 'BEST20', rankScore: 900 }, { code: 'NEXT10', rankScore: 800 }, { code: 'best20', rankScore: 700 }]);
  t.deep(queue.map((row) => row.code), ['BEST20', 'NEXT10']); t.equal(queue[0].rankScore, 900);
});

for (const label of ['Apply', 'Apply coupon', 'Apply code', 'Redeem', 'Use coupon', 'Применить', 'Применить промокод', 'Использовать купон']) {
  test(`Apply scoring accepts: ${label}`, (t) => {
    const { input, button } = scopedControl(label); t.ok(T.scoreApplyControl(button, input) >= 90, label);
  });
}

for (const label of ['Place order', 'Pay Now', 'Buy now', 'Оформить заказ', 'Оплатить', 'Купить', 'Apply for credit', 'Apply address', 'Checkout']) {
  test(`Apply scoring rejects: ${label}`, (t) => {
    const { input, button } = scopedControl(label); t.equal(T.scoreApplyControl(button, input), -Infinity, label);
  });
}

for (const label of ['Use coins', 'Use points', 'Use balance', 'Use rewards', 'Apply bonus', 'Apply gift card', 'Использовать монеты', 'Применить бонусы', 'Использовать баланс']) {
  test(`Apply scoring rejects non-promo value control: ${label}`, (t) => {
    const { input, button } = scopedControl(label); t.equal(T.scoreApplyControl(button, input), -Infinity, label);
  });
}

test('explicit Apply code scores substantially above generic Apply', (t) => {
  const generic = scopedControl('Apply'); const explicit = scopedControl('Apply code');
  t.ok(T.scoreApplyControl(explicit.button, explicit.input) >= T.scoreApplyControl(generic.button, generic.input) + 50);
});

test('live icon-only buttonApply in the confirmed promo wrapper is selected', (t) => {
  const surface = iconApplySurface(); const input = T.findPlatformPromoInput(); const selected = T.findApplyButton(input); const diagnostics = T.applyControlDiagnostics(input);
  t.equal(input, surface.input); t.equal(input.value, 'DELD02'); t.equal(T.findPromoInputContainer(input), surface.wrapper);
  t.equal(selected, surface.button); t.ok(T.scoreApplyControl(surface.button, input) >= 90); t.equal(T.isConfirmedPromoApplyControl(surface.button, input), true);
  t.equal(diagnostics.applyCandidateCount, 1); t.equal(diagnostics.selectedApplyFound, true); t.equal(diagnostics.selectedApplyTestId, 'buttonApply');
  t.deep(diagnostics.selectedApplyEvidenceTypes, surface.data.expectedEvidenceTypes); t.equal(diagnostics.selectedApplyForbiddenLabel, false);
  const exported = T.selectorDiagnostics(); t.equal(exported.apply.testId, 'buttonApply'); t.equal(Object.hasOwn(exported.apply, 'class'), false); t.equal(Object.hasOwn(exported.apply, 'path'), false);
  const capture = T.startPromoResponseCapture(input, selected); t.equal(capture.applyClicked, false); t.equal(T.clickConfirmedPromoApply(selected, input, capture), true);
  const responseEvidence = T.updatePromoResponseCapture(capture); t.equal(responseEvidence.applyButtonFound, true); t.equal(responseEvidence.applyClicked, true); t.equal(selected.clicked, 1); T.finishPromoResponseCapture();
  t.equal(T.existingPlatformCode(), null, 'a manually entered value is not an applied code'); resetPromoDocument();
});

test('buttonApply outside the promo input wrapper is rejected', (t) => {
  const surface = iconApplySurface({ outside: true });
  t.equal(T.findPromoInputContainer(surface.input), null); t.equal(T.findApplyButton(surface.input), null); t.equal(T.scoreApplyControl(surface.button, surface.input), -Infinity); resetPromoDocument();
});

test('buttonApply beside an unrelated input is rejected', (t) => {
  const surface = iconApplySurface({ unrelatedInput: true });
  t.equal(T.findPlatformPromoInput(), null); t.equal(T.findApplyButton(surface.input), null); t.equal(T.isAliExpressIconApply(surface.button, surface.input), false); resetPromoDocument();
});

for (const [name, options] of [
  ['submit', { type: 'submit' }], ['disabled', { disabled: true }], ['hidden', { hidden: true }], ['aria-disabled', { ariaDisabled: true }]
]) {
  test(`${name} buttonApply is rejected`, (t) => {
    const surface = iconApplySurface(options); t.equal(T.findApplyButton(surface.input), null); t.equal(T.isConfirmedPromoApplyControl(surface.button, surface.input), false); resetPromoDocument();
  });
}

for (const label of ['Оформить заказ', 'Place Order', 'Pay Now']) {
  test(`buttonApply with forbidden purchase label is rejected: ${label}`, (t) => {
    const surface = iconApplySurface({ label }); const capture = T.startPromoResponseCapture(surface.input, surface.button);
    t.equal(T.findApplyButton(surface.input), null); t.equal(T.scoreApplyControl(surface.button, surface.input), -Infinity);
    t.equal(T.clickConfirmedPromoApply(surface.button, surface.input, capture), false); t.equal(surface.button.clicked || 0, 0); T.finishPromoResponseCapture(); resetPromoDocument();
  });
}

test('generic SVG-only arrow without exact buttonApply semantics is rejected', (t) => {
  const surface = iconApplySurface({ testId: null }); t.equal(T.findApplyButton(surface.input), null); t.equal(T.isAliExpressIconApply(surface.button, surface.input), false); resetPromoDocument();
});

test('multiple buttonApply candidates in one promo wrapper fail closed', (t) => {
  const surface = iconApplySurface({ multiple: true }); const diagnostics = T.applyControlDiagnostics(surface.input);
  t.equal(T.findApplyButton(surface.input), null); t.equal(diagnostics.applyCandidateCount, 2); t.equal(diagnostics.selectedApplyFound, false); resetPromoDocument();
});

test('seller coupon Apply on cart is not an icon platform promo control', (t) => {
  const previousUrl = box.location.href; const sellerApply = new FakeElement({ tag: 'button', text: 'Apply seller coupon' }); box.location.href = 'https://aliexpress.ru/p/shoppingcart/index.html';
  doc.querySelectorAll = (selector) => selector === 'button,[role="button"],input[type="submit"]' || selector === 'button,[role="button"],summary' ? [sellerApply] : [];
  t.equal(T.findPlatformPromoInput(), null); t.equal(T.findApplyButton(null), null); t.equal(sellerApply.clicked || 0, 0); resetPromoDocument(); box.location.href = previousUrl;
});

for (const label of ['Remove', 'Remove code', 'Remove promo', 'Clear', 'Clear coupon', 'Удалить', 'Удалить промокод', 'Убрать', 'Очистить']) {
  test(`Remove scoring accepts promo-context control: ${label}`, (t) => {
    const { input, button } = scopedControl(label, 'Promo code CODE1 applied');
    t.ok(T.scoreRemoveControl(button, { code: 'CODE1', input }) >= 100, label);
  });
}

test('Remove scoring accepts unambiguous icon aria-label in promo context', (t) => {
  const { input, button, container } = scopedControl('', 'Coupon CODE1 applied');
  button.setAttribute('aria-label', 'Remove promo'); container.querySelectorAll = () => [button];
  t.ok(T.scoreRemoveControl(button, { code: 'CODE1', input }) >= 100);
});

test('Remove scoring rejects generic remove outside promo context', (t) => {
  const { input, button } = scopedControl('Remove', 'Shopping cart item');
  t.ok(T.scoreRemoveControl(button, { code: 'CODE1', input }) < 100);
});

test('generic promo applied text is evidence without echoing the code', (t) => {
  const input = new FakeElement({ tag: 'input', attrs: { 'aria-label': 'Promo code' } });
  const container = new FakeElement({ text: 'Promo code applied' }); input.parentElement = container;
  const evidence = T.appliedIndicator('CODE1', input);
  t.equal(evidence.applied, true); t.ok(evidence.confidence >= 65); t.equal(evidence.evidenceType, 'LOCAL_PROMO_SUCCESS_TEXT');
});

for (const message of ['Coupon applied', 'Discount applied', 'Промокод применён', 'Скидка применена']) {
  test(`promo-context detector accepts generic success: ${message}`, (t) => {
    const input = new FakeElement({ tag: 'input', attrs: { 'aria-label': 'Promo code' } });
    const container = new FakeElement({ text: message }); input.parentElement = container;
    const evidence = T.appliedIndicator('CODE1', input);
    t.equal(evidence.applied, true); t.ok(evidence.confidence >= 65);
  });
}

test('unrelated Applied text is not promo evidence', (t) => {
  const input = new FakeElement({ tag: 'input', attrs: { 'aria-label': 'Promo code' } });
  const container = new FakeElement({ text: 'Settings applied successfully' }); input.parentElement = container;
  const evidence = T.appliedIndicator('CODE1', input);
  t.equal(evidence.applied, false);
});

test('generic global coupon DOM is not credible applied evidence', (t) => {
  const input = new FakeElement({ tag: 'input', attrs: { 'aria-label': 'Promo code' } }); const local = new FakeElement({ text: 'Promo code' }); input.parentElement = local;
  const generic = new FakeElement({ text: 'Coupon applied', className: 'discount coupon-banner' }); doc.querySelectorAll = () => [generic];
  const evidence = T.appliedIndicator('AEB100', input); t.equal(evidence.applied, false); t.equal(evidence.confidence, 0); doc.querySelectorAll = () => [];
});

test('exact tested code with explicit active state remains strong applied evidence', (t) => {
  const input = new FakeElement({ tag: 'input', attrs: { 'aria-label': 'Promo code' } }); const local = new FakeElement({ text: 'Promo code' }); input.parentElement = local;
  const exact = new FakeElement({ text: 'AEB100 active', className: 'promo-slot' }); doc.querySelectorAll = () => [exact];
  const evidence = T.appliedIndicator('AEB100', input); t.equal(evidence.applied, true); t.equal(evidence.evidenceType, 'CODE_AND_STATE'); t.ok(evidence.confidence >= 95); doc.querySelectorAll = () => [];
});

function challengeStatus(element) {
  doc.querySelectorAll = () => [element]; const evidence = T.visibleSecurityChallenge(); const status = T.safetyStopStatus(); doc.querySelectorAll = () => []; return { evidence, status };
}

test('visible CAPTCHA overlay is a hard-stop signal without interaction', (t) => {
  const overlay = new FakeElement({ tag: 'div', text: 'CAPTCHA — verify you are human', className: 'geetest captcha-overlay' });
  const result = challengeStatus(overlay); t.equal(result.evidence.detected, true); t.equal(result.status, C.STATUS.CAPTCHA); t.equal(overlay.clicked || 0, 0);
});

test('visible captcha iframe is a hard-stop signal', (t) => {
  const frame = new FakeElement({ tag: 'iframe', attrs: { src: 'https://security.aliexpress.com/captcha/challenge', title: 'Security verification' } });
  const result = challengeStatus(frame); t.equal(result.evidence.detected, true); t.equal(result.evidence.evidenceType, 'VISIBLE_CHALLENGE_IFRAME'); t.equal(result.status, C.STATUS.CAPTCHA); t.equal(frame.clicked || 0, 0);
});

test('visible security verification dialog is a hard-stop signal', (t) => {
  const dialog = new FakeElement({ tag: 'div', text: 'Security verification — slide to verify', attrs: { role: 'dialog', 'aria-modal': 'true' } });
  const result = challengeStatus(dialog); t.equal(result.evidence.detected, true); t.equal(result.evidence.evidenceType, 'VISIBLE_CHALLENGE_DIALOG'); t.equal(result.status, C.STATUS.CAPTCHA);
});

test('visible challenge modal semantic is detected without clicking it', (t) => {
  const modal = new FakeElement({ tag: 'div', className: 'challenge-modal' });
  const result = challengeStatus(modal); t.equal(result.evidence.detected, true); t.equal(result.status, C.STATUS.CAPTCHA); t.equal(modal.clicked || 0, 0);
});

test('hidden captcha-like DOM is ignored', (t) => {
  const hidden = new FakeElement({ tag: 'div', text: 'CAPTCHA security verification', className: 'captcha', style: { display: 'none' } });
  const result = challengeStatus(hidden); t.equal(result.evidence.detected, false); t.equal(result.status, null); t.equal(hidden.clicked || 0, 0);
});

test('ordinary visible security wording is not CAPTCHA', (t) => {
  const ordinary = new FakeElement({ tag: 'div', text: 'Security settings and account protection', className: 'security-panel' });
  const result = challengeStatus(ordinary); t.equal(result.evidence.detected, false); t.equal(result.status, null); t.equal(ordinary.clicked || 0, 0);
});

function responseSurface({ attribute = null, sourceId = 'promo-response', role = null } = {}) {
  const attrs = { 'aria-label': 'Promo code' }; if (attribute) attrs[attribute] = sourceId;
  const input = new FakeElement({ tag: 'input', attrs }); const apply = new FakeElement({ tag: 'button', text: 'Apply' });
  const response = new FakeElement({ tag: 'div', text: '', attrs: role ? { role } : {}, className: 'promo-helper validation-message' });
  const container = new FakeElement({ tag: 'section', text: 'Promo code Apply', children: [input, apply, response] });
  container.querySelectorAll = (selector) => selector === 'input' ? [input] : selector.includes('button') || selector.includes('[role="button"]') ? [apply] : [response]; input.nextElementSibling = response;
  doc.getElementById = (id) => id === sourceId ? response : null;
  doc.querySelectorAll = (selector) => selector === 'input' ? [input] : selector === 'button,[role="button"],input[type="submit"]' || selector === 'button,[role="button"],summary' ? [apply] : selector === '[role="alert"],[aria-live]' && role ? [response] : [];
  return { input, apply, response, container };
}

function livePromoResponseSurface() {
  const data = fixture('aliexpress-checkout-promo-response-live.json');
  const input = new FakeElement({ tag: 'input', attrs: { 'aria-label': data.input.ariaLabel } }); input.value = data.input.value;
  const svg = new FakeElement({ tag: 'svg' });
  const apply = new FakeElement({ tag: 'button', attrs: { type: data.apply.type, 'data-testid': data.apply.testId }, children: [svg] });
  const label = new FakeElement({ tag: 'label', text: 'Promo code', children: [input, apply] });
  const inputWrap = new FakeElement({ tag: 'div', text: 'Promo code', className: 'inputWrap', children: [label] });
  const outer = new FakeElement({ tag: 'div', text: 'Promo code', className: data.outer.className, children: [inputWrap] });
  let response = null;
  const scopedQuery = (selector) => {
    if (selector === 'input') return [input];
    if (selector.includes('button') || selector.includes('[role="button"]')) return [apply];
    if (selector === '[role="alert"],[aria-live],[class*="helper" i],[class*="hint" i],[class*="error" i],[class*="tip" i],[class*="notice" i],[class*="validation" i],[data-testid*="error" i],[data-testid*="message" i]') return response ? [response] : [];
    return [];
  };
  label.querySelectorAll = scopedQuery; inputWrap.querySelectorAll = scopedQuery; outer.querySelectorAll = scopedQuery;
  doc.querySelectorAll = (selector) => selector === 'input' ? [input] : selector === 'button,[role="button"],input[type="submit"]' || selector === 'button,[role="button"],summary' ? [apply] : [];
  return {
    data, input, apply, label, inputWrap, outer,
    addResponse(text = data.response.text, attrs = {}) {
      response = new FakeElement({ tag: 'div', text, className: data.response.className, attrs }); response.parentElement = outer; outer.children.push(response); outer.textContent = outer.innerText = `Promo code ${text}`; return response;
    }
  };
}

function resetResponseSurface() {
  T.finishPromoResponseCapture(); delete doc.getElementById; doc.querySelectorAll = () => [];
}

test('promo-local observer captures newly changed helper text beside promo input', (t) => {
  const surface = responseSurface(); const capture = T.startPromoResponseCapture(surface.input, surface.apply); T.clickConfirmedPromoApply(surface.apply, surface.input, capture);
  surface.response.textContent = surface.response.innerText = 'Промокод недоступен для этого заказа';
  FakeMutationObserver.instances.at(-1).trigger([{ target: surface.response, addedNodes: [], type: 'characterData' }]);
  const evidence = T.updatePromoResponseCapture();
  t.equal(evidence.promoMutationSeen, true); t.equal(evidence.responseTextFound, true); t.equal(evidence.responseSnippet, 'Промокод недоступен для этого заказа');
  resetResponseSurface();
});

test('live CouponV2 sibling response is captured from the wider semantic container', (t) => {
  const surface = livePromoResponseSurface(); const responseContainer = T.findPromoResponseContainer(surface.input, surface.apply);
  t.equal(T.findPromoInputContainer(surface.input), surface.label); t.equal(responseContainer, surface.outer);
  const capture = T.startPromoResponseCapture(surface.input, surface.apply); t.equal(capture.responseContainerStrategy, surface.data.expected.containerStrategy);
  t.equal(T.clickConfirmedPromoApply(surface.apply, surface.input, capture), true);
  const response = surface.addResponse(); FakeMutationObserver.instances.at(-1).trigger([{ target: response, addedNodes: [response], type: 'childList' }]);
  const evidence = T.updatePromoResponseCapture();
  t.equal(evidence.responseContainerFound, true); t.equal(evidence.responseContainerStrategy, 'COUPON_SEMANTIC_ANCESTOR');
  t.equal(evidence.promoMutationSeen, true); t.equal(evidence.responseTextFound, true); t.equal(evidence.responseSnippet, surface.data.response.text);
  t.equal(C.textOutcome(evidence.responseSnippet), C.STATUS.EXPIRED); t.ok(Number.isFinite(evidence.classificationLatencyMs)); resetResponseSurface();
});

test('new short local response does not need the word promo', (t) => {
  const surface = livePromoResponseSurface(); const capture = T.startPromoResponseCapture(surface.input, surface.apply); T.clickConfirmedPromoApply(surface.apply, surface.input, capture);
  const response = surface.addResponse('Больше не действует', { role: 'alert' }); FakeMutationObserver.instances.at(-1).trigger([{ target: response, addedNodes: [response] }]);
  const evidence = T.updatePromoResponseCapture(); t.equal(evidence.responseSnippet, 'Больше не действует'); t.equal(C.textOutcome(evidence.responseSnippet), C.STATUS.EXPIRED); resetResponseSurface();
});

test('unchanged pre-existing promo helper is excluded by before/after diff', (t) => {
  const surface = livePromoResponseSurface(); const response = surface.addResponse('Введите промокод');
  const capture = T.startPromoResponseCapture(surface.input, surface.apply); T.clickConfirmedPromoApply(surface.apply, surface.input, capture);
  FakeMutationObserver.instances.at(-1).trigger([{ target: response, addedNodes: [] }]);
  const evidence = T.updatePromoResponseCapture(); t.equal(evidence.promoMutationSeen, true); t.equal(evidence.responseTextFound, false); t.equal(evidence.responseSnippet, null); resetResponseSurface();
});

test('only a post-Apply input validation change is reported as a signal', (t) => {
  const stale = responseSurface(); stale.input.setAttribute('aria-invalid', 'true');
  let capture = T.startPromoResponseCapture(stale.input, stale.apply); T.clickConfirmedPromoApply(stale.apply, stale.input, capture);
  let evidence = T.updatePromoResponseCapture(); t.equal(evidence.inputInvalid, true); t.equal(evidence.inputValidationChanged, false); resetResponseSurface();
  const changed = responseSurface(); capture = T.startPromoResponseCapture(changed.input, changed.apply); T.clickConfirmedPromoApply(changed.apply, changed.input, capture);
  changed.input.setAttribute('aria-invalid', 'true'); evidence = T.updatePromoResponseCapture(); t.equal(evidence.inputInvalid, true); t.equal(evidence.inputValidationChanged, true); resetResponseSurface();
});

test('response capture excludes checkout text outside confirmed CouponV2 scope', (t) => {
  const surface = livePromoResponseSurface(); const capture = T.startPromoResponseCapture(surface.input, surface.apply); T.clickConfirmedPromoApply(surface.apply, surface.input, capture);
  for (const text of ['Ошибка оплаты', 'Стоимость доставки обновлена', 'Получатель и адрес доставки', 'Order summary updated', 'Seller coupon is invalid', 'Promo code expired']) {
    const outside = new FakeElement({ tag: 'div', text, attrs: { role: 'alert' } }); FakeMutationObserver.instances.at(-1).trigger([{ target: outside, addedNodes: [outside] }]);
  }
  const evidence = T.updatePromoResponseCapture(); t.equal(evidence.promoMutationSeen, false); t.equal(evidence.responseTextFound, false); resetResponseSurface();
});

for (const [attribute, source] of [['aria-describedby', 'ARIA_DESCRIBEDBY'], ['aria-errormessage', 'ARIA_ERRORMESSAGE']]) {
  test(`${attribute} promo response is captured with bounded source`, (t) => {
    const surface = responseSurface({ attribute }); T.startPromoResponseCapture(surface.input, surface.apply);
    surface.response.textContent = surface.response.innerText = 'Не удалось применить этот промокод';
    const evidence = T.updatePromoResponseCapture();
    t.equal(evidence.responseTextFound, true); t.equal(evidence.responseSource, source); t.equal(evidence.responseSnippet.length <= 200, true);
    resetResponseSurface();
  });
}

test('promo-local role alert is captured', (t) => {
  const surface = responseSurface({ role: 'alert' }); T.startPromoResponseCapture(surface.input, surface.apply);
  surface.response.textContent = surface.response.innerText = 'Promo code is invalid';
  const evidence = T.updatePromoResponseCapture();
  t.equal(evidence.responseTextFound, true); t.equal(evidence.responseSource, 'PROMO_SIBLING'); t.equal(evidence.responseSnippet, 'Promo code is invalid');
  resetResponseSurface();
});

test('unrelated checkout and personal response text are excluded', (t) => {
  const surface = responseSurface(); const unrelated = new FakeElement({ tag: 'div', text: 'Стоимость доставки обновлена' });
  const payment = new FakeElement({ tag: 'div', text: 'Ошибка оплаты заказа' });
  const personal = new FakeElement({ tag: 'div', text: 'Получатель Иван, телефон +7 999 123-45-67, адрес доставки' });
  doc.querySelectorAll = (selector) => selector === '[role="alert"],[aria-live]' ? [unrelated, payment, personal] : [];
  T.startPromoResponseCapture(surface.input, surface.apply);
  t.equal(T.updatePromoResponseCapture().responseTextFound, false);
  t.equal(T.safePromoResponseText(personal.textContent), null); t.equal(T.safePromoResponseText(payment.textContent), null);
  resetResponseSurface();
});

test('checkout reader skips broad div fallback when a specific total source works', (t) => {
  const total = new FakeElement({ text: 'Итого к оплате 9 990 ₽', attrs: { 'data-pl': 'order-total' } });
  const queries = [];
  doc.querySelectorAll = (selector) => { queries.push(selector); return selector.startsWith('[data-pl*="total"') ? [total] : []; };
  const rows = T.summaryRows();
  t.ok(rows.some((row) => row.kind === 'total' && row.value === 9990)); t.equal(queries.includes('div,li,p'), false);
  doc.querySelectorAll = () => [];
});

test('live RU financial rows keep free shipping separate from 8 923 RUB total', (t) => {
  const data = fixture('aliexpress-ru-checkout-financial.json');
  const product = new FakeElement({ text: data.rows.product }); const shipping = new FakeElement({ text: data.rows.shipping });
  const shippingOption = new FakeElement({ text: data.rows.shippingOption }); const total = new FakeElement({ text: data.rows.total });
  const container = new FakeElement({ text: data.container, className: 'checkout-summary total-section', children: [product, shipping, shippingOption, total] });
  container.querySelectorAll = () => [product, shipping, shippingOption, total];
  doc.querySelectorAll = (selector) => {
    if (selector.startsWith('[data-pl*="total"')) return [container];
    if (selector.startsWith('[data-testid*="summary"')) return [container];
    if (selector === 'div,li,p') return [container, product, shipping, shippingOption, total];
    return [];
  };
  const rows = T.summaryRows(); const breakdown = T.readBreakdown();
  t.ok(rows.some((row) => row.kind === 'shipping' && row.value === 0));
  t.ok(rows.some((row) => row.kind === 'total' && row.value === data.expected.total));
  t.equal(breakdown.shipping, data.expected.shipping); t.equal(breakdown.total, data.expected.total); t.equal(breakdown.currency, data.expected.currency);
  t.equal(rows.some((row) => row.kind === 'shipping' && row.value === data.expected.total), false);
  t.equal(rows.some((row) => row.kind === 'total' && row.value === 468), false);
  container.isConnected = false; doc.querySelectorAll = () => [];
});

test('checkout item discovery does not query generic data-testid item UI nodes', (t) => {
  const selectors = []; doc.querySelectorAll = (selector) => { selectors.push(selector); return []; };
  t.deep(T.checkoutItems(), []);
  t.equal(selectors.some((selector) => selector.includes('[data-testid*="item" i]')), false);
  doc.querySelectorAll = () => [];
});

test('checkout item identity never uses seller display text as sellerId', (t) => {
  const seller = new FakeElement({ text: 'A store with a mutable display name' });
  const root = new FakeElement({ attrs: { 'data-item-id': '12345' } });
  root.querySelector = (selector) => selector.includes('seller-id') ? seller : null;
  doc.querySelectorAll = () => [root];
  const items = T.checkoutItems();
  t.equal(items.length, 1); t.equal(items[0].itemId, '12345'); t.equal(items[0].sellerId, null);
  doc.querySelectorAll = () => [];
});

test('checkout context is available with reliable cart identity while promo input is collapsed', (t) => {
  const total = new FakeElement({ text: 'Итого к оплате 9 990 ₽', attrs: { 'data-pl': 'order-total' } });
  const item = new FakeElement({ attrs: { 'data-item-id': '12345', 'data-quantity': '1' } });
  const reveal = new FakeElement({ tag: 'button', text: 'Ввести промокод' });
  doc.querySelectorAll = (selector) => {
    if (selector.startsWith('[data-pl*="total"')) return [total];
    if (selector.startsWith('[data-item-id]')) return [item];
    if (selector === 'button,[role="button"],summary' || selector === 'button,[role="button"],input[type="submit"]') return [reveal];
    return [];
  };
  const context = T.checkoutContext();
  t.equal(context.available, true); t.equal(context.pageType, 'CHECKOUT'); t.equal(context.fingerprintQuality, 'MEDIUM');
  t.deep(context.itemIds, ['12345']); t.equal(context.total, 9990);
  doc.querySelectorAll = () => [];
});

test('live-like RU checkout heading, promo control and total are recognized as checkout surface', (t) => {
  const data = fixture('aliexpress-ru-checkout.json'); const page = checkoutFixtureDocument(data, { withIdentity: false });
  const previousUrl = box.location.href; box.location.href = 'https://aliexpress.ru/p/trade/review-new.html'; doc.querySelectorAll = page.querySelectorAll;
  const context = T.checkoutContext();
  t.equal(context.pageType, 'ALIEXPRESS_OTHER'); t.equal(context.checkoutSurfaceDetected, true); t.equal(context.available, false);
  t.ok(context.checkoutSurfaceSignals.includes('CHECKOUT_HEADING')); t.ok(context.checkoutSurfaceSignals.includes('PROMO_CONTROL')); t.ok(context.checkoutSurfaceSignals.includes('ORDER_TOTAL'));
  t.equal(page.order.clicked || 0, 0, 'Оформить заказ is read-only evidence');
  doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

test('live-like RU checkout parses visible 8 923 RUB total and structured item identity', (t) => {
  const data = fixture('aliexpress-ru-checkout.json'); const page = checkoutFixtureDocument(data);
  const previousUrl = box.location.href; box.location.href = data.url; doc.querySelectorAll = page.querySelectorAll;
  const context = T.checkoutContext();
  t.equal(context.pageType, data.expected.pageType); t.equal(context.total, data.expected.total); t.equal(context.currency, data.expected.currency);
  t.equal(context.fingerprintQuality, 'STRONG'); t.deep(context.itemIds, [data.expected.itemId]); t.equal(context.checkoutFingerprint.items[0].skuId, data.expected.skuId);
  t.equal(context.available, true);
  t.equal(context.diagnostics.selectors.inputFound, true); t.equal(context.diagnostics.selectors.applyFound, false); t.equal(context.diagnostics.selectors.revealFound, true);
  t.equal(page.promo.clicked || 0, 0, 'promo reveal is not clicked before explicit start');
  doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

test('structured-only checkout line identity works without visible item IDs', (t) => {
  const data = fixture('aliexpress-ru-checkout.json'); const page = checkoutFixtureDocument(data, { withLink: false, withStructured: true });
  const previousUrl = box.location.href; box.location.href = 'https://aliexpress.ru/checkout'; doc.querySelectorAll = page.querySelectorAll;
  const context = T.checkoutContext(); const structured = context.diagnostics.structured;
  t.equal(context.checkoutFingerprint.items.length, 1); t.equal(context.fingerprintQuality, 'STRONG'); t.equal(context.available, true);
  t.equal(structured.structuredCandidateCount, 1); t.equal(structured.structuredCheckoutScopedCount, 1);
  t.equal(structured.structuredUniqueItemIds, 1); t.equal(structured.structuredUniqueSkuIds, 1); t.deep(structured.structuredConflicts, []);
  t.ok(structured.structuredEvidenceTypes.includes('CHECKOUT_SCOPED_JSON'));
  doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

test('checkout-scoped structured item is rejected without a strong checkout surface', (t) => {
  const source = fixture('aliexpress-ru-checkout.json');
  const script = new FakeElement({ tag: 'script', text: JSON.stringify(source.structuredState), attrs: { type: 'application/json' } });
  const previousUrl = box.location.href; box.location.href = 'https://aliexpress.ru/item/1005009999999999.html';
  doc.querySelectorAll = (selector) => selector.startsWith('script[type="application/json"') ? [script] : [];
  const context = T.checkoutContext();
  t.equal(context.checkoutFingerprint.items.length, 0); t.equal(context.fingerprintQuality, 'WEAK');
  t.equal(context.checkoutSurfaceDetected, false); t.equal(context.diagnostics.structured.structuredCandidateCount, 0);
  doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

test('one structured checkout line stays MEDIUM when SKU or quantity is unknown', (t) => {
  const source = fixture('aliexpress-ru-checkout.json');
  const data = { ...source, structuredState: { checkout: { lineItems: [{ itemId: source.expected.itemId, quantity: null }] } } };
  const page = checkoutFixtureDocument(data, { withLink: false, withStructured: true }); const previousUrl = box.location.href;
  box.location.href = 'https://aliexpress.ru/checkout'; doc.querySelectorAll = page.querySelectorAll;
  const context = T.checkoutContext();
  t.equal(context.checkoutFingerprint.items.length, 1); t.equal(context.checkoutFingerprint.items[0].skuId, null); t.equal(context.fingerprintQuality, 'MEDIUM');
  doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

test('arbitrary page JSON itemId is never accepted as checkout identity', (t) => {
  const source = fixture('aliexpress-ru-checkout.json');
  const data = { ...source, structuredState: { analytics: { product: { itemId: source.expected.itemId, skuId: source.expected.skuId, quantity: 1 } } } };
  const page = checkoutFixtureDocument(data, { withLink: false, withStructured: true }); const previousUrl = box.location.href;
  box.location.href = 'https://aliexpress.ru/checkout'; doc.querySelectorAll = page.querySelectorAll;
  const context = T.checkoutContext();
  t.equal(context.checkoutFingerprint.items.length, 0); t.equal(context.fingerprintQuality, 'WEAK');
  t.equal(context.diagnostics.structured.structuredCandidateCount, 1); t.equal(context.diagnostics.structured.structuredCheckoutScopedCount, 0);
  doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

test('recommendation structured itemId is excluded from checkout identity', (t) => {
  const source = fixture('aliexpress-ru-checkout.json');
  const data = { ...source, structuredState: { checkout: { recommendationItems: [{ itemId: source.expected.itemId, skuId: source.expected.skuId, quantity: 1 }] } } };
  const page = checkoutFixtureDocument(data, { withLink: false, withStructured: true }); const previousUrl = box.location.href;
  box.location.href = 'https://aliexpress.ru/checkout'; doc.querySelectorAll = page.querySelectorAll;
  const context = T.checkoutContext();
  t.equal(context.checkoutFingerprint.items.length, 0); t.equal(context.fingerprintQuality, 'WEAK');
  t.ok(context.diagnostics.structured.structuredEvidenceTypes.includes('EXCLUDED_NON_PURCHASE_COLLECTION'));
  doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

test('competing structured checkout itemIds downgrade to no guessed identity', (t) => {
  const source = fixture('aliexpress-ru-checkout.json');
  const data = { ...source, structuredState: { checkoutItems: [
    { itemId: source.expected.itemId, skuId: 'SKU-A', quantity: 1 },
    { itemId: '1005009999999999', skuId: 'SKU-B', quantity: 1 }
  ] } };
  const page = checkoutFixtureDocument(data, { withLink: false, withStructured: true }); const previousUrl = box.location.href;
  box.location.href = 'https://aliexpress.ru/checkout'; doc.querySelectorAll = page.querySelectorAll;
  const context = T.checkoutContext();
  t.equal(context.checkoutFingerprint.items.length, 0); t.equal(context.fingerprintQuality, 'WEAK');
  t.equal(context.diagnostics.structured.structuredUniqueItemIds, 2);
  t.ok(context.diagnostics.structured.structuredConflicts.includes('COMPETING_ITEM_IDS_WITHOUT_DOM_CORROBORATION'));
  doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

test('recent product plus four visible line signals resolves one competing checkout item', (t) => {
  const data = fixture('aliexpress-checkout-correlation-live.json'); const page = correlationCheckoutDocument(data);
  const previousUrl = box.location.href; box.location.href = data.url; T.setRecentProductContext(recentContext(data)); doc.querySelectorAll = page.querySelectorAll;
  const context = T.checkoutContext(); const diagnostics = context.diagnostics.structured;
  t.equal(context.checkoutFingerprint.items.length, data.expected.itemCount); t.equal(context.fingerprintQuality, data.expected.fingerprint); t.equal(context.available, true);
  t.equal(context.checkoutFingerprint.items[0].itemId, data.recentProduct.itemId); t.equal(context.checkoutFingerprint.items[0].skuId, data.recentProduct.skuId); t.equal(context.checkoutFingerprint.items[0].quantity, 1);
  t.equal(diagnostics.recentProductContextAvailable, true); t.equal(diagnostics.recentProductContextFresh, true);
  t.equal(diagnostics.recentProductExactItemMatchCount, 1); t.equal(diagnostics.recentProductExactSkuMatchCount, 1);
  t.equal(diagnostics.visibleLineCount, 1); t.equal(diagnostics.structuredMatchedLineCount, 1); t.equal(diagnostics.structuredUnmatchedCandidateCount, 1);
  for (const evidence of ['TITLE_MATCH', 'VARIANT_MATCH', 'QUANTITY_MATCH', 'LINE_PRICE_MATCH', 'RECENT_ITEM_MATCH', 'RECENT_SKU_MATCH', 'EXPLICIT_SKU']) t.ok(diagnostics.winningEvidenceTypes.includes(evidence), evidence);
  const serialized = JSON.stringify(diagnostics); t.ok(!serialized.includes(data.recentProduct.itemId)); t.ok(!serialized.includes(data.recentProduct.skuId)); t.ok(!serialized.includes(data.recentProduct.title));
  T.setRecentProductContext(null); doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

test('live checkout hash-anchor fallback finds a classless purchase line and resolves identity', (t) => {
  const data = fixture('aliexpress-checkout-hash-anchor-live.json'); const page = hashAnchorCheckoutDocument(data); const previousUrl = box.location.href;
  box.location.href = data.url; T.setRecentProductContext(recentContext(data)); doc.querySelectorAll = page.querySelectorAll;
  const context = T.checkoutContext(); const structured = context.diagnostics.structured;
  t.equal(structured.visibleLineCount, data.expected.visibleLineCount); t.equal(structured.visibleLineDetectionStrategy, 'RECENT_HASH_ANCHOR');
  for (const signal of ['TITLE_HASH', 'VARIANT_HASH', 'LINE_PRICE', 'QUANTITY_CONTROL']) t.ok(structured.visibleLineAnchorSignals.includes(signal), signal);
  t.equal(structured.visibleLinesWithTitle, 1); t.equal(structured.visibleLinesWithVariant, 1); t.equal(structured.visibleLinesWithPrice, 1); t.equal(structured.visibleLinesWithQuantity, 1);
  t.equal(context.checkoutFingerprint.items.length, 1); t.equal(context.fingerprintQuality, data.expected.fingerprint); t.equal(context.available, true); t.equal(context.promoTestingSurface, true);
  t.equal(structured.recentProductExactItemMatchCount, 1); t.equal(structured.recentProductExactSkuMatchCount, 2); t.equal(structured.structuredMatchedLineCount, 1);
  T.setRecentProductContext(null); doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

test('hash anchors without an actual visible matching line price remain WEAK', (t) => {
  const data = fixture('aliexpress-checkout-hash-anchor-live.json'); const page = hashAnchorCheckoutDocument(data, { includePrice: false }); const previousUrl = box.location.href;
  box.location.href = data.url; T.setRecentProductContext(recentContext(data)); doc.querySelectorAll = page.querySelectorAll;
  const context = T.checkoutContext();
  t.equal(context.diagnostics.structured.visibleLineCount, 0); t.equal(context.checkoutFingerprint.items.length, 0); t.equal(context.fingerprintQuality, 'WEAK');
  t.equal(context.diagnostics.structured.visibleLineDetectionStrategy, 'NONE');
  T.setRecentProductContext(null); doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

test('huge page-level hash-anchor container is rejected', (t) => {
  const data = fixture('aliexpress-checkout-hash-anchor-live.json'); const page = hashAnchorCheckoutDocument(data, { huge: true }); const previousUrl = box.location.href;
  box.location.href = data.url; T.setRecentProductContext(recentContext(data)); doc.querySelectorAll = page.querySelectorAll;
  const context = T.checkoutContext();
  t.equal(context.diagnostics.structured.visibleLineCount, 0); t.equal(context.fingerprintQuality, 'WEAK'); t.equal(context.available, false);
  T.setRecentProductContext(null); doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

test('two possible hash-anchor purchase roots remain ambiguous and WEAK', (t) => {
  const data = fixture('aliexpress-checkout-hash-anchor-live.json'); const page = hashAnchorCheckoutDocument(data, { duplicate: true }); const previousUrl = box.location.href;
  box.location.href = data.url; T.setRecentProductContext(recentContext(data)); doc.querySelectorAll = page.querySelectorAll;
  const context = T.checkoutContext();
  t.equal(context.diagnostics.structured.visibleLineCount, 0); t.equal(context.checkoutFingerprint.items.length, 0); t.equal(context.fingerprintQuality, 'WEAK');
  T.setRecentProductContext(null); doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

test('stale recent product context cannot resolve competing checkout items', (t) => {
  const data = fixture('aliexpress-checkout-correlation-live.json'); const page = correlationCheckoutDocument(data); const previousUrl = box.location.href;
  box.location.href = data.url; T.setRecentProductContext(recentContext(data, { timestamp: Date.now() - 31 * 60 * 1000 })); doc.querySelectorAll = page.querySelectorAll;
  const context = T.checkoutContext();
  t.equal(context.checkoutFingerprint.items.length, 0); t.equal(context.fingerprintQuality, 'WEAK');
  t.equal(context.diagnostics.structured.recentProductContextAvailable, true); t.equal(context.diagnostics.structured.recentProductContextFresh, false);
  T.setRecentProductContext(null); doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

test('recent product with different variant or price is ignored for correlation', (t) => {
  const data = fixture('aliexpress-checkout-correlation-live.json'); const page = correlationCheckoutDocument(data); const previousUrl = box.location.href;
  box.location.href = data.url; T.setRecentProductContext(recentContext(data, { variantHash: P.identityTextHash('Different option'), price: 9999 })); doc.querySelectorAll = page.querySelectorAll;
  const context = T.checkoutContext();
  t.equal(context.checkoutFingerprint.items.length, 0); t.equal(context.fingerprintQuality, 'WEAK'); t.equal(context.diagnostics.structured.structuredMatchedLineCount, 0);
  T.setRecentProductContext(null); doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

test('recent item and SKU match without visible line corroboration is insufficient', (t) => {
  const data = fixture('aliexpress-checkout-correlation-live.json'); const page = correlationCheckoutDocument(data, { line: null }); const previousUrl = box.location.href;
  box.location.href = data.url; T.setRecentProductContext(recentContext(data)); doc.querySelectorAll = page.querySelectorAll;
  const context = T.checkoutContext();
  t.equal(context.checkoutFingerprint.items.length, 0); t.equal(context.fingerprintQuality, 'WEAK'); t.equal(context.diagnostics.structured.visibleLineCount, 0);
  T.setRecentProductContext(null); doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

for (const [name, line] of [
  ['title-only', { title: 'Wireless cleaning device' }],
  ['price-only', { price: '8 923 ₽' }]
]) {
  test(`${name} checkout corroboration is insufficient`, (t) => {
    const data = fixture('aliexpress-checkout-correlation-live.json'); const page = correlationCheckoutDocument(data, { line }); const previousUrl = box.location.href;
    box.location.href = data.url; T.setRecentProductContext(recentContext(data)); doc.querySelectorAll = page.querySelectorAll;
    const context = T.checkoutContext();
    t.equal(context.checkoutFingerprint.items.length, 0); t.equal(context.fingerprintQuality, 'WEAK'); t.equal(context.diagnostics.structured.structuredMatchedLineCount, 0);
    T.setRecentProductContext(null); doc.querySelectorAll = () => []; box.location.href = previousUrl;
  });
}

test('two equally corroborated structured candidates remain WEAK', (t) => {
  const data = fixture('aliexpress-checkout-correlation-live.json'); const metadata = { title: data.visibleLine.title, variant: data.visibleLine.variant, quantity: 1, price: 8923, currency: 'RUB' };
  const structuredState = { checkoutItems: [
    { itemId: '1005009780072336', skuId: 'SKU-A', ...metadata },
    { itemId: '1005001111111111', skuId: 'SKU-B', ...metadata }
  ] };
  const page = correlationCheckoutDocument(data, { structuredState }); const previousUrl = box.location.href;
  box.location.href = data.url; T.setRecentProductContext(null); doc.querySelectorAll = page.querySelectorAll;
  const context = T.checkoutContext();
  t.equal(context.checkoutFingerprint.items.length, 0); t.equal(context.fingerprintQuality, 'WEAK');
  t.ok(context.diagnostics.structured.structuredConflicts.includes('COMPETING_ITEM_IDS_WITHOUT_DOM_CORROBORATION'));
  doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

test('order total and delivery option are never used as checkout line price', (t) => {
  const data = fixture('aliexpress-checkout-correlation-live.json'); const previousUrl = box.location.href; box.location.href = data.url;
  for (const value of ['Итого 8 923 ₽', 'Доставка 468 ₽']) {
    const page = correlationCheckoutDocument(data, { line: { title: data.visibleLine.title }, linePriceText: value }); doc.querySelectorAll = page.querySelectorAll;
    const lines = T.visibleCheckoutLines({ strong: true }); t.equal(lines.length, 1, value); t.equal(lines[0].price, null, value); t.equal(lines[0].currency, null, value);
  }
  doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

test('conflicting structured variants never invent a selected checkout SKU', (t) => {
  const source = fixture('aliexpress-ru-checkout.json');
  const data = { ...source, structuredState: { checkoutItems: [
    { itemId: source.expected.itemId, skuId: 'SKU-A', quantity: 1 },
    { itemId: source.expected.itemId, skuId: 'SKU-B', quantity: 1 }
  ] } };
  const page = checkoutFixtureDocument(data); const previousUrl = box.location.href;
  box.location.href = 'https://aliexpress.ru/p/checkout/index.html'; doc.querySelectorAll = page.querySelectorAll;
  const context = T.checkoutContext();
  t.equal(context.checkoutFingerprint.items[0].skuId, null); t.equal(context.fingerprintQuality, 'MEDIUM');
  doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

test('copied widget diagnostics exclude query secrets and personal checkout data', (t) => {
  const data = fixture('aliexpress-ru-checkout.json'); const page = checkoutFixtureDocument(data);
  const previousUrl = box.location.href; const previousBody = doc.body; box.location.href = data.url;
  doc.body = { innerText: 'Иван Иванов +7 999 123-45-67 private@example.com ул. Секретная 1', textContent: 'Иван Иванов +7 999 123-45-67 private@example.com ул. Секретная 1' };
  doc.querySelectorAll = page.querySelectorAll;
  const serialized = JSON.stringify(T.checkoutContext().diagnostics);
  t.ok(!serialized.includes('checkoutToken')); t.ok(!serialized.includes('redacted')); t.ok(!serialized.includes('Иван Иванов'));
  t.ok(!serialized.includes('private@example.com')); t.ok(!serialized.includes('+7 999')); t.match(serialized, /"pathname":"\/p\/order\/confirm\.html"/);
  t.ok(!serialized.includes(data.expected.itemId)); t.ok(!serialized.includes(data.expected.skuId));
  doc.querySelectorAll = () => []; doc.body = previousBody; box.location.href = previousUrl;
});

test('non-checkout page with only a promo control is not a checkout surface', (t) => {
  const promo = new FakeElement({ tag: 'button', text: 'Ввести промокод' }); const previousUrl = box.location.href;
  box.location.href = 'https://aliexpress.ru/item/1005001234567890.html';
  doc.querySelectorAll = (selector) => selector === 'button,[role="button"],summary' || selector === 'button,[role="button"],input[type="submit"]' ? [promo] : [];
  const context = T.checkoutContext();
  t.equal(context.pageType, 'PRODUCT'); t.equal(context.checkoutSurfaceDetected, false); t.equal(context.available, false);
  doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

test('cart seller coupon is not a platform promo surface and is never clicked', async (t) => {
  const sellerCoupon = new FakeElement({ tag: 'button', text: 'Применить купон! -86 ₽' }); const previousUrl = box.location.href;
  box.location.href = 'https://aliexpress.ru/p/shoppingcart/index.html';
  doc.querySelectorAll = (selector) => selector === 'button,[role="button"],summary' || selector === 'button,[role="button"],input[type="submit"]' ? [sellerCoupon] : [];
  const context = T.checkoutContext();
  t.equal(context.pageType, 'CART'); t.equal(context.promoTestingSurface, false); t.equal(context.checkoutWidgetVisible, false); t.equal(context.available, false);
  t.equal(context.diagnostics.promoTestingSurface, false); t.equal(context.diagnostics.platformPromoInputFound, false); t.equal(context.diagnostics.platformPromoRevealFound, false);
  t.equal(context.checkoutFingerprint.items.length, 0); t.equal(T.findPlatformPromoRevealControl(), null);
  t.equal(await T.ensurePromoInput(), null); t.equal(sellerCoupon.clicked || 0, 0);
  const response = await T.executeCommand({ type: 'CH_TEST_PROMOS', candidates: ['CODE1'] });
  t.equal(response.status, 'UNAVAILABLE'); t.equal(sellerCoupon.clicked || 0, 0);
  doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

test('strict checkout promo reveal recognizes enter promo code semantics', (t) => {
  const reveal = new FakeElement({ tag: 'button', text: 'Ввести промокод' }); const previousUrl = box.location.href;
  box.location.href = 'https://aliexpress.ru/checkout';
  doc.querySelectorAll = (selector) => selector === 'button,[role="button"],summary' || selector === 'button,[role="button"],input[type="submit"]' ? [reveal] : [];
  t.equal(T.findPlatformPromoRevealControl(), reveal); t.equal(reveal.clicked || 0, 0);
  const context = T.checkoutContext(); t.equal(context.promoTestingSurface, true); t.equal(context.diagnostics.platformPromoRevealFound, true);
  doc.querySelectorAll = () => []; box.location.href = previousUrl;
});

test('existing platform code ignores generic promo state words', (t) => {
  const element = new FakeElement({ text: 'PROMO CODE APPLIED REMOVE' });
  element.querySelector = () => new FakeElement({ tag: 'button', text: 'Remove' });
  doc.querySelectorAll = () => [element];
  t.equal(T.existingPlatformCode(), 'ACTIVE_PROMO');
  doc.querySelectorAll = () => [];
});

test('existing platform code still extracts a real code near applied state', (t) => {
  const element = new FakeElement({ text: 'Promo code SAVE20 applied Remove' });
  doc.querySelectorAll = () => [element];
  t.equal(T.existingPlatformCode(), 'SAVE20');
  doc.querySelectorAll = () => [];
});

test('order, payment and purchase actions are forbidden centrally', (t) => {
  for (const label of ['Place order','Submit order','Confirm order','Checkout','Buy now','Pay','Pay now','Continue to payment','Оформить заказ','Разместить заказ','Подтвердить заказ','Оплатить','Перейти к оплате','Купить','Заказать']) t.equal(T.isForbiddenActionLabel(label), true, label);
  t.equal(T.isForbiddenActionLabel('Применить промокод'), false); t.equal(T.isForbiddenActionLabel('Удалить промокод'), false);
});
