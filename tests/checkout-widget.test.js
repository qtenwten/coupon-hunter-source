const { test } = require('./harness');
const fs = require('node:fs');
const { ROOT, sandbox, load } = require('./helpers');

const box = load(sandbox(), 'src/country-profile.js', 'src/checkout-widget-core.js');
const Core = box.CouponHunterCheckoutWidgetCore;
const LIMITS = { DEFAULT_LIVE_ATTEMPTS: 30, DEEP_SCAN_LIVE_ATTEMPTS: 50, HARD_LIVE_ATTEMPT_LIMIT: 50 };

test('checkout widget exposes the required finite UI states', (t) => {
  t.deep(Object.values(Core.STATES), ['IDLE', 'READY', 'TESTING', 'FOUND_BEST', 'COMPLETE_NO_SAVING', 'STOPPED', 'SAFETY_STOP', 'ERROR']);
});

test('checkout widget exposes the explicit Russian start, stop and apply-best controls', (t) => {
  const source = fs.readFileSync(`${ROOT}/src/checkout-widget.js`, 'utf8');
  t.match(source, />Подобрать лучший промокод</); t.match(source, />Остановить</); t.match(source, />Применить лучший</);
  t.match(source, /Стандартный — до 30/); t.match(source, /Глубокий — до 50/);
  t.match(source, />Скопировать результаты</); t.match(source, /Проверено:/);
});

test('unavailable checkout context does not remove a detected checkout widget', (t) => {
  const source = fs.readFileSync(`${ROOT}/src/checkout-widget.js`, 'utf8');
  const renderSource = source.slice(source.indexOf('function render(view)'), source.indexOf('const controller ='));
  t.match(renderSource, /if \(!view\.visible\)/); t.ok(!/if \(!view\.available\)[\s\S]{0,120}panel\.remove/.test(renderSource));
});

function completeSession(bestCode = null) {
  const results = bestCode ? [{
    code: bestCode, verified: true, verificationStatus: 'VALID_APPLIED', saving: 1200,
    priceBefore: { total: 9990, currency: 'RUB' }, priceAfter: { total: 8790, currency: 'RUB' }, baselineRestored: true
  }] : [{ code: 'NOPE1', verified: true, verificationStatus: 'INVALID', saving: 0 }];
  return { status: 'COMPLETE', codes: results.map((row) => row.code), results, bestCode, currency: 'RUB' };
}

function createHarness(options = {}) {
  const commands = []; const savedCountrySettings = []; let refreshCalls = 0; let contextRead = 0;
  let countrySettings = { promoCountryMode: 'AUTO', promoCountry: null, includeUnknownCountryCodes: true, ...(options.countrySettings || {}) };
  const library = options.library || Array.from({ length: 60 }, (_, index) => ({ code: `CODE${String(index).padStart(2, '0')}`, rankScore: 1000 - index }));
  const context = options.context || { checkoutSurfaceDetected: true, available: true, currency: 'RUB', checkoutFingerprint: { signature: 'cart-1' }, binding: { origin: 'https://aliexpress.ru', pageClass: 'CHECKOUT', pathClass: '/checkout' } };
  const controller = Core.createController({
    limits: LIMITS,
    getContext: async () => options.contexts ? options.contexts[Math.min(contextRead++, options.contexts.length - 1)] : context,
    loadSession: async () => options.session || null,
    loadCountrySettings: async () => ({ ...countrySettings }),
    saveCountrySettings: async (settings) => { countrySettings = { ...settings }; savedCountrySettings.push({ ...settings }); },
    refreshFeed: async () => { refreshCalls += 1; return { ok: true, count: library.length }; },
    loadLibrary: async () => library,
    buildQueue: options.buildQueue || ((rows, _checkout, config) => {
      const limit = Core.modeLimit(config.mode, LIMITS);
      const eligible = rows.slice().sort((a, b) => b.rankScore - a.rankScore);
      return { queue: eligible.slice(0, limit), diagnostics: { eligible: eligible.length, limit, queueCoversAllEligible: eligible.length <= limit, countryMatchCounts: { match: 0, global: 0, unknown: eligible.length, mismatch: 0 } } };
    }),
    sendCommand: async (message) => {
      commands.push(JSON.parse(JSON.stringify(message)));
      if (message.type === 'CH_TEST_PROMOS') return options.runResult || completeSession('CODE00');
      if (message.type === 'CH_APPLY_BEST_PROMO') return { status: 'APPLIED' };
      return { status: 'CANCELLING' };
    },
    sessionMatchesContext: options.sessionMatchesContext || (() => true)
  });
  return { controller, commands, savedCountrySettings, get refreshCalls() { return refreshCalls; }, get countrySettings() { return countrySettings; } };
}

