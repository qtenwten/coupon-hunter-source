const { test } = require('./harness');
const { FakeElement, sandbox, load } = require('./helpers');

const box = load(sandbox(), 'src/page-adapter.js');
const A = box.CouponHunterPageAdapter;

test('MutationObserver ignores the extension panel and irrelevant attributes', (t) => {
  const panel = new FakeElement({ id: 'coupon-hunter-panel' }); const child = new FakeElement({ text: '8 990 ₽' }); child.parentElement = panel;
  t.equal(A.mutationIsMeaningful({ type: 'characterData', target: { data: '8 990 ₽', parentElement: child } }), false);
  const node = new FakeElement({ className: 'unrelated' });
  t.equal(A.mutationIsMeaningful({ type: 'attributes', attributeName: 'style', target: node }), false);
  node.className = 'sku selected';
  t.equal(A.mutationIsMeaningful({ type: 'attributes', attributeName: 'class', target: node }), true);
  t.equal(A.mutationIsMeaningful({ type: 'characterData', target: { data: 'Цена 9 490 ₽', parentElement: node } }), true);
});

test('SPA scheduler debounces bursts and can stop', async (t) => {
  let calls = 0; const scheduler = A.createScheduler(() => { calls += 1; }, { debounceMs: 10, minIntervalMs: 0 });
  scheduler('sku'); scheduler('price'); scheduler('rerender');
  await new Promise((resolve) => setTimeout(resolve, 35)); t.equal(calls, 1);
  scheduler('next'); await new Promise((resolve) => setTimeout(resolve, 35)); t.equal(calls, 2);
  scheduler.stop(); scheduler('ignored'); await new Promise((resolve) => setTimeout(resolve, 20)); t.equal(calls, 2);
});

test('product signature changes for SKU or price but not timestamps', (t) => {
  const base = { itemId: '1', skuId: 'A', selectedVariant: 'Black', detectedPrice: { value: 100, min: 100, max: 100 }, promotions: [] };
  t.equal(A.productSignature(base), A.productSignature({ ...base, parsedAt: new Date().toISOString() }));
  t.ok(A.productSignature(base) !== A.productSignature({ ...base, skuId: 'B' }));
  t.ok(A.productSignature(base) !== A.productSignature({ ...base, detectedPrice: { value: 120, min: 120, max: 120 } }));
});
