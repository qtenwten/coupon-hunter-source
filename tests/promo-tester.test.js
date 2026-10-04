const { test } = require('./harness');
const { FakeElement, FakeMutationObserver, sandbox, load } = require('./helpers');

const chrome = { runtime: { onMessage: { addListener() {} } }, storage: { local: { async get() { return {}; }, async set() {} } } };
const doc = { documentElement: { lang: 'ru' }, body: { innerText: '' }, querySelectorAll() { return []; }, querySelector() { return null; } };
const box = load(
  sandbox({ chrome, document: doc, location: { href: 'https://aliexpress.ru/p/trade/confirm.html' }, MutationObserver: FakeMutationObserver, Element: FakeElement }),
  'src/parser-core.js', 'src/checkout-core.js', 'src/verifier-engine.js', 'src/safety.js', 'src/storage.js', 'src/promo-tester.js'
);
const T = box.CouponHunterPromoTester;

function scopedControl(label, context = 'Promo code') {
  const input = new FakeElement({ tag: 'input', attrs: { 'aria-label': 'Promo code' } });
  const button = new FakeElement({ tag: 'button', text: label });
  const container = new FakeElement({ tag: 'section', text: `${context} ${label}` });
  input.parentElement = container; button.parentElement = container;
  container.querySelectorAll = () => [button];
  return { input, button, container };
}

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
  t.equal(evidence.applied, true); t.ok(evidence.confidence >= 65); t.equal(evidence.evidenceType, 'PROMO_SUCCESS_TEXT');
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

test('checkout reader skips broad div fallback when a specific total source works', (t) => {
  const total = new FakeElement({ text: 'Итого к оплате 9 990 ₽', attrs: { 'data-pl': 'order-total' } });
  const queries = [];
  doc.querySelectorAll = (selector) => { queries.push(selector); return selector.startsWith('[data-pl*="total"') ? [total] : []; };
  const rows = T.summaryRows();
  t.ok(rows.some((row) => row.kind === 'total' && row.value === 9990)); t.equal(queries.includes('div,li,p'), false);
  doc.querySelectorAll = () => [];
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
  doc.querySelectorAll = (selector) => {
    if (selector.startsWith('[data-pl*="total"')) return [total];
    if (selector.startsWith('[data-item-id]')) return [item];
    return [];
  };
  const context = T.checkoutContext();
  t.equal(context.available, true); t.equal(context.pageType, 'CHECKOUT'); t.equal(context.fingerprintQuality, 'MEDIUM');
  t.deep(context.itemIds, ['12345']); t.equal(context.total, 9990);
  doc.querySelectorAll = () => [];
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