test('checkout widget initializes READY without starting PromoTester', async (t) => {
  const harness = createHarness(); const view = await harness.controller.initialize();
  t.equal(view.state, 'READY'); t.equal(harness.commands.length, 0); t.equal(harness.refreshCalls, 1);
});

test('checkout-like surface stays visible when fingerprint is WEAK and start remains disabled', async (t) => {
  const diagnostics = { fingerprint: { quality: 'WEAK', componentsUsed: ['currency'] } };
  const harness = createHarness({ context: { checkoutSurfaceDetected: true, available: false, reason: 'Не удалось надёжно определить состав заказа', diagnostics } });
  const view = await harness.controller.initialize();
  t.equal(view.visible, true); t.equal(view.available, false); t.equal(view.state, 'IDLE'); t.equal(view.canStart, false); t.deep(harness.commands, []);
  t.equal(view.foundCount, 60); t.equal(view.applicableCount, null); t.equal(harness.refreshCalls, 1);
});

test('blocked verifier still loads library while applicability remains unknown', async (t) => {
  const harness = createHarness({ context: { checkoutSurfaceDetected: true, available: false, fingerprintQuality: 'WEAK' } });
  const view = await harness.controller.initialize();
  t.equal(view.foundCount, 60); t.equal(view.applicableCount, null); t.equal(view.canStart, false);
  const source = fs.readFileSync(`${ROOT}/src/checkout-widget.js`, 'utf8'); t.match(source, /view\.applicableCount \?\? '—'/);
});

test('checkout candidate remains visible when independent evidence is not yet sufficient', async (t) => {
  const harness = createHarness({ context: { checkoutSurfaceCandidate: true, checkoutSurfaceDetected: false, available: false, reason: 'Не удалось распознать страницу checkout' } });
  const view = await harness.controller.initialize();
  t.equal(view.visible, true); t.equal(view.available, false); t.equal(view.canStart, false); t.match(view.message, /распознать страницу checkout/);
});

test('ready checkout surface enables explicit start', async (t) => {
  const harness = createHarness(); const view = await harness.controller.initialize();
  t.equal(view.visible, true); t.equal(view.state, 'READY'); t.equal(view.canStart, true);
});

test('widget transitions from visible WEAK state to READY after identity appears', async (t) => {
  const weak = { checkoutSurfaceDetected: true, available: false, diagnostics: { fingerprint: { quality: 'WEAK' } } };
  const ready = { checkoutSurfaceDetected: true, available: true, currency: 'RUB', checkoutFingerprint: { signature: 'cart-ready' }, binding: { origin: 'https://aliexpress.ru', pageClass: 'CHECKOUT', pathClass: '/checkout' } };
  const harness = createHarness({ contexts: [weak, ready] });
  const first = await harness.controller.initialize(); const second = await harness.controller.refresh({ refreshFeed: true });
  t.equal(first.visible, true); t.equal(first.canStart, false); t.equal(second.state, 'READY'); t.equal(second.canStart, true); t.equal(second.foundCount, 60);
});

