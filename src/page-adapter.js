(() => {
  'use strict';
  if (globalThis.CouponHunterPageAdapter) return;

  function mutationIsMeaningful(mutation, ignoredRootId = 'coupon-hunter-panel') {
    const target = mutation?.target instanceof Element ? mutation.target : mutation?.target?.parentElement;
    if (target?.closest?.(`#${ignoredRootId}`)) return false;
    if (mutation?.type === 'attributes') {
      if (!['class', 'aria-selected', 'aria-checked', 'data-selected', 'data-sku-id'].includes(mutation.attributeName)) return false;
      const signature = `${target?.className || ''} ${target?.getAttribute?.('data-pl') || ''} ${target?.getAttribute?.('aria-label') || ''}`;
      return /(price|sku|variant|coupon|promo|discount|selected)/i.test(signature) || ['aria-selected', 'aria-checked', 'data-selected', 'data-sku-id'].includes(mutation.attributeName);
    }
    if (mutation?.type === 'characterData') {
      const text = String(mutation.target?.data || target?.textContent || '').slice(0, 180);
      return /\d|₽|\$|€|price|цена|купон|promo/i.test(text);
    }
    if (mutation?.type === 'childList') {
      const text = Array.from(mutation.addedNodes || []).slice(0, 8).map((node) => node.textContent || '').join(' ').slice(0, 400);
      return !text || /\d|₽|\$|€|price|цена|sku|variant|купон|promo|discount|скид/i.test(text);
    }
    return false;
  }

  function createScheduler(callback, { debounceMs = 450, minIntervalMs = 700 } = {}) {
    let timer = null;
    let lastRun = 0;
    let stopped = false;
    const schedule = (reason = 'mutation') => {
      if (stopped) return;
      clearTimeout(timer);
      const wait = Math.max(debounceMs, minIntervalMs - (Date.now() - lastRun));
      timer = setTimeout(async () => {
        if (stopped) return;
        lastRun = Date.now();
        await callback(reason);
      }, wait);
    };
    schedule.stop = () => { stopped = true; clearTimeout(timer); };
    return schedule;
  }

  function productSignature(product) {
    return JSON.stringify([product?.itemId, product?.skuId, product?.selectedVariant, product?.detectedPrice?.value, product?.detectedPrice?.min, product?.detectedPrice?.max, (product?.promotions || []).map((row) => row.id)]);
  }

  globalThis.CouponHunterPageAdapter = { mutationIsMeaningful, createScheduler, productSignature };
})();
