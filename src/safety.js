(() => {
  'use strict';
  if (globalThis.CouponHunterSafety) return;

  const FORBIDDEN_ACTION = /(?:place\s*order|submit\s*order|confirm\s*order|checkout|buy\s*now|continue\s*to\s*payment|pay(?:\s*now)?|оформить\s*заказ|разместить\s*заказ|подтвердить\s*заказ|перейти\s*к\s*оплате|оплатить|купить|заказать)/i;
  const normalize = (value = '') => String(value).replace(/[\s\u00A0\u202F]+/g, ' ').trim();

  function labelOf(element) {
    return normalize([
      element?.textContent, element?.value, element?.getAttribute?.('aria-label'),
      element?.getAttribute?.('title'), element?.getAttribute?.('data-testid')
    ].filter(Boolean).join(' '));
  }

  function isVisible(element) {
    if (!element || typeof element.getBoundingClientRect !== 'function') return false;
    const rect = element.getBoundingClientRect();
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : { display: 'block', visibility: 'visible', opacity: '1' };
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity ?? 1) !== 0;
  }

  function isForbiddenActionLabel(label) { return FORBIDDEN_ACTION.test(normalize(label)); }

  function safeClick(element, { purpose = 'Действие', intent = 'SITE_ACTION', requirePattern = null } = {}) {
    if (!element || typeof element.click !== 'function') throw new Error(`${purpose}: элемент не найден`);
    const label = labelOf(element);
    if (intent !== 'DOWNLOAD') {
      if (!isVisible(element) || element.disabled || element.getAttribute?.('aria-disabled') === 'true') throw new Error(`${purpose}: элемент недоступен`);
      if (isForbiddenActionLabel(label)) throw new Error(`${purpose}: заблокирована потенциально опасная кнопка «${label.slice(0, 100)}»`);
      if (requirePattern && !requirePattern.test(label)) throw new Error(`${purpose}: назначение элемента не подтверждено`);
    }
    element.click();
    return { clicked: true, label, intent };
  }

  globalThis.CouponHunterSafety = { FORBIDDEN_ACTION, normalize, labelOf, isVisible, isForbiddenActionLabel, safeClick };
})();
