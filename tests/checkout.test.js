const { test } = require('./harness');
const { sandbox, load, fixture } = require('./helpers');

const box = load(sandbox(), 'src/checkout-core.js');
const C = box.CouponHunterCheckoutCore;

test('checkout breakdown and actual saving use total before/after', (t) => {
  const data = fixture('checkout-summary.json');
  const before = C.buildBreakdown(data.baseline); const after = C.buildBreakdown(data.after);
  t.equal(before.subtotal, 9890); t.equal(before.shipping, 300); t.equal(before.tax, 100);
  t.equal(before.discount, 400); t.equal(before.total, 9890); t.equal(after.total, 8650);
  t.equal(C.computeSaving(before, after), 1240); t.equal(C.computeSaving(before, { ...after, currency: 'USD' }), null);
});

for (const row of fixture('verification-messages.json').cases) {
  test(`multilingual verifier outcome: ${row.status || 'unknown'}`, (t) => {
    t.equal(C.textOutcome(row.text), row.status, row.text);
  });
}

test('valid code requires applied evidence and a real total decrease', (t) => {
  const before = { total: 9890, currency: 'RUB' }; const after = { total: 8650, currency: 'RUB' };
  let result = C.classifyVerification({ before, after, appliedIndicator: true, text: 'applied' });
  t.equal(result.status, C.STATUS.VALID_APPLIED); t.equal(result.verified, true); t.equal(result.saving, 1240);
  result = C.classifyVerification({ before, after: before, appliedIndicator: true, text: 'applied' });
  t.equal(result.status, C.STATUS.UNKNOWN_ERROR); t.equal(result.verified, false);
  result = C.classifyVerification({ before, after, appliedIndicator: false, text: '' });
  t.equal(result.status, C.STATUS.UNKNOWN_ERROR); t.equal(result.verified, false);
});

test('CAPTCHA and rate limit are safety stops', (t) => {
  for (const text of ['Security verification: CAPTCHA', 'Too many attempts, try again later']) {
    const result = C.classifyVerification({ text, before: { total: 100 }, after: { total: 100 } });
    t.equal(result.reason, 'SAFETY_STOP'); t.equal(result.verified, false);
  }
});

test('each applied code must be removed and baseline restored before the next', (t) => {
  const applied = { verificationStatus: C.STATUS.VALID_APPLIED, verified: true, saving: 100, baselineRestored: true };
  t.equal(C.requiresRemovalBeforeNext(applied), true);
  t.equal(C.requiresRemovalBeforeNext({ verificationStatus: C.STATUS.INVALID }), false);
  t.equal(C.requiresRemovalBeforeNext({ verificationStatus: C.STATUS.UNKNOWN_ERROR, appliedEvidence: { text: 'active' } }), true);
  t.equal(C.isBaselineRestored({ total: 1000, currency: 'RUB' }, { total: 1000.009, currency: 'RUB' }), true);
  t.equal(C.isBaselineRestored({ total: 1000, currency: 'RUB' }, { total: 999, currency: 'RUB' }), false);
  t.equal(C.financialBaselineMatches(
    { subtotal: 10000, shipping: 500, tax: 0, discount: 0, total: 10500, currency: 'RUB' },
    { subtotal: 10500, shipping: 0, tax: 0, discount: 500, total: 10500, currency: 'RUB' }
  ), false);
  t.equal(C.financialBaselineMatches(
    { subtotal: 10000, shipping: null, tax: 0, discount: 0, total: 10500, currency: 'RUB' },
    { subtotal: 10000, shipping: 500, tax: 0, discount: 0, total: 10500, currency: 'RUB' }
  ), true);
  t.equal(C.financialBaselineMatches(
    { subtotal: 10000, shipping: 500, tax: 0, discount: 0, total: 10500, currency: 'RUB' },
    { subtotal: 10000.005, shipping: 500.005, tax: 0, discount: 0, total: 10500.005, currency: 'RUB' }
  ), true);
  t.equal(C.isBestEligible(applied), true); t.equal(C.isBestEligible({ ...applied, baselineRestored: false }), false);
});

test('checkout fingerprint distinguishes different items with the same total', (t) => {
  const breakdown = { subtotal: 9990, shipping: 0, tax: 0, total: 9990, currency: 'RUB' };
  const first = C.buildCheckoutFingerprint({ breakdown, items: [{ itemId: 'A', skuId: 'A-1', quantity: 1 }], shippingMethodId: 'standard-id' });
  const second = C.buildCheckoutFingerprint({ breakdown, items: [{ itemId: 'B', skuId: 'B-1', quantity: 1 }], shippingMethodId: 'standard-id' });
  t.equal(C.sameCheckoutFingerprint(first, second), false); t.ok(first.signature !== second.signature);
});