test('remote feed refresh never starts automatic promo verification', async (t) => {
  const harness = createHarness(); await harness.controller.initialize(); await harness.controller.refresh({ refreshFeed: true });
  t.equal(harness.refreshCalls, 2); t.equal(harness.commands.some((row) => row.type === 'CH_TEST_PROMOS'), false);
});

test('only explicit start sends CH_TEST_PROMOS', async (t) => {
  const harness = createHarness(); await harness.controller.initialize();
  t.equal(harness.commands.length, 0); await harness.controller.start();
  t.equal(harness.commands.length, 1); t.equal(harness.commands[0].type, 'CH_TEST_PROMOS');
});

test('Standard mode sends at most 30 candidates in deterministic rank order', async (t) => {
  const harness = createHarness(); await harness.controller.initialize(); await harness.controller.start();
  const command = harness.commands[0]; t.equal(command.candidates.length, 30);
  t.deep(command.candidates.slice(0, 3).map((row) => row.code), ['CODE00', 'CODE01', 'CODE02']); t.equal(command.queueMeta.mode, 'STANDARD');
});

test('Deep mode sends at most 50 candidates in deterministic rank order', async (t) => {
  const harness = createHarness(); await harness.controller.initialize(); harness.controller.setMode('DEEP'); await harness.controller.start();
  const command = harness.commands[0]; t.equal(command.candidates.length, 50);
  t.deep(command.candidates.slice(-2).map((row) => row.code), ['CODE48', 'CODE49']); t.equal(command.queueMeta.mode, 'DEEP');
});

test('Stop control maps exactly to CH_CANCEL_PROMO_TEST', async (t) => {
  const harness = createHarness(); await harness.controller.stop();
  t.deep(harness.commands, [{ type: 'CH_CANCEL_PROMO_TEST' }]);
});

test('completed verification never applies BEST automatically', async (t) => {
  const harness = createHarness(); await harness.controller.initialize(); const view = await harness.controller.start();
  t.equal(view.state, 'FOUND_BEST'); t.equal(view.canApplyBest, true);
  t.deep(harness.commands.map((row) => row.type), ['CH_TEST_PROMOS']);
});

test('temporary applied result is not BEST until baseline restoration is confirmed', (t) => {
  const session = { status: 'TESTING', codes: ['CODE1'], results: [{ code: 'CODE1', verified: true, verificationStatus: 'VALID_APPLIED', saving: 1200 }] };
  t.equal(Core.bestResult(session), null);
  session.results[0].baselineRestored = true; t.equal(Core.bestResult(session).code, 'CODE1');
});

test('UNKNOWN result displays a safe verification message or promo response snippet', async (t) => {
  const session = { status: 'COMPLETE', codes: ['DELD06'], results: [{ code: 'DELD06', verified: false, verificationStatus: 'UNKNOWN_ERROR', verificationMessage: 'ответ сайта не распознан', responseEvidence: { responseSnippet: 'Промокод временно недоступен' } }] };
  const view = await createHarness({ session }).controller.initialize();
  t.equal(view.recentResults[0].tone, 'unknown'); t.equal(view.recentResults[0].label, 'Промокод временно недоступен');
  t.equal(view.unknownCount, 1); t.equal(view.testedCount, 1);
});

test('live DELD12 EXPIRED result renders as rejected and expired', async (t) => {
  const session = { status: 'COMPLETE', codes: ['DELD12'], results: [{ code: 'DELD12', verified: true, verificationStatus: 'EXPIRED', verificationMessage: 'Промокод больше не действует', saving: 0 }] };
  const view = await createHarness({ session }).controller.initialize();
  t.equal(view.recentResults[0].code, 'DELD12'); t.equal(view.recentResults[0].tone, 'rejected'); t.equal(view.recentResults[0].label, 'истёк');
});

