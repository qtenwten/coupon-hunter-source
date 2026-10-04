const { test } = require('./harness');
const { FakeElement, FakeDocument, sandbox, load, fixture } = require('./helpers');

const box = load(sandbox(), 'src/parser-core.js');
const P = box.CouponHunterParser;

test('RUB, USD, EUR and decimal prices', (t) => {
  for (const row of fixture('money-formats.json').exact) {
    const hit = P.extractPriceQuotes(row.text)[0];
    t.equal(hit?.value, row.value, row.text);
    t.equal(hit?.currency, row.currency, row.text);
  }
  const naked = P.extractPriceQuotes('1,299.50')[0];
  t.equal(naked.value, 1299.5); t.equal(naked.currency, null);
});

test('price ranges remain ranges rather than exact SKU prices', (t) => {
  for (const row of fixture('money-formats.json').ranges) {
    const hits = P.extractPriceQuotes(row.text);
    const range = hits.find((hit) => hit.isRange);
    t.equal(range?.min, row.min, row.text); t.equal(range?.max, row.max, row.text); t.equal(range?.currency, row.currency, row.text);
  }
});

test('item, page type and discount helpers', (t) => {
  t.equal(P.parseItemId('https://aliexpress.ru/item/1005009780072336.html?sku_id=1200001'), '1005009780072336');
  t.equal(P.parseItemId('https://example.com/item/nope'), null);
  t.equal(P.parsePageType('https://aliexpress.ru/p/trade/confirm.html'), 'CHECKOUT');
  t.equal(P.parsePageType('https://aliexpress.com/p/shoppingcart/index.html'), 'CART');
  t.equal(P.calculateDiscount(7500, 10000), 25);
  t.equal(P.calculateDiscount(10000, 7500), null);
});

test('modern AliExpress checkout routes are classified without broad order matching', (t) => {
  for (const url of [
    'https://aliexpress.ru/p/checkout/index.html',
    'https://aliexpress.ru/p/trade/order/confirm.html',
    'https://aliexpress.ru/p/order/confirm.html',
    'https://aliexpress.com/order/create.html'
  ]) t.equal(P.parsePageType(url), 'CHECKOUT', url);
  t.equal(P.parsePageType('https://aliexpress.ru/p/order/history.html'), 'ALIEXPRESS_OTHER');
  t.equal(P.parsePageType('https://aliexpress.ru/item/1005001234567890.html?order=popular'), 'PRODUCT');
});

test('normalized promotion types and conditions', (t) => {
  for (const row of fixture('promotions.json').cases) {
    const hit = P.extractPromotionsFromText(row.text)[0];
    t.equal(hit?.code, row.code, row.text); t.equal(hit?.type, row.type, row.text);
    if ('discountAmount' in row) t.equal(hit?.discountAmount, row.discountAmount, row.text);
    if ('discountPercent' in row) t.equal(hit?.discountPercent, row.discountPercent, row.text);
    if ('minimumSpend' in row) t.equal(hit?.minimumSpend, row.minimumSpend, row.text);
  }
  const normalized = P.normalizePromotion({ code: 'save20', title: 'Promo', source: 'TEST' });
  for (const key of ['id','code','type','title','source','sellerId','itemId','skuId','currency','discountAmount','discountPercent','minimumSpend','maximumDiscount','startAt','expiresAt','region','applicable','collected','verified','verificationStatus','verificationMessage','priceBefore','priceAfter','saving','lastVerifiedAt','confidence']) t.ok(key in normalized, key);
  t.equal(normalized.code, 'SAVE20'); t.equal(normalized.minimumSpend, null); t.equal(normalized.verified, false);
});