test('checkout binding supports modern confirm routes but not arbitrary order pages', (t) => {
  t.equal(C.checkoutBinding('https://aliexpress.ru/p/checkout/index.html').pageClass, 'CHECKOUT');
  t.equal(C.checkoutBinding('https://aliexpress.ru/p/trade/order/confirm.html').pageClass, 'CHECKOUT');
  t.equal(C.checkoutBinding('https://aliexpress.ru/p/order/history.html').pageClass, 'OTHER');
});

test('checkout fingerprint is deterministic regardless of item DOM order', (t) => {
  const data = { currency: 'RUB', subtotal: 5000, shipping: 0, tax: 0, shippingMethodId: 'courier-id' };
  const a = C.buildCheckoutFingerprint({ ...data, items: [{ itemId: '2', skuId: 'B', quantity: 2 }, { itemId: '1', skuId: 'A', quantity: 1 }] });
  const b = C.buildCheckoutFingerprint({ ...data, items: [{ itemId: '1', skuId: 'A', quantity: 1 }, { itemId: '2', skuId: 'B', quantity: 2 }] });
  t.equal(a.signature, b.signature); t.equal(C.sameCheckoutFingerprint(a, b), true);
});

test('structural fingerprint excludes every financial amount', (t) => {
  const items = [{ itemId: 'A', skuId: 'SKU-A', quantity: 2, sellerId: 'SELLER-1' }];
  const first = C.buildCheckoutFingerprint({ breakdown: { currency: 'RUB', subtotal: 10000, shipping: 500, tax: 100, discount: 0, total: 10600 }, items, shippingMethodId: 'ship-1' });
  const second = C.buildCheckoutFingerprint({ breakdown: { currency: 'RUB', subtotal: 9200, shipping: 0, tax: 50, discount: 1350, total: 9250 }, items, shippingMethodId: 'ship-1' });
  t.equal(first.signature, second.signature); t.equal(C.sameCheckoutFingerprint(first, second), true);
  for (const key of ['subtotal', 'shipping', 'tax', 'discount', 'total']) t.equal(Object.hasOwn(first, key), false, key);
  t.deep(first.componentsUsed, ['currency', 'items.itemId', 'items.skuId', 'items.quantity', 'items.sellerId', 'shippingMethodId']);
});

test('financial snapshot is independent and deterministic', (t) => {
  const snapshot = C.buildFinancialSnapshot({ subtotal: 100, shipping: 10, tax: 5, discount: 20, total: 95, currency: 'USD', candidates: ['ignored'] });
  t.deep(snapshot, { subtotal: 100, shipping: 10, tax: 5, discount: 20, total: 95, currency: 'USD' });
  t.equal(C.financialSignature(snapshot), C.financialSignature({ ...snapshot, candidates: ['other'] }));
});

test('fingerprint quality reports strong medium and weak identity evidence', (t) => {
  const strong = C.buildCheckoutFingerprint({ currency: 'USD', items: [{ itemId: '1', skuId: 'S1', quantity: 1 }] });
  const medium = C.buildCheckoutFingerprint({ currency: 'USD', items: [{ itemId: '1', skuId: null, quantity: null, rootEvidence: true }] });
  const missingQuantity = C.buildCheckoutFingerprint({ currency: 'USD', items: [{ itemId: '1', skuId: 'S1', quantity: null }] });
  const weak = C.buildCheckoutFingerprint({ currency: 'USD', items: [] });
  t.equal(strong.quality, 'STRONG'); t.equal(medium.quality, 'MEDIUM'); t.equal(missingQuantity.quality, 'MEDIUM'); t.equal(weak.quality, 'WEAK');
  t.deep(weak.componentsUsed, ['currency']);
});

test('verified results sort by real saving before rejected and unknown', (t) => {
  const sorted = C.sortVerificationResults([
    { code: 'UNKNOWN', verificationStatus: C.STATUS.UNKNOWN_ERROR },
    { code: 'BAD', verificationStatus: C.STATUS.INVALID },
    { code: 'SMALL', verified: true, verificationStatus: C.STATUS.VALID_APPLIED, saving: 100 },
    { code: 'BEST', verified: true, verificationStatus: C.STATUS.VALID_APPLIED, saving: 500 }
  ]);
  t.deep(sorted.map((row) => row.code), ['BEST', 'SMALL', 'BAD', 'UNKNOWN']);
});