test('inconclusive streak renders stopped counters and copyable safe results', async (t) => {
  const session = {
    status: 'INCONCLUSIVE_RESPONSE_STREAK', stopReason: 'Остановлено: 3 неопределённых ответа подряд', codes: ['A1', 'A2', 'A3', 'A4'],
    results: [
      { code: 'A1', verificationStatus: 'UNKNOWN_ERROR', verificationMessage: 'Нет ответа', saving: 0, privateName: 'Иван', itemId: 'SECRET-ITEM', responseEvidence: { applyClicked: true, responseSnippet: 'Нет ответа', hiddenAddress: 'secret' } },
      { code: 'A2', verificationStatus: 'INVALID', verificationMessage: 'Promo code is invalid', verified: true, saving: 0 },
      { code: 'A3', verificationStatus: 'VALID_APPLIED', verificationMessage: 'applied', verified: true, saving: 100, baselineRestored: true }
    ]
  };
  const view = await createHarness({ session }).controller.initialize();
  t.equal(view.state, 'STOPPED'); t.equal(view.testedCount, 3); t.equal(view.workingCount, 1); t.equal(view.rejectedCount, 1); t.equal(view.unknownCount, 1);
  t.equal(view.canCopyResults, true); t.equal(view.resultsExport.status, 'INCONCLUSIVE_RESPONSE_STREAK');
  const json = JSON.stringify(view.resultsExport); t.ok(!json.includes('SECRET-ITEM')); t.ok(!json.includes('privateName')); t.ok(!json.includes('hiddenAddress'));
  t.deep(Object.keys(view.resultsExport.results[0]), ['code', 'verificationStatus', 'verificationMessage', 'saving', 'baselineRestored', 'responseEvidence']);
});

test('copy-results sanitizer excludes personal promo-response text', (t) => {
  const payload = Core.safeResultsExport({ status: 'COMPLETE', stopReason: null, results: [{ code: 'A1', verificationStatus: 'UNKNOWN_ERROR', verificationMessage: 'Получатель Иван, телефон +7 999 123-45-67', responseEvidence: { responseSnippet: 'Адрес доставки: Москва', responseSource: 'ROLE_ALERT' } }] });
  t.equal(payload.results[0].verificationMessage, null); t.equal(payload.results[0].responseEvidence.responseSnippet, null);
  t.equal(payload.results[0].responseEvidence.responseTextFound, false);
});

test('BEST is applied only by explicit applyBest action', async (t) => {
  const harness = createHarness({ session: completeSession('BEST20') }); await harness.controller.initialize();
  t.equal(harness.commands.length, 0); const response = await harness.controller.applyBest();
  t.equal(response.status, 'APPLIED'); t.deep(harness.commands, [{ type: 'CH_APPLY_BEST_PROMO', code: 'BEST20' }]);
});

test('persisted completed session restores progress, recent results and BEST', async (t) => {
  const session = completeSession('BEST20'); session.codes = ['BEST20', 'NOPE1']; session.results.push({ code: 'NOPE1', verified: true, verificationStatus: 'INVALID', saving: 0 });
  const harness = createHarness({ session }); const view = await harness.controller.initialize();
  t.equal(view.state, 'FOUND_BEST'); t.equal(view.progress, 2); t.equal(view.bestCode, 'BEST20'); t.equal(view.bestSaving, 1200); t.equal(view.recentResults.length, 2);
});

test('session with 30 tested results exposes all rows newest-first without BEST duplication', async (t) => {
  const results = Array.from({ length: 30 }, (_, index) => ({ code: `R${String(index).padStart(2, '0')}`, verified: true, verificationStatus: index === 7 ? 'VALID_APPLIED' : 'INVALID', saving: index === 7 ? 500 : 0, baselineRestored: index === 7 }));
  const session = { status: 'COMPLETE', codes: results.map((row) => row.code), results, bestCode: 'R07', currency: 'RUB' };
  const view = await createHarness({ session }).controller.initialize();
  t.equal(view.resultHistory.length, 30); t.equal(view.recentResults.length, 30); t.equal(view.resultHistory[0].code, 'R29'); t.equal(view.resultHistory.at(-1).code, 'R00');
  t.equal(view.resultHistory.filter((row) => row.code === 'R07').length, 1); t.equal(view.resultHistory.find((row) => row.code === 'R07').best, true);
  t.equal(view.resultsExport.results.length, view.testedCount);
});

