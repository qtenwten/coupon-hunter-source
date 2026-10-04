(() => {
  'use strict';
  if (window.__COUPON_HUNTER_PRODUCT_V2__) return;
  window.__COUPON_HUNTER_PRODUCT_V2__ = true;

  const P = globalThis.CouponHunterParser;
  const Store = globalThis.CouponHunterStorage;
  const Adapter = globalThis.CouponHunterPageAdapter;
  const Safety = globalThis.CouponHunterSafety;
  const state = { product: null, signature: null, lastUrl: location.href, panel: null };

  const currencySymbol = (currency) => ({ RUB: '₽', USD: '$', EUR: '€' }[currency] || currency || '');
  const money = (value, currency = state.product?.currency) => Number.isFinite(value)
    ? `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value)} ${currencySymbol(currency)}`.trim() : '—';

  async function saveSnapshot(product) {
    if (!product?.itemId || !Number.isFinite(product.detectedPrice?.value)) return;
    const storageKey = `history:${product.key}`;
    const result = await chrome.storage.local.get([storageKey, 'watchlist']);
    const history = Array.isArray(result[storageKey]) ? result[storageKey] : [];
    const snapshot = { parsedAt: product.parsedAt, price: product.detectedPrice.value, detectedPrice: product.detectedPrice, oldPrice: product.oldPrice, currency: product.currency, title: product.title, seller: product.seller, selectedVariant: product.selectedVariant, itemId: product.itemId, skuId: product.skuId, url: product.url, parserVersion: product.parserVersion, confidence: product.confidence, promotions: product.promotions };
    const retainedHistory = Store.retainHistory(history, snapshot);
    const watchlist = Array.isArray(result.watchlist) ? result.watchlist : [];
    const updatedWatchlist = Store.updateWatchlistForProduct(watchlist, product);
    await chrome.storage.local.set({ [storageKey]: retainedHistory, latestProduct: product, watchlist: updatedWatchlist });
    await Store.enforceHistoryBudget(2500);
    const candidates = Store.candidatesFromPromotions(product.promotions, Store.SOURCES.PRODUCT_PAGE);
    if (candidates.length) await Store.upsert(candidates);
  }

  function buildPanel() {
    let panel = document.getElementById('coupon-hunter-panel'); if (panel) return panel;
    panel = document.createElement('aside'); panel.id = 'coupon-hunter-panel';
    panel.innerHTML = `
      <div class="ch-head"><div><span class="ch-brand">Coupon Hunter</span> <span class="ch-status" data-ch="status">анализирую…</span></div><button class="ch-toggle" data-ch="toggle" title="Свернуть">−</button></div>
      <div class="ch-body">
        <div class="ch-title" data-ch="title">AliExpress</div>
        <div><span class="ch-price" data-ch="price">—</span><span class="ch-old" data-ch="old"></span></div>
        <div class="ch-promo" data-ch="promo" hidden></div>
        <div class="ch-row"><span class="ch-label">SKU</span><span class="ch-value" data-ch="sku">—</span></div>
        <div class="ch-row"><span class="ch-label">Вариант</span><span class="ch-value" data-ch="variant">—</span></div>
        <div class="ch-row"><span class="ch-label">Продавец</span><span class="ch-value" data-ch="seller">—</span></div>
        <div class="ch-row"><span class="ch-label">Уверенность</span><span class="ch-value" data-ch="confidence">—</span></div>
        <div class="ch-actions"><button data-ch="refresh">Обновить</button><button class="ch-secondary" data-ch="discounts">Скидки</button><button class="ch-secondary" data-ch="copy">JSON</button></div>
      </div>`;
    document.documentElement.appendChild(panel);
    panel.querySelector('[data-ch="toggle"]').addEventListener('click', () => { panel.classList.toggle('ch-collapsed'); panel.querySelector('[data-ch="toggle"]').textContent = panel.classList.contains('ch-collapsed') ? '+' : '−'; });
    panel.querySelector('[data-ch="refresh"]').addEventListener('click', () => parseAndRender('manual', true));
    panel.querySelector('[data-ch="discounts"]').addEventListener('click', openPromotionSurface);
    panel.querySelector('[data-ch="copy"]').addEventListener('click', async () => {
      if (!state.product) return;
      try { await navigator.clipboard.writeText(JSON.stringify(await productDiagnostics(), null, 2)); const button = panel.querySelector('[data-ch="copy"]'); button.textContent = 'Скопировано'; setTimeout(() => { button.textContent = 'JSON'; }, 1200); } catch (_) {}
    });
    return panel;
  }

  function render(product) {
    const panel = state.panel || buildPanel(); state.panel = panel;
    const set = (name, value) => { const el = panel.querySelector(`[data-ch="${name}"]`); if (el) el.textContent = value ?? '—'; };
    set('title', product.title || 'AliExpress');
    const price = product.detectedPrice;
    set('price', Number.isFinite(price?.value) ? money(price.value, price.currency) : price?.isRange ? `${money(price.min, price.currency)}–${money(price.max, price.currency)}` : '—');
    panel.querySelector('[data-ch="old"]').textContent = product.oldPrice ? money(product.oldPrice, product.currency) : '';
    const promo = panel.querySelector('[data-ch="promo"]');
    if (product.promotions.length) { promo.textContent = `Найдено акций: ${product.promotions.length}. Непроверенные коды не считаются рабочими.`; promo.hidden = false; } else { promo.hidden = true; promo.textContent = ''; }
    set('sku', product.skuId || product.itemId || 'не найден'); set('variant', product.selectedVariant || 'не определён'); set('seller', product.seller || 'не определён');
    set('confidence', Number.isFinite(price?.value) ? `${price.confidence}%` : price?.isRange ? 'диапазон, SKU-цена не подтверждена' : 'цена не найдена');
    const status = panel.querySelector('[data-ch="status"]'); status.textContent = Number.isFinite(price?.value) ? '● цена SKU найдена' : '● требуется проверка'; status.classList.toggle('ch-error', !Number.isFinite(price?.value));
  }

  async function parseAndRender(reason = 'mutation', force = false) {
    const product = P.parseProduct(document, location.href); const signature = Adapter.productSignature(product);
    if (!force && signature === state.signature) return state.product;
    state.signature = signature; state.product = product; render(product); await saveSnapshot(product);
    return product;
  }

  async function openPromotionSurface() {
    const controls = Array.from(document.querySelectorAll('button,[role="button"],a')).slice(0, 1800);
    const control = controls.find((el) => {
      const text = P.normalizeSpace(el.textContent || el.getAttribute('aria-label') || '');
      return text.length <= 120 && /(скидк|купон|промокод|promo|coupon|discount|voucher)/i.test(text) && !/(купить|buy|корзин|cart|оплат|pay|order)/i.test(text) && el.getBoundingClientRect().width > 0;
    });
    if (!control) { state.panel.querySelector('[data-ch="status"]').textContent = 'окно скидок не найдено'; return; }
    Safety.safeClick(control, { purpose: 'Открытие окна скидок', intent: 'PROMO_SURFACE', requirePattern: /(скидк|купон|промокод|promo|coupon|discount|voucher)/i });
    setTimeout(() => parseAndRender('promotion-dialog', true), 700);
  }

  function safeUrl() { try { const url = new URL(location.href); return `${url.origin}${url.pathname}`; } catch (_) { return null; } }

  async function productDiagnostics() {
    const candidates = await Store.load();
    return { pageType: state.product?.pageType || P.parsePageType(location.href), url: safeUrl(), itemId: state.product?.itemId || null, skuId: state.product?.skuId || null, locale: state.product?.locale || null, currency: state.product?.currency || null, detectedPrice: state.product?.detectedPrice || null, priceCandidates: state.product?.debug?.priceCandidates || [], detectedPromotions: state.product?.promotions || [], couponCandidates: candidates, selectorMatches: state.product?.debug?.selectorMatches || [], checkoutState: null, verificationResults: [], parserVersion: P.parserVersion, timestamp: new Date().toISOString() };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'CH_GET_PRODUCT') { sendResponse(state.product || P.parseProduct(document, location.href)); return false; }
    if (message?.type === 'CH_RESCAN') { parseAndRender('message', true).then(sendResponse); return true; }
    if (message?.type === 'CH_OPEN_PROMOTIONS') { openPromotionSurface().then(() => sendResponse(true)); return true; }
    if (message?.type === 'CH_GET_PRODUCT_DIAGNOSTICS') { productDiagnostics().then(sendResponse); return true; }
    return false;
  });

  state.panel = buildPanel(); parseAndRender('initial', true);
  const schedule = Adapter.createScheduler((reason) => parseAndRender(reason, false));
  const observer = new MutationObserver((mutations) => { if (mutations.some((mutation) => Adapter.mutationIsMeaningful(mutation))) schedule('meaningful-mutation'); });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'aria-selected', 'aria-checked', 'data-selected', 'data-sku-id'] });
  setInterval(() => { if (location.href !== state.lastUrl) { state.lastUrl = location.href; state.signature = null; schedule('spa-navigation'); } }, 800);
})();