function productDocument(currentText = '8 990 ₽') {
  const title = new FakeElement({ tag: 'h1', text: 'Test Controller', rect: { top: 80, left: 500, bottom: 115 } });
  const price = new FakeElement({ text: currentText, attrs: { 'data-pl': 'product-price' }, className: 'product-price', rect: { top: 135, left: 520, bottom: 175 }, style: { fontSize: '28px', fontWeight: '700' } });
  const shipping = new FakeElement({ text: 'Доставка 499 ₽', className: 'shipping-price' });
  shipping.parentElement = new FakeElement({ text: 'Доставка 499 ₽', className: 'shipping' });
  const tax = new FakeElement({ text: 'Налог 250 ₽', className: 'tax-price' });
  tax.parentElement = new FakeElement({ text: 'Налог 250 ₽', className: 'tax' });
  const recommendation = new FakeElement({ text: '799 ₽', className: 'price' });
  recommendation.parentElement = new FakeElement({ text: 'Похожие товары 799 ₽', className: 'recommendations' });
  const old = new FakeElement({ tag: 'del', text: '10 990 ₽', style: { textDecorationLine: 'line-through' } });
  const selected = new FakeElement({ text: 'Color: Black', attrs: { 'data-sku-id': '1200000002', 'aria-selected': 'true' } });
  const seller = new FakeElement({ text: 'Test Official Store', className: 'store-name', attrs: { 'data-store-id': '77' } });
  const coupon = new FakeElement({ text: 'Промокод TEST500 — скидка 500 ₽ при заказе от 5 000 ₽', className: 'coupon' });
  const currency = new FakeElement({ tag: 'meta', attrs: { content: 'RUB' } });
  const doc = new FakeDocument({
    'h1': [title], 'meta[itemprop="priceCurrency"]': [currency],
    '[data-sku-id][aria-selected="true"]': [selected], 'div,span,p,label': [selected],
    '[data-pl="product-price"]': [price], '[class*="price" i]': [price, shipping, tax, recommendation],
    'del,s,[class*="old-price" i],[class*="original-price" i],[class*="price--original" i]': [old],
    '[class*="store-name" i]': [seller],
    '[class*="coupon" i],[class*="promo" i],[class*="discount" i],[data-pl*="coupon" i],[data-widget-cid*="promo" i]': [coupon],
    'button,[role="button"],[aria-label*="coupon" i],[aria-label*="promo" i],[aria-label*="купон" i]': [],
    '[role="dialog"],[role="menu"],[class*="popover" i],[class*="modal" i]': [], 'script': []
  }, { bodyText: coupon.textContent });
  return { doc, price, selected };
}

test('product parser rejects shipping, tax, old and recommendation prices', (t) => {
  const { doc } = productDocument();
  const product = P.parseProduct(doc, 'https://aliexpress.ru/item/1005000000000001.html?sku_id=1200000002');
  t.equal(product.detectedPrice.value, 8990); t.equal(product.detectedPrice.currency, 'RUB');
  t.equal(product.detectedPrice.skuAssociation, 'INFERRED'); t.equal(product.detectedPrice.skuMatched, false);
  t.equal(product.oldPrice, 10990); t.equal(product.skuId, '1200000002');
  t.equal(product.selectedVariant, 'Black'); t.equal(product.sellerId, '77');
  t.equal(product.promotions.find((row) => row.code === 'TEST500')?.type, 'PLATFORM_PROMO_CODE');
  t.ok(product.debug.priceCandidates.some((row) => row.context?.includes('Доставка')));
  t.ok(product.debug.priceCandidates.some((row) => row.context?.includes('Налог')));
  t.ok(product.debug.priceCandidates.some((row) => row.recommendation));
  t.equal(product.parserVersion, '3.3.1');
});

test('selected SKU price updates after a SKU change', (t) => {
  const built = productDocument('8 990 ₽');
  const first = P.parseProduct(built.doc, 'https://aliexpress.ru/item/1005000000000001.html?sku_id=1200000002');
  built.price.textContent = built.price.innerText = '9 490 ₽';
  built.selected.setAttribute('data-sku-id', '1200000003'); built.selected.textContent = built.selected.innerText = 'Color: Red';
  const second = P.parseProduct(built.doc, 'https://aliexpress.ru/item/1005000000000001.html?sku_id=1200000003');
  t.equal(first.detectedPrice.value, 8990); t.equal(second.detectedPrice.value, 9490);
  t.equal(second.skuId, '1200000003'); t.equal(second.selectedVariant, 'Red');
});