test('session with 50 tested results survives restoreSession without truncation', async (t) => {
  const results = Array.from({ length: 50 }, (_, index) => ({ code: `D${String(index).padStart(2, '0')}`, verified: true, verificationStatus: 'EXPIRED', saving: 0 }));
  const harness = createHarness(); await harness.controller.initialize();
  const view = harness.controller.restoreSession({ status: 'COMPLETE', codes: results.map((row) => row.code), results, bestCode: null });
  t.equal(view.resultHistory.length, 50); t.equal(view.resultHistory[0].code, 'D49'); t.equal(view.resultHistory[49].code, 'D00');
  t.equal(view.resultsExport.results.length, 50);
});

test('history UI is scroll-bounded and production code contains no four/five-result truncation', (t) => {
  const core = fs.readFileSync(`${ROOT}/src/checkout-widget-core.js`, 'utf8'); const css = fs.readFileSync(`${ROOT}/src/content.css`, 'utf8'); const ui = fs.readFileSync(`${ROOT}/src/checkout-widget.js`, 'utf8');
  t.ok(!core.includes('results.slice(-4)')); t.ok(!core.includes('recent.slice(-5)')); t.ok(!css.includes('max-height:min(300px, 35vh)')); t.match(css, /overflow-y:auto/);
  t.match(ui, /История проверки ·/); t.match(ui, /oldTop \+ Math\.max/);
});

test('checkout panel has fixed responsive outer height independent of result count', (t) => {
  const css = fs.readFileSync(`${ROOT}/src/content.css`, 'utf8');
  t.match(css, /#coupon-hunter-panel\[data-ch-surface="checkout"\]\s*\{[^}]*width:340px;[^}]*height:min\(680px, calc\(100vh - 36px\)\);[^}]*max-height:calc\(100vh - 36px\);[^}]*display:flex;[^}]*flex-direction:column;/);
  t.match(css, /@media \(max-height:620px\)[\s\S]*height:calc\(100vh - 36px\)/);
  t.ok(!/data-ch-state[^}]*height:/.test(css));
});

test('checkout body and history use shrinkable flex layout with internal results scrolling', (t) => {
  const css = fs.readFileSync(`${ROOT}/src/content.css`, 'utf8');
  t.match(css, /\.ch-checkout-body\s*\{[^}]*flex:1 1 auto;[^}]*min-height:0;[^}]*display:flex;[^}]*flex-direction:column;[^}]*overflow:hidden;/);
  t.match(css, /\.ch-history\s*\{[^}]*flex:1 1 auto;[^}]*min-height:120px;[^}]*display:flex;[^}]*flex-direction:column;[^}]*overflow:hidden;/);
  t.match(css, /\.ch-results\s*\{[^}]*flex:1 1 auto;[^}]*min-height:0;[^}]*overflow-y:auto;/);
});

test('history exists empty, action bar is outside its scroll and collapsed checkout is header-only', (t) => {
  const ui = fs.readFileSync(`${ROOT}/src/checkout-widget.js`, 'utf8'); const css = fs.readFileSync(`${ROOT}/src/content.css`, 'utf8');
  t.match(ui, /class="ch-history"[\s\S]*Результаты появятся здесь[\s\S]*(?:<\/div>\s*){4}<div class="ch-actions ch-checkout-actions"/);
  t.match(css, /\.ch-checkout-actions\s*\{[^}]*flex:0 0 auto;/);
  t.match(css, /data-ch-surface="checkout"\]\.ch-collapsed\s*\{[^}]*height:auto;[^}]*max-height:none;/);
});

