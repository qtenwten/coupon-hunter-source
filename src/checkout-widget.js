(() => {
  'use strict';
  if (window.__COUPON_HUNTER_CHECKOUT_WIDGET_V340__) return;
  window.__COUPON_HUNTER_CHECKOUT_WIDGET_V340__ = true;

  const Core = globalThis.CouponHunterCheckoutWidgetCore;
  const Checkout = globalThis.CouponHunterCheckoutCore;
  const Intelligence = globalThis.CouponHunterPromoIntelligence;
  const Limits = globalThis.CouponHunterPromoConstants;
  const Store = globalThis.CouponHunterStorage;
  const Tester = globalThis.CouponHunterPromoTester;
  const Adapter = globalThis.CouponHunterPageAdapter;
  const Country = globalThis.CouponHunterCountryProfile;
  if (!Core || !Checkout || !Intelligence || !Limits || !Store || !Tester || !Country) return;

  let panel = null; let lastUrl = location.href; let actionMessage = null;
  const currencySymbol = (currency) => ({ RUB: '₽', USD: '$', EUR: '€', GBP: '£' }[currency] || currency || '');
  const money = (value, currency) => Number.isFinite(value) ? `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value)} ${currencySymbol(currency)}`.trim() : '—';

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message)); else resolve(response);
      });
    });
  }

  function sessionMatchesContext(session, context) {
    const binding = context?.binding;
    if (!session || !binding || session.origin !== binding.origin || session.pageClass !== binding.pageClass) return false;
    if (session.pathClass && binding.pathClass !== session.pathClass) return false;
    return !!(session.checkoutFingerprint && context.checkoutFingerprint && Checkout.sameCheckoutFingerprint(session.checkoutFingerprint, context.checkoutFingerprint));
  }

  function buildPanel() {
    const existing = document.getElementById('coupon-hunter-panel');
    if (existing?.getAttribute('data-ch-surface') === 'checkout') return existing;
    if (existing) existing.remove();
    const root = document.createElement('aside'); root.id = 'coupon-hunter-panel'; root.setAttribute('data-ch-surface', 'checkout');
    root.innerHTML = `
      <div class="ch-head"><div><span class="ch-brand">Coupon Hunter</span> <span class="ch-status" data-ch="status">готовлю базу…</span></div><button class="ch-toggle" data-ch="toggle" type="button" title="Свернуть">−</button></div>
      <div class="ch-body ch-checkout-body">
        <div class="ch-promo-stats"><span>Найдено: <b data-ch="found">0</b> кодов</span><span>Подходит для заказа: <b data-ch="applicable">0</b></span></div>
        <div class="ch-country">
          <label>Страна промокодов
            <select data-ch="country-select">
              <option value="AUTO">Авто</option><option value="RU">Россия</option><option value="DE">Германия</option><option value="GB">Великобритания</option>
              <option value="US">США</option><option value="AU">Австралия</option><option value="CZ">Чехия</option><option value="HU">Венгрия</option><option value="CL">Чили</option>
            </select>
          </label>
          <div data-ch="country-source">Страна не определена</div>
          <label class="ch-country-unknown"><input data-ch="include-unknown" type="checkbox" checked> Проверять коды с неизвестным регионом</label>
          <div data-ch="country-counts">MATCH 0 · GLOBAL 0 · UNKNOWN 0 · исключено 0</div>
        </div>
        <div class="ch-ready-message" data-ch="message">Проверяю состав заказа…</div>
        <button class="ch-primary-wide" data-ch="start" type="button">Подобрать лучший промокод</button>
        <div class="ch-checkout-diagnostics" data-ch="diagnostics" hidden>
          <div><span>Page type</span><b data-ch="diag-page">—</b></div>
          <div><span>Checkout surface</span><b data-ch="diag-surface">NO</b></div>
          <div><span>Total</span><b data-ch="diag-total">NOT FOUND</b></div>
          <div><span>Fingerprint</span><b data-ch="diag-fingerprint">WEAK</b></div>
          <div><span>Items detected</span><b data-ch="diag-items">0</b></div>
          <div><span>itemId detected</span><b data-ch="diag-item-ids">0</b></div>
          <div><span>skuId detected</span><b data-ch="diag-sku-ids">0</b></div>
          <div><span>Promo input/reveal</span><b data-ch="diag-promo">NOT FOUND</b></div>
          <button class="ch-secondary ch-copy-diagnostics" data-ch="copy-diagnostics" type="button">Скопировать диагностику</button>
        </div>
        <div class="ch-modes" data-ch="modes">
          <label><input type="radio" name="ch-mode" value="STANDARD" checked> Стандартный — до 30</label>
          <label><input type="radio" name="ch-mode" value="DEEP"> Глубокий — до 50</label>
        </div>
        <div class="ch-progress" data-ch="progress" hidden>
          <div class="ch-progress-title" data-ch="progress-title">Проверяем промокоды</div>
          <div><b data-ch="progress-count">Проверено: 0 из 0</b><span data-ch="current"></span></div>
          <div class="ch-promo-stats"><span>Рабочих: <b data-ch="working-count">0</b></span><span>Отклонено: <b data-ch="rejected-count">0</b></span><span>Не определено: <b data-ch="unknown-count">0</b></span></div>
        </div>
        <div class="ch-best" data-ch="best" hidden><span data-ch="best-label">Лучший сейчас</span><b data-ch="best-code">—</b><strong data-ch="best-saving">—</strong></div>
        <div class="ch-history-title" data-ch="history-title" hidden>История проверки · 0</div>
        <div class="ch-results" data-ch="results"></div>
        <div class="ch-actions ch-checkout-actions"><button class="ch-secondary" data-ch="stop" type="button" hidden>Остановить</button><button class="ch-secondary" data-ch="copy-results" type="button" hidden>Скопировать результаты</button><button data-ch="apply-best" type="button" hidden>Применить лучший</button></div>
      </div>`;
    document.documentElement.appendChild(root);
    root.querySelector('[data-ch="toggle"]').addEventListener('click', () => {
      root.classList.toggle('ch-collapsed'); root.querySelector('[data-ch="toggle"]').textContent = root.classList.contains('ch-collapsed') ? '+' : '−';
    });
    root.querySelector('[data-ch="start"]').addEventListener('click', async () => { actionMessage = null; await controller.start(); });
    root.querySelector('[data-ch="stop"]').addEventListener('click', async () => { actionMessage = 'Остановка после текущей безопасной операции…'; render(controller.view()); await controller.stop(); });
    root.querySelector('[data-ch="apply-best"]').addEventListener('click', async () => {
      actionMessage = null; const response = await controller.applyBest();
      actionMessage = response?.status === 'APPLIED' ? 'Лучший код применён. Проверьте итог перед оформлением заказа.' : response?.message || 'Код не применён.'; render(controller.view());
    });
    root.querySelector('[data-ch="copy-diagnostics"]').addEventListener('click', async () => {
      const diagnostics = controller.view().diagnostics;
      if (!diagnostics) return;
      try { await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2)); actionMessage = 'Безопасная диагностика скопирована.'; }
      catch (_) { actionMessage = 'Не удалось скопировать диагностику.'; }
      render(controller.view());
    });
    root.querySelector('[data-ch="copy-results"]').addEventListener('click', async () => {
      const payload = controller.view().resultsExport; if (!payload) return;
      try { await navigator.clipboard.writeText(JSON.stringify(payload, null, 2)); actionMessage = 'Безопасные результаты проверки скопированы.'; }
      catch (_) { actionMessage = 'Не удалось скопировать результаты.'; }
      render(controller.view());
    });
    for (const input of root.querySelectorAll('input[name="ch-mode"]')) input.addEventListener('change', () => { if (input.checked) controller.setMode(input.value); });
    root.querySelector('[data-ch="country-select"]').addEventListener('change', async (event) => { actionMessage = null; await controller.setCountry(event.target.value); });
    root.querySelector('[data-ch="include-unknown"]').addEventListener('change', async (event) => { actionMessage = null; await controller.setIncludeUnknownCountryCodes(event.target.checked); });
    return root;
  }

  function setText(root, name, value) { const element = root.querySelector(`[data-ch="${name}"]`); if (element) element.textContent = value ?? ''; }

  function statusText(view) {
    if (view.visible && !view.available) {
      if (!view.diagnostics?.checkoutSurfaceDetected) return 'проверка пока недоступна';
      return view.diagnostics?.fingerprint?.quality === 'WEAK' ? 'нужно уточнить состав заказа' : 'проверка пока недоступна';
    }
    if (view.state === Core.STATES.READY) return 'готов к проверке';
    if ([Core.STATES.TESTING, Core.STATES.FOUND_BEST].includes(view.state) && view.sessionStatus === 'TESTING') return '● проверка идёт';
    if (view.state === Core.STATES.FOUND_BEST) return '● лучший найден';
    if (view.state === Core.STATES.COMPLETE_NO_SAVING) return 'проверка завершена';
    if (view.state === Core.STATES.STOPPED) return '● остановлено';
    if ([Core.STATES.SAFETY_STOP, Core.STATES.ERROR].includes(view.state)) return '● остановлено';
    return 'ожидание checkout';
  }

  function primaryMessage(view) {
    if (actionMessage) return actionMessage;
    if (view.message) return view.message;
    if (view.sessionStatus === 'TESTING') return `Проверяем ${view.progress} из ${view.queueCount}`;
    if (view.completed && view.bestCode) return `Проверено ${view.testedCount} кодов. Лучший: −${money(view.bestSaving, view.currency)}`;
    if (view.state === Core.STATES.COMPLETE_NO_SAVING) return `Проверено ${view.progress} кодов. Подтверждённой экономии не найдено.`;
    if (view.state === Core.STATES.READY) return `${view.applicableCount} промокодов подходят для проверки`;
    if (view.state === Core.STATES.STOPPED) return 'Проверка остановлена пользователем.';
    return 'Проверка запускается только по вашему нажатию.';
  }

  function renderResults(root, view) {
    const container = root.querySelector('[data-ch="results"]'); const oldHeight = container.scrollHeight || 0; const oldTop = container.scrollTop || 0; const nearTop = oldTop <= 12; container.replaceChildren();
    for (const row of view.resultHistory) {
      const item = document.createElement('div'); item.className = `ch-result ch-${row.tone}${row.best ? ' ch-result-best' : ''}`;
      const icon = row.tone === 'success' ? '✓' : row.tone === 'unknown' ? '?' : '×';
      item.textContent = `${icon} ${row.code} — ${row.tone === 'success' ? `экономия ${money(row.saving, view.currency)}` : row.label}`;
      container.appendChild(item);
    }
    if (nearTop) container.scrollTop = 0; else container.scrollTop = oldTop + Math.max(0, (container.scrollHeight || 0) - oldHeight);
  }

  function render(view) {
    if (!view.visible) {
      if (panel?.getAttribute('data-ch-surface') === 'checkout') { panel.remove(); panel = null; }
      return;
    }
    panel = panel || buildPanel(); panel.hidden = false; panel.setAttribute('data-ch-state', view.state);
    setText(panel, 'status', statusText(view)); setText(panel, 'found', view.foundCount); setText(panel, 'applicable', view.applicableCount ?? '—'); setText(panel, 'message', primaryMessage(view));
    const countrySelect = panel.querySelector('[data-ch="country-select"]'); const selectValue = view.countryMode === 'MANUAL' ? view.countryCode : 'AUTO';
    if (view.countryCode && !Array.from(countrySelect.options).some((option) => option.value === view.countryCode)) { const option = document.createElement('option'); option.value = view.countryCode; option.textContent = `${view.countryName} (${view.countryCode})`; countrySelect.appendChild(option); }
    const autoOption = countrySelect.querySelector('option[value="AUTO"]'); if (autoOption) autoOption.textContent = `Авто: ${view.countryName}`;
    countrySelect.value = selectValue || 'AUTO'; countrySelect.disabled = view.countrySelectionDisabled;
    const sourceLabels = { AUTO: 'Авто', USER_MANUAL: 'Выбрана вручную', USER_FALLBACK: 'Сохранённый выбор', UNRESOLVED: 'Не определена' };
    setText(panel, 'country-source', `Страна: ${view.countryName}${view.countryCode ? ` (${view.countryCode})` : ''} · Источник: ${sourceLabels[view.countrySource] || view.countrySource}`);
    const unknownToggle = panel.querySelector('[data-ch="include-unknown"]'); unknownToggle.checked = view.includeUnknownCountryCodes; unknownToggle.disabled = view.countrySelectionDisabled;
    const counts = view.countryMatchCounts; setText(panel, 'country-counts', `MATCH ${counts.match} · GLOBAL ${counts.global} · UNKNOWN ${counts.unknown} · исключено ${counts.mismatch}`);
    const diagnostics = view.diagnostics || {}; const financial = diagnostics.financial || {}; const fingerprint = diagnostics.fingerprint || {}; const items = diagnostics.items || {}; const selectors = diagnostics.selectors || {};
    const diagnosticsRoot = panel.querySelector('[data-ch="diagnostics"]'); diagnosticsRoot.hidden = view.available;
    setText(panel, 'diag-page', diagnostics.pageType || 'UNKNOWN'); setText(panel, 'diag-surface', diagnostics.checkoutSurfaceDetected ? 'YES' : 'NO');
    setText(panel, 'diag-total', Number.isFinite(financial.total) ? money(financial.total, financial.currency) : 'NOT FOUND');
    setText(panel, 'diag-fingerprint', fingerprint.quality || 'WEAK'); setText(panel, 'diag-items', items.count || 0);
    setText(panel, 'diag-item-ids', items.itemIdDetected || 0); setText(panel, 'diag-sku-ids', items.skuIdDetected || 0);
    setText(panel, 'diag-promo', selectors.inputFound || selectors.revealFound ? 'FOUND' : 'NOT FOUND');
    const active = view.sessionStatus === 'TESTING'; const progress = panel.querySelector('[data-ch="progress"]'); progress.hidden = !active && !view.testedCount;
    setText(panel, 'progress-title', active ? (view.bestCode ? 'Проверяем промокоды · лучший уже найден' : 'Проверяем промокоды') : view.completed ? 'Результаты проверки' : 'Проверка остановлена');
    setText(panel, 'progress-count', `Проверено: ${view.testedCount} из ${view.queueCount}`); setText(panel, 'current', view.currentCode ? ` · сейчас ${view.currentCode}` : '');
    setText(panel, 'working-count', view.workingCount); setText(panel, 'rejected-count', view.rejectedCount); setText(panel, 'unknown-count', view.unknownCount);
    const best = panel.querySelector('[data-ch="best"]'); best.hidden = !view.bestCode;
    setText(panel, 'best-label', view.completed ? 'Лучший промокод' : 'Лучший сейчас');
    setText(panel, 'best-code', view.bestCode || '—'); setText(panel, 'best-saving', view.bestCode ? `−${money(view.bestSaving, view.currency)}` : '—');
    const start = panel.querySelector('[data-ch="start"]'); start.hidden = active; start.disabled = !view.canStart;
    panel.querySelector('[data-ch="modes"]').hidden = active;
    for (const input of panel.querySelectorAll('input[name="ch-mode"]')) { input.checked = input.value === view.mode; input.disabled = active; }
    const stop = panel.querySelector('[data-ch="stop"]'); stop.hidden = !view.canStop;
    const copyResults = panel.querySelector('[data-ch="copy-results"]'); copyResults.hidden = !view.canCopyResults;
    const apply = panel.querySelector('[data-ch="apply-best"]'); apply.hidden = !view.canApplyBest;
    const historyTitle = panel.querySelector('[data-ch="history-title"]'); historyTitle.hidden = view.testedCount === 0; setText(panel, 'history-title', `История проверки · ${view.testedCount}`);
    renderResults(panel, view);
  }

  const controller = Core.createController({
    limits: Limits,
    getContext: async () => { await Tester.refreshRecentProductContext(); return Tester.checkoutContext(); },
    loadSession: async () => (await chrome.storage.local.get('promoTestSession')).promoTestSession || null,
    loadCountrySettings: async () => chrome.storage.local.get(['promoCountryMode', 'promoCountry', 'includeUnknownCountryCodes']),
    saveCountrySettings: async (settings) => chrome.storage.local.set(settings),
    refreshFeed: async (force) => {
      const response = await runtimeMessage({ type: 'CH_REFRESH_PROMO_FEED', force: force === true });
      if (!response?.ok) throw new Error(response?.error || 'FEED_REFRESH_FAILED'); return response;
    },
    loadLibrary: () => Store.load(),
    buildQueue: (library, context, options) => Intelligence.buildQueue(library, context, options),
    sendCommand: (message) => Tester.executeCommand(message),
    sessionMatchesContext,
    onChange: render
  });

  function checkoutMutationIsMeaningful(mutation) {
    const target = mutation?.target instanceof Element ? mutation.target : mutation?.target?.parentElement;
    if (target?.closest?.('#coupon-hunter-panel')) return false;
    if (Adapter.mutationIsMeaningful(mutation)) return true;
    const identitySelector = '[data-item-id],[data-itemid],[data-product-id],[data-productid],[data-sku-id],[data-skuid],[data-variant-id],a[href*="/item/"]';
    if (mutation?.type === 'attributes') return ['data-item-id', 'data-itemid', 'data-product-id', 'data-productid', 'data-sku-id', 'data-skuid', 'data-variant-id', 'href'].includes(mutation.attributeName);
    if (mutation?.type !== 'childList') return false;
    return Array.from(mutation.addedNodes || []).slice(0, 20).some((node) => {
      if (!(node instanceof Element)) return false;
      if (node.matches?.(identitySelector) || node.querySelector?.(identitySelector)) return true;
      return /(оформление\s+заказа|ввести\s+промокод|итого\s+к\s+оплате|checkout|place\s+order)/i.test(String(node.textContent || '').slice(0, 500));
    });
  }

  controller.initialize();
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.promoTestSession) controller.restoreSession(changes.promoTestSession.newValue); });
  const schedule = Adapter?.createScheduler ? Adapter.createScheduler(() => { if (!controller.view().canStop) controller.refresh({ refreshFeed: true }); }, { debounceMs: 500, minIntervalMs: 1200 }) : null;
  if (schedule) {
    const observer = new MutationObserver((mutations) => { if (mutations.some(checkoutMutationIsMeaningful)) schedule('checkout-change'); });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'aria-selected', 'aria-checked', 'data-selected', 'data-item-id', 'data-itemid', 'data-product-id', 'data-productid', 'data-sku-id', 'data-skuid', 'data-variant-id', 'href'] });
  }
  setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; controller.refresh({ refreshFeed: true }); } }, 1000);

  globalThis.CouponHunterCheckoutWidget = { controller, render, sessionMatchesContext };
})();