test('visible selected SKU wins briefly stale SPA URL and exposes the conflict', (t) => {
  const built = productDocument('9 490 ₽');
  built.selected.setAttribute('data-sku-id', '1200000003'); built.selected.textContent = built.selected.innerText = 'Color: Red';
  const result = P.parseProduct(built.doc, 'https://aliexpress.ru/item/1005000000000001.html?sku_id=1200000002');
  t.equal(result.skuId, '1200000003'); t.equal(result.debug.selectedSku.selectionConflict, true);
  t.equal(result.debug.selectedSku.urlSkuId, '1200000002'); t.equal(result.debug.selectedSku.domSkuId, '1200000003');
});

test('hydration data prefers the matching selected SKU', (t) => {
  const script = new FakeElement({ tag: 'script', text: JSON.stringify({ currency: 'USD', variants: [{ skuId: '111', price: 19.99 }, { skuId: '222', price: 24.99 }] }) });
  const doc = new FakeDocument({ 'script': [script], 'div,span,p,label': [] });
  const result = P.parseProduct(doc, 'https://aliexpress.com/item/1005000000000001.html?sku_id=222');
  t.equal(result.detectedPrice.value, 24.99); t.equal(result.detectedPrice.currency, 'USD');
  t.equal(result.detectedPrice.source, 'HYDRATION_JSON'); t.equal(result.detectedPrice.skuMatched, true);
  t.equal(result.detectedPrice.skuAssociation, 'EXPLICIT');
});

test('DOM price with its own matching SKU has explicit association', (t) => {
  const built = productDocument('8 990 ₽'); built.price.setAttribute('data-sku-id', '1200000002');
  const result = P.parseProduct(built.doc, 'https://aliexpress.ru/item/1005000000000001.html?sku_id=1200000002');
  t.equal(result.detectedPrice.skuAssociation, 'EXPLICIT'); t.equal(result.detectedPrice.skuMatched, true);
});

test('structured data never invents a missing currency', (t) => {
  const script = new FakeElement({ tag: 'script', text: JSON.stringify({ skuId: '222', price: 24.99 }) });
  const doc = new FakeDocument({ 'script': [script], 'div,span,p,label': [] });
  const result = P.parseProduct(doc, 'https://aliexpress.com/item/1005000000000001.html?sku_id=222');
  t.equal(result.detectedPrice.value, 24.99); t.equal(result.detectedPrice.currency, null);
});

test('serialized hydration JSON is parsed without depending on a global name or eval', (t) => {
  const script = new FakeElement({ tag: 'script', text: 'window.arbitraryHydrationName = {"currency":"EUR","variants":[{"skuId":"sku-x","price":39.95}]};' });
  const doc = new FakeDocument({ 'script': [script], 'div,span,p,label': [] });
  const result = P.parseProduct(doc, 'https://aliexpress.com/item/1005000000000001.html?sku_id=sku-x');
  t.equal(result.detectedPrice.value, 39.95); t.equal(result.detectedPrice.currency, 'EUR');
  t.equal(result.detectedPrice.source, 'HYDRATION_JSON');
});

test('a range is not treated as exact when a SKU is selected', (t) => {
  const range = new FakeElement({ text: '8 990–12 990 ₽', attrs: { 'data-pl': 'product-price' }, className: 'product-price', style: { fontSize: '28px' } });
  const doc = new FakeDocument({ '[data-pl="product-price"]': [range], '[class*="price" i]': [range], 'div,span,p,label': [], 'script': [] });
  const result = P.parseProduct(doc, 'https://aliexpress.ru/item/1005000000000001.html?sku_id=222');
  t.equal(result.detectedPrice.isRange, true); t.equal(result.detectedPrice.value, null);
  t.equal(result.detectedPrice.min, 8990); t.equal(result.detectedPrice.max, 12990);
});