test('product panel retains its original auto-height 300px base layout', (t) => {
  const css = fs.readFileSync(`${ROOT}/src/content.css`, 'utf8');
  t.match(css, /#coupon-hunter-panel\s*\{[^}]*width: 300px;/); t.ok(!/#coupon-hunter-panel\s*\{[^}]*height:/s.test(css));
});

test('manual country change rebuilds queue without starting verifier', async (t) => {
  const library = [{ code: 'RU10', regions: ['RU'] }, { code: 'DE10', regions: ['DE'] }];
  const buildQueue = (rows, context) => { const queue = rows.filter((row) => row.regions.includes(context.country)); return { queue, diagnostics: { eligible: queue.length, countryMatchCounts: { match: queue.length, global: 0, unknown: 0, mismatch: rows.length - queue.length } } }; };
  const harness = createHarness({ library, countrySettings: { promoCountryMode: 'MANUAL', promoCountry: 'RU' }, buildQueue });
  let view = await harness.controller.initialize(); t.equal(view.countryCode, 'RU'); t.equal(view.applicableCount, 1);
  view = await harness.controller.setCountry('DE');
  t.equal(view.countryCode, 'DE'); t.equal(view.countryMode, 'MANUAL'); t.equal(view.applicableCount, 1); t.equal(harness.commands.some((row) => row.type === 'CH_TEST_PROMOS'), false);
  t.equal(harness.savedCountrySettings.at(-1).promoCountry, 'DE');
});

test('AUTO country uses strong RU signal and saved country is only fallback', async (t) => {
  const context = { checkoutSurfaceDetected: true, available: true, countrySignal: { code: 'RU', strong: true, source: 'ALIEXPRESS_STRUCTURED' } };
  const view = await createHarness({ context, countrySettings: { promoCountryMode: 'AUTO', promoCountry: 'DE' } }).controller.initialize();
  t.equal(view.countryCode, 'RU'); t.equal(view.countrySource, 'AUTO'); t.equal(view.countryName, 'Россия');
});

test('active verification disables and ignores country changes', async (t) => {
  const session = { status: 'TESTING', codes: ['A1'], current: 'A1', results: [] };
  const harness = createHarness({ session, countrySettings: { promoCountryMode: 'MANUAL', promoCountry: 'RU' } }); const before = await harness.controller.initialize();
  const after = await harness.controller.setCountry('DE');
  t.equal(before.countrySelectionDisabled, true); t.equal(after.countryCode, 'RU'); t.equal(harness.savedCountrySettings.length, 0); t.deep(harness.commands, []);
});

test('unknown-country toggle rebuilds queue without CH_TEST_PROMOS', async (t) => {
  const harness = createHarness(); await harness.controller.initialize(); const view = await harness.controller.setIncludeUnknownCountryCodes(false);
  t.equal(view.includeUnknownCountryCodes, false); t.equal(harness.savedCountrySettings.at(-1).includeUnknownCountryCodes, false);
  t.equal(harness.commands.some((row) => row.type === 'CH_TEST_PROMOS'), false);
});

test('persisted session from a different checkout is not exposed as current BEST', async (t) => {
  const harness = createHarness({ session: completeSession('OLD20'), sessionMatchesContext: () => false });
  const view = await harness.controller.initialize();
  t.equal(view.state, 'READY'); t.equal(view.bestCode, null); t.equal(view.canApplyBest, false);
});

test('persisted TESTING session restores active progress without a new command', async (t) => {
  const session = { status: 'TESTING', codes: ['A1', 'A2', 'A3'], current: 'A2', results: [{ code: 'A1', verificationStatus: 'INVALID' }] };
  const harness = createHarness({ session }); const view = await harness.controller.initialize();
  t.equal(view.state, 'TESTING'); t.equal(view.progress, 2); t.equal(view.currentCode, 'A2'); t.deep(harness.commands, []);
});

test('collapsing or reopening UI does not cancel an active persisted session', async (t) => {
  const session = { status: 'TESTING', codes: ['A1'], current: 'A1', results: [] };
  const harness = createHarness({ session }); await harness.controller.initialize(); await harness.controller.refresh();
  t.equal(harness.commands.some((row) => row.type === 'CH_CANCEL_PROMO_TEST'), false);
});

test('closing popup cannot dispatch cancellation; cancel remains a button-only action', (t) => {
  const source = fs.readFileSync(`${ROOT}/src/popup-promos.js`, 'utf8');
  t.ok(!/(?:beforeunload|unload|pagehide)[\s\S]{0,300}CH_CANCEL_PROMO_TEST/.test(source));
  t.equal((source.match(/CH_CANCEL_PROMO_TEST/g) || []).length, 1);
  t.match(source, /cancelPromos'\)\.addEventListener\('click'/);
});

for (const stopReason of ['CAPTCHA', 'RATE_LIMITED']) {
  test(`${stopReason} session renders the checkout safety-stop state`, async (t) => {
    const harness = createHarness({ session: { status: 'SAFETY_STOP', stopReason, codes: ['A1'], results: [] } });
    const view = await harness.controller.initialize(); t.equal(view.state, 'SAFETY_STOP');
    t.match(view.message, stopReason === 'CAPTCHA' ? /Пройдите её вручную.*запустите поиск снова/i : /остановлена/i); t.equal(view.canStart, true);
  });
}

test('contradictory promo state renders fail-closed safety stop', async (t) => {
  const harness = createHarness({ session: { status: 'SAFETY_STOP', stopReason: 'CONTRADICTORY_PROMO_STATE', codes: ['A1'], results: [] } });
  const view = await harness.controller.initialize(); t.equal(view.state, 'SAFETY_STOP'); t.match(view.message, /одновременно.*отклонение.*изменение заказа/i);
});

test('non-checkout AliExpress page does not show checkout widget', async (t) => {
  const harness = createHarness({ context: { checkoutSurfaceDetected: false, available: false } }); const view = await harness.controller.initialize();
  t.equal(view.state, 'IDLE'); t.equal(view.visible, false); t.equal(view.available, false); t.equal(view.canStart, false); t.deep(harness.commands, []);
});

test('ordinary CART without platform promo surface hides checkout widget and cannot start', async (t) => {
  const harness = createHarness({ context: { pageType: 'CART', checkoutSurfaceDetected: true, checkoutSurfaceCandidate: true, checkoutWidgetVisible: false, promoTestingSurface: false, available: false } });
  const view = await harness.controller.initialize(); await harness.controller.start();
  t.equal(view.visible, false); t.equal(view.available, false); t.equal(view.canStart, false); t.equal(view.foundCount, 0);
  t.equal(harness.refreshCalls, 0); t.equal(harness.commands.some((row) => row.type === 'CH_TEST_PROMOS'), false);
});

test('an already active matching promo session remains visible for safe recovery', async (t) => {
  const session = { status: 'TESTING', codes: ['A1'], current: 'A1', results: [] };
  const harness = createHarness({ context: { pageType: 'CHECKOUT', checkoutSurfaceDetected: true, checkoutWidgetVisible: false, available: false }, session });
  const view = await harness.controller.initialize();
  t.equal(view.visible, true); t.equal(view.canStart, false); t.equal(view.canStop, true);
});

test('WEAK checkout fingerprint never sends CH_TEST_PROMOS', async (t) => {
  const harness = createHarness({ context: { checkoutSurfaceDetected: true, available: false, fingerprintQuality: 'WEAK' } });
  await harness.controller.initialize(); await harness.controller.start();
  t.equal(harness.commands.some((row) => row.type === 'CH_TEST_PROMOS'), false);
});
