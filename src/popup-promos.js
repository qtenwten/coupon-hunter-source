(() => {
  'use strict';
  const Store = globalThis.CouponHunterStorage;
  const Core = globalThis.CouponHunterCheckoutCore;
  const Intelligence = globalThis.CouponHunterPromoIntelligence;
  const Feed = globalThis.CouponHunterPromoFeed;
  const Limits = globalThis.CouponHunterPromoConstants;
  const Safety = globalThis.CouponHunterSafety;
  const Country = globalThis.CouponHunterCountryProfile;
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const symbol = (currency) => ({ RUB: '₽', USD: '$', EUR: '€' }[currency] || currency || '');
  const money = (value, currency = 'RUB') => Number.isFinite(value) ? `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value)} ${symbol(currency)}`.trim() : '—';
  let currentProduct = null; let lastQueuePlan = null;

  async function activeTab() { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); return tab; }

  async function loadKnownCodes() {
    try {
      const response = await fetch(chrome.runtime.getURL('data/known-codes.json')); const payload = await response.json();
      return (Array.isArray(payload.codes) ? payload.codes : []).map((row) => Store.candidate({ ...row, source: Store.SOURCES.KNOWN_LIST })).filter(Boolean);
    } catch (_) { return []; }
  }

  function codesFromText(text, source = Store.SOURCES.USER) {
    return String(text || '').split(/[\s,;]+/).map((code) => Store.candidate({ code, source })).filter(Boolean).slice(0, Limits.MAX_LIBRARY_CANDIDATES);
  }

  const STATUS_LABELS = {
    VALID_APPLIED: 'Работает — проверено', INVALID: 'Отклонён для текущего заказа', EXPIRED: 'Закончился', NOT_STARTED: 'Ещё не начался',
    MINIMUM_SPEND_NOT_MET: 'Не достигнут минимум', NOT_APPLICABLE_TO_ITEMS: 'Не подходит для текущего заказа',
    REGION_RESTRICTED: 'Не подходит для текущего региона', ACCOUNT_RESTRICTED: 'Ограничение текущего аккаунта', ALREADY_USED: 'Уже использован',
    OUT_OF_STOCK: 'Лимит исчерпан', NOT_COLLECTED: 'Сначала нужно получить', RATE_LIMITED: 'Слишком много попыток',
    CAPTCHA: 'Нужна проверка безопасности', UNKNOWN_ERROR: 'Результат не определён', SKIPPED_CANNOT_BEAT_BEST: 'Пропущен: не превзойдёт лучший'
  };

  function resultClass(row) {
    if (row.verified && row.verificationStatus === Core.STATUS.VALID_APPLIED && row.saving > 0) return 'success';
    if ([Core.STATUS.UNKNOWN_ERROR, 'SKIPPED_CANNOT_BEAT_BEST'].includes(row.verificationStatus)) return 'unknown';
    return 'invalid';
  }

  function renderSession(session) {
    const root = $('promoResults'); const status = $('promoStatus');
    if (!session) { root.innerHTML = ''; $('applyBest').hidden = true; return; }
    const sorted = Core.sortVerificationResults(session.results || []);
    root.innerHTML = sorted.map((row) => {
      const before = row.priceBefore?.total; const after = row.priceAfter?.total; const currency = row.priceAfter?.currency || row.priceBefore?.currency || 'RUB';
      const best = session.bestCode === row.code && row.verified && row.saving > 0;
      const groups = new Set((row.sourceClaims || []).map((claim) => claim.sourceGroup).filter(Boolean)).size;
      const conditions = Number.isFinite(row.discountAmount) ? `−${money(row.discountAmount, row.discountCurrency || currency)}` : Number.isFinite(row.discountPercent) ? `−${row.discountPercent}%` : '';
      return `<article class="promoResult ${best ? 'best' : ''}">
        <div><code>${escapeHtml(row.code)}</code>${best ? '<b class="bestTag">BEST</b>' : ''}</div>
        <span class="${resultClass(row)}">${escapeHtml(STATUS_LABELS[row.verificationStatus] || row.verificationStatus || 'Не проверен')}</span>
        <span>${row.verified && row.saving > 0 ? `−${money(row.saving, currency)} · Было ${money(before, currency)} → ${money(after, currency)}` : escapeHtml(row.verificationMessage || `${conditions}${groups ? ` · источников: ${groups}` : ''}`)}</span>
      </article>`;
    }).join('');
    $('cancelPromos').hidden = session.status !== 'TESTING'; $('testPromos').disabled = session.status === 'TESTING'; $('deepPromos').disabled = session.status === 'TESTING';
    $('applyBest').hidden = !(session.status === 'COMPLETE' && session.bestCode && !session.bestApplied); $('applyBest').dataset.code = session.bestCode || '';
    if (session.status === 'TESTING') status.textContent = `Проверяется ${session.current || 'baseline'}… ${session.results?.length || 0} из ${session.codes?.length || 0}`;
    else if (session.status === 'COMPLETE') status.textContent = session.bestCode ? `${session.bestKnownProven ? 'Самый выгодный из известных подходящих кодов' : 'Лучший из проверенных кодов'}: ${session.bestCode}. Он не применён автоматически.` : 'Проверка завершена: подтверждённой экономии не найдено.';
    else status.textContent = session.stopReason || session.message || `Проверка остановлена: ${session.status}`;
  }

  async function sendToActive(message) {
    const tab = await activeTab();
    if (!tab?.id || !/^https:\/\/(?:[^/]+\.)?aliexpress\.(?:ru|com)\//i.test(tab.url || '')) throw new Error('Откройте страницу AliExpress');
    return chrome.tabs.sendMessage(tab.id, message);
  }

  async function checkoutContext() {
    let checkout = null;
    try { checkout = await sendToActive({ type: 'CH_GET_CHECKOUT_DIAGNOSTICS' }); } catch (_) {}
    const fingerprint = checkout?.checkoutFingerprint || {}; const state = checkout?.checkoutState || {};
    const settings = Country.sanitizeSettings(await chrome.storage.local.get(['promoCountryMode', 'promoCountry', 'includeUnknownCountryCodes']));
    const target = Country.resolveTarget(settings, { code: checkout?.countryCode, source: checkout?.countrySource, strong: !!checkout?.countryCode });
    return {
      currency: state.currency || fingerprint.currency || currentProduct?.currency || null,
      subtotal: state.subtotal, orderTotal: state.total, total: state.total,
      itemIds: (fingerprint.items || []).map((row) => row.itemId).filter(Boolean),
      sellerIds: (fingerprint.items || []).map((row) => row.sellerId).filter(Boolean),
      country: target.code, region: target.code, regionConfidence: target.code ? 1 : 0, includeUnknownCountryCodes: settings.includeUnknownCountryCodes,
      countryMode: settings.promoCountryMode, countrySource: target.source,
      isNewUser: null, newUserStatusConfidence: 0,
      fingerprintQuality: fingerprint.quality || 'WEAK'
    };
  }

  function ageLabel(ageMs, cacheStatus) {
    if (!Number.isFinite(ageMs)) return 'Remote feed не настроен';
    const minutes = Math.max(0, Math.round(ageMs / 60_000)); const amount = minutes < 60 ? `${minutes} мин назад` : `${Math.round(minutes / 60)} ч назад`;
    return cacheStatus === 'STALE_CACHE' ? `Используется кэш: ${amount}` : `База обновлена: ${amount}`;
  }

  async function renderLibrary(plan = null, cacheInfo = null) {
    const library = await Store.load(); const context = await checkoutContext(); const built = plan || Intelligence.buildQueue(library, context, { mode: 'STANDARD' });
    lastQueuePlan = built; $('promoLibraryCount').textContent = String(library.length); $('promoEligibleCount').textContent = String(built.diagnostics.eligible); $('promoQueueCount').textContent = `до ${built.diagnostics.rankedLiveQueue}`;
    const labels = { OFFICIAL_ALIEXPRESS: 'AliExpress', VERIFIED_PROVIDER: 'Проверенные источники', COMMUNITY: 'Сообщества', USER: 'Пользовательские', PRODUCT_PAGE: 'Страница товара', MANUAL_CURATED: 'Ручная база', UNKNOWN: 'Другие' };
    $('promoSourceBreakdown').textContent = Object.entries(built.diagnostics.sourceCounts).map(([key, value]) => `${labels[key] || key}: ${value}`).join(' · ') || 'Источники пока отсутствуют';
    const cache = cacheInfo || await Feed.cacheState(); $('promoFeedAge').textContent = ageLabel(cache.ageMs, cache.cacheStatus || (cache.fresh ? 'FRESH_CACHE' : 'STALE_CACHE'));
    return built;
  }

  async function ingestFeed(result) {
    await renderLibrary(null, result || null); return result;
  }

  async function refreshFeed(force = false) {
    const result = await Feed.refreshConfigured({ force });
    if (result.cacheStatus === 'NOT_CONFIGURED') { $('promoFeedAge').textContent = 'Remote feed не настроен; используются локальные источники'; return result; }
    await ingestFeed(result); return result;
  }

  async function refreshCandidates(product = currentProduct) {
    currentProduct = product || currentProduct; const known = await loadKnownCodes();
    if (known.length) await Store.upsert(known);
    if (currentProduct?.promotions?.length) await Store.upsert(Store.candidatesFromPromotions(currentProduct.promotions, Store.SOURCES.PRODUCT_PAGE));
    const rows = await Store.load(); const userRows = rows.filter((row) => (row.sourceClaims || []).some((claim) => claim.category === 'USER'));
    if (!$('promoCodes').value.trim()) $('promoCodes').value = userRows.map((row) => row.code).join('\n');
    const cache = await Feed.cacheState();
    await renderLibrary();
    if (!cache.fresh) refreshFeed(false).catch(() => { $('promoFeedAge').textContent = cache.promoFeed ? ageLabel(cache.ageMs, 'STALE_CACHE') : 'Remote feed недоступен; локальные коды сохранены'; });
    const { promoTestSession = null } = await chrome.storage.local.get('promoTestSession'); renderSession(promoTestSession);
  }

  async function runVerification(mode) {
    const typed = codesFromText($('promoCodes').value); if (typed.length) await Store.upsert(typed);
    const cache = await Feed.cacheState(); if (!cache.fresh) { try { await refreshFeed(false); } catch (_) {} }
    const library = await Store.load(); if (!library.length) { $('promoStatus').textContent = 'Нет кодов для проверки.'; return; }
    const plan = Intelligence.buildQueue(library, await checkoutContext(), { mode }); await renderLibrary(plan);
    if (!plan.queue.length) { $('promoStatus').textContent = 'После безопасной фильтрации подходящих кодов не осталось.'; return; }
    $('testPromos').disabled = true; $('deepPromos').disabled = true; $('promoStatus').textContent = `Подготовлена ${mode === 'DEEP' ? 'глубокая' : 'стандартная'} очередь: ${plan.queue.length}. Определяю baseline…`;
    try {
      renderSession(await sendToActive({ type: 'CH_TEST_PROMOS', candidates: plan.queue, queueMeta: { mode, ...plan.diagnostics } }));
    } catch (error) { $('promoStatus').textContent = error?.message || 'Не удалось запустить проверку.'; }
    finally { $('testPromos').disabled = false; $('deepPromos').disabled = false; }
  }

  async function exportDiagnostics() {
    let product = null; let checkout = null;
    try { product = await sendToActive({ type: 'CH_GET_PRODUCT_DIAGNOSTICS' }); } catch (_) {}
    try { checkout = await sendToActive({ type: 'CH_GET_CHECKOUT_DIAGNOSTICS' }); } catch (_) {}
    const { promoTestSession = null } = await chrome.storage.local.get('promoTestSession'); const payload = product || checkout || { pageType: 'UNKNOWN' };
    const merged = { ...payload, ...(checkout || {}), itemId: product?.itemId || null, skuId: product?.skuId || null, detectedPrice: product?.detectedPrice || null, priceCandidates: product?.priceCandidates || [], detectedPromotions: product?.detectedPromotions || [], couponCandidates: await Store.load(), storageDiagnostics: await Store.storageDiagnostics(), promoIntelligence: lastQueuePlan?.diagnostics || null, checkoutState: checkout?.checkoutState || null, verificationResults: promoTestSession?.results || [], parserVersion: product?.parserVersion || checkout?.parserVersion || '3.4.1', timestamp: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(merged, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `coupon-hunter-debug-${Date.now()}.json`; Safety.safeClick(link, { purpose: 'Скачивание диагностики', intent: 'DOWNLOAD' }); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function bind() {
    $('savePromos').addEventListener('click', async () => { const candidates = codesFromText($('promoCodes').value); await Store.upsert(candidates); $('promoCodes').value = candidates.map((row) => row.code).join('\n'); $('promoStatus').textContent = `Добавлено пользовательских кодов: ${candidates.length}.`; await renderLibrary(); });
    $('refreshPromoFeed').addEventListener('click', async () => { $('refreshPromoFeed').disabled = true; $('promoFeedAge').textContent = 'Обновляю базу…'; try { const result = await refreshFeed(true); if (result.cacheStatus === 'REFRESHED') $('promoStatus').textContent = `База обновлена: ${result.feed.promos.length} кодов.`; } catch (error) { $('promoStatus').textContent = `База не обновлена: ${error.message}. Локальные коды доступны.`; } finally { $('refreshPromoFeed').disabled = false; } });
    $('testPromos').addEventListener('click', () => runVerification('STANDARD')); $('deepPromos').addEventListener('click', () => runVerification('DEEP'));
    $('cancelPromos').addEventListener('click', async () => { try { await sendToActive({ type: 'CH_CANCEL_PROMO_TEST' }); $('promoStatus').textContent = 'Остановка после текущей операции…'; } catch (_) {} });
    $('applyBest').addEventListener('click', async () => { const code = $('applyBest').dataset.code; if (!code) return; $('applyBest').disabled = true; try { const response = await sendToActive({ type: 'CH_APPLY_BEST_PROMO', code }); $('promoStatus').textContent = response.status === 'APPLIED' ? `Код ${code} применён. Проверьте итог перед оплатой.` : response.message || 'Код не применён.'; if (response.status === 'APPLIED') $('applyBest').hidden = true; } catch (error) { $('promoStatus').textContent = error?.message || 'Не удалось применить код.'; } finally { $('applyBest').disabled = false; } });
    $('exportDebug').addEventListener('click', exportDiagnostics);
    chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.promoTestSession) renderSession(changes.promoTestSession.newValue); });
  }

  bind();
  globalThis.CouponHunterPopupPromos = { refreshCandidates, renderSession, renderLibrary, refreshFeed, runVerification, exportDiagnostics };
})();
