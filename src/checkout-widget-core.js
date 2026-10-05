(() => {
  'use strict';
  if (globalThis.CouponHunterCheckoutWidgetCore) return;

  const STATES = Object.freeze({
    IDLE: 'IDLE', READY: 'READY', TESTING: 'TESTING', FOUND_BEST: 'FOUND_BEST',
    COMPLETE_NO_SAVING: 'COMPLETE_NO_SAVING', STOPPED: 'STOPPED',
    SAFETY_STOP: 'SAFETY_STOP', ERROR: 'ERROR'
  });
  const ACTIVE_SESSION = new Set(['TESTING']);
  const SAFETY_SESSION = new Set(['SAFETY_STOP', 'BASELINE_LOST', 'CART_CHANGED', 'CHECKOUT_IDENTITY_UNCERTAIN', 'REMOVE_FAILED']);
  const STOPPED_SESSION = new Set(['CANCELLED', 'STOPPED', 'INCONCLUSIVE_RESPONSE_STREAK']);
  const SUCCESS_STATUS = 'VALID_APPLIED';
  const Country = globalThis.CouponHunterCountryProfile || {
    MODES: { AUTO: 'AUTO', MANUAL: 'MANUAL' },
    sanitizeSettings: (value = {}) => ({ promoCountryMode: value.promoCountryMode === 'MANUAL' ? 'MANUAL' : 'AUTO', promoCountry: value.promoCountry || null, includeUnknownCountryCodes: value.includeUnknownCountryCodes !== false }),
    resolveTarget: (settings, signal) => settings.promoCountryMode === 'MANUAL' && settings.promoCountry ? { code: settings.promoCountry, mode: 'MANUAL', source: 'USER_MANUAL' } : signal?.code ? { code: signal.code, mode: 'AUTO', source: 'AUTO' } : settings.promoCountry ? { code: settings.promoCountry, mode: 'AUTO', source: 'USER_FALLBACK' } : { code: null, mode: 'AUTO', source: 'UNRESOLVED' },
    displayName: (code) => code || 'Не определена', normalizeCountry: (code) => /^[A-Za-z]{2}$/.test(code || '') ? String(code).toUpperCase() : null
  };

  const finite = (value) => Number.isFinite(value) ? value : null;
  const modeName = (value) => value === 'DEEP' ? 'DEEP' : 'STANDARD';
  function modeLimit(mode, limits = {}) {
    const requested = modeName(mode) === 'DEEP' ? limits.DEEP_SCAN_LIVE_ATTEMPTS || 50 : limits.DEFAULT_LIVE_ATTEMPTS || 30;
    return Math.min(requested, limits.HARD_LIVE_ATTEMPT_LIMIT || 50);
  }

  function bestResult(session) {
    const rows = Array.isArray(session?.results) ? session.results : [];
    const selected = rows.find((row) => row.code === session?.bestCode && row.verified && row.verificationStatus === SUCCESS_STATUS && Number(row.saving) > 0 && row.baselineRestored === true);
    if (selected) return selected;
    return rows.filter((row) => row.verified && row.verificationStatus === SUCCESS_STATUS && Number(row.saving) > 0 && row.baselineRestored === true)
      .sort((a, b) => Number(b.saving) - Number(a.saving))[0] || null;
  }

  function stateFor(context, session, error = null) {
    if (error) return STATES.ERROR;
    if (!context?.checkoutSurfaceDetected || !context?.available) return STATES.IDLE;
    if (!session) return STATES.READY;
    const best = bestResult(session);
    if (ACTIVE_SESSION.has(session.status)) return best ? STATES.FOUND_BEST : STATES.TESTING;
    if (session.status === 'COMPLETE') return best ? STATES.FOUND_BEST : STATES.COMPLETE_NO_SAVING;
    if (STOPPED_SESSION.has(session.status)) return STATES.STOPPED;
    if (SAFETY_SESSION.has(session.status)) return STATES.SAFETY_STOP;
    if (['ERROR', 'UNAVAILABLE', 'BLOCKED'].includes(session.status)) return STATES.ERROR;
    return STATES.READY;
  }

  function resultTone(row) {
    if (row?.verified && row.verificationStatus === SUCCESS_STATUS && Number(row.saving) > 0 && row.baselineRestored === true) return 'success';
    if (row?.verificationStatus === SUCCESS_STATUS && row.baselineRestored !== true) return 'unknown';
    if (row?.verificationStatus === 'UNKNOWN_ERROR') return 'unknown';
    return 'rejected';
  }

  function resultLabel(row) {
    const labels = {
      INVALID: 'не подходит', EXPIRED: 'истёк', NOT_STARTED: 'ещё не начался', MINIMUM_SPEND_NOT_MET: 'не достигнут минимум',
      NOT_APPLICABLE_TO_ITEMS: 'не подходит к товарам', REGION_RESTRICTED: 'не подходит для региона', ACCOUNT_RESTRICTED: 'ограничение аккаунта',
      ALREADY_USED: 'уже использован', OUT_OF_STOCK: 'лимит исчерпан', NOT_COLLECTED: 'сначала нужно получить',
      RATE_LIMITED: 'слишком много попыток', CAPTCHA: 'нужна проверка безопасности', SITE_REJECTED: 'отклонён AliExpress',
      SKIPPED_CANNOT_BEAT_BEST: 'пропущен: не выгоднее лучшего'
    };
    if (row?.verified && row.verificationStatus === SUCCESS_STATUS && Number(row.saving) > 0 && row.baselineRestored === true) return `экономия ${row.saving}`;
    if (row?.verificationStatus === SUCCESS_STATUS) return 'проверяется возврат исходной суммы';
    if (row?.verificationStatus === 'UNKNOWN_ERROR') return safeResultText(row?.responseEvidence?.responseSnippet || row?.verificationMessage) || 'результат не определён';
    return labels[row?.verificationStatus] || safeResultText(row?.verificationMessage) || 'результат не определён';
  }

  function safeResultText(value) {
    const text = String(value || '').replace(/[\s\u00A0\u202F]+/g, ' ').trim().slice(0, 200);
    if (!text || /(?:recipient|получател|delivery\s*address|адрес\s*достав|phone|телефон|e-?mail|payment|оплат|bank\s*card|номер\s*карт|cvv|cvc)/i.test(text)) return null;
    return text;
  }

  function safeResponseEvidence(value = {}) {
    return {
      applyClicked: value.applyClicked === true,
      responseContainerFound: value.responseContainerFound === true,
      responseContainerStrategy: safeResultText(value.responseContainerStrategy)?.slice(0, 60) || null,
      promoMutationSeen: value.promoMutationSeen === true,
      inputInvalid: typeof value.inputInvalid === 'boolean' ? value.inputInvalid : null,
      inputValidationChanged: value.inputValidationChanged === true,
      applyButtonFound: value.applyButtonFound === true,
      appliedIndicatorFound: value.appliedIndicatorFound === true,
      appliedHintFound: value.appliedHintFound === true,
      appliedHintSuppressedByExplicitRejection: value.appliedHintSuppressedByExplicitRejection === true,
      totalBefore: finite(value.totalBefore), totalAfter: finite(value.totalAfter),
      totalChanged: value.totalChanged === true,
      responseTextFound: value.responseTextFound === true && !!safeResultText(value.responseSnippet),
      responseSource: safeResultText(value.responseSource)?.slice(0, 60) || null,
      responseSnippet: safeResultText(value.responseSnippet),
      classificationLatencyMs: Number.isFinite(Number(value.classificationLatencyMs)) ? Math.max(0, Math.round(Number(value.classificationLatencyMs))) : null,
      elapsedMs: Number.isFinite(Number(value.elapsedMs)) ? Math.max(0, Math.round(Number(value.elapsedMs))) : 0
    };
  }

  function safeResultsExport(session) {
    return {
      status: String(session?.status || 'UNKNOWN').slice(0, 80),
      stopReason: safeResultText(session?.stopReason),
      results: (Array.isArray(session?.results) ? session.results : []).filter((row) => !row?.skipped).map((row) => ({
        code: String(row?.code || '').slice(0, 64),
        verificationStatus: String(row?.verificationStatus || 'UNKNOWN_ERROR').slice(0, 80),
        verificationMessage: safeResultText(row?.verificationMessage),
        saving: finite(row?.saving),
        baselineRestored: row?.baselineRestored === true,
        responseEvidence: safeResponseEvidence(row?.responseEvidence)
      }))
    };
  }

  function safetyMessage(session) {
    const reason = String(session?.stopReason || '');
    if (/CAPTCHA/i.test(reason)) return 'AliExpress запросил проверку безопасности. Пройдите её вручную и запустите поиск снова.';
    if (/CONTRADICTORY_PROMO_STATE/i.test(reason)) return 'AliExpress одновременно показал отклонение промокода и изменение заказа. Проверка остановлена.';
    if (/RATE_LIMITED/i.test(reason)) return 'AliExpress ограничил частоту попыток. Очередь остановлена без автоматического повтора.';
    if (session?.status === 'REMOVE_FAILED') return 'Не удалось безопасно удалить проверенный код. Очередь остановлена.';
    if (session?.status === 'CART_CHANGED') return 'Состав корзины изменился. Проверка остановлена.';
    if (session?.status === 'BASELINE_LOST') return 'Исходная стоимость заказа не восстановилась. Проверка остановлена.';
    return reason || 'Проверка остановлена для защиты заказа.';
  }

  function createController(dependencies = {}) {
    const limits = dependencies.limits || {};
    const model = { mode: 'STANDARD', context: null, library: [], plan: null, session: null, error: null, feedStatus: null, startedHere: false, countrySettings: Country.sanitizeSettings(), countryTarget: { code: null, mode: 'AUTO', source: 'UNRESOLVED' } };
    const notify = () => dependencies.onChange?.(view());

    function sessionForCurrentContext() {
      if (!model.session) return null;
      if (model.startedHere || typeof dependencies.sessionMatchesContext !== 'function') return model.session;
      if (!dependencies.sessionMatchesContext(model.session, model.context)) return null;
      const sessionCountry = Country.normalizeCountry(model.session?.promoIntelligence?.countryCode);
      if (sessionCountry && sessionCountry !== model.countryTarget.code) return null;
      return model.session;
    }

    function rebuildPlan() {
      if (!model.context?.available || typeof dependencies.buildQueue !== 'function') { model.plan = null; return; }
      model.countryTarget = Country.resolveTarget(model.countrySettings, model.context.countrySignal || { code: model.context.countryCode, source: model.context.countrySource, strong: !!model.context.countryCode });
      const base = model.context.intelligence || model.context;
      const intelligenceContext = { ...base, country: model.countryTarget.code, region: model.countryTarget.code, regionConfidence: model.countryTarget.code ? 1 : 0, includeUnknownCountryCodes: model.countrySettings.includeUnknownCountryCodes };
      model.plan = dependencies.buildQueue(model.library, intelligenceContext, { mode: model.mode, includeUnknownCountryCodes: model.countrySettings.includeUnknownCountryCodes });
      if (model.plan?.diagnostics) Object.assign(model.plan.diagnostics, { countryCode: model.countryTarget.code, countryMode: model.countrySettings.promoCountryMode, countrySource: model.countryTarget.source, includeUnknownCountryCodes: model.countrySettings.includeUnknownCountryCodes });
    }

    function widgetVisible() {
      const session = sessionForCurrentContext();
      const surfaceVisible = model.context?.checkoutWidgetVisible !== undefined
        ? model.context.checkoutWidgetVisible
        : !!(model.context?.checkoutSurfaceCandidate ?? model.context?.checkoutSurfaceDetected);
      return !!surfaceVisible || ACTIVE_SESSION.has(session?.status);
    }

    function view() {
      const session = sessionForCurrentContext(); const best = bestResult(session); const state = stateFor(model.context, session, model.error);
      const results = Array.isArray(session?.results) ? session.results : []; const total = session?.codes?.length || model.plan?.queue?.length || 0;
      const progress = Math.min(total, results.length + (session?.current ? 1 : 0));
      const tested = results.filter((row) => !row?.skipped); const workingCount = tested.filter((row) => row.verified && row.verificationStatus === SUCCESS_STATUS && Number(row.saving) > 0 && row.baselineRestored === true).length;
      const unknownCount = tested.filter((row) => row.verificationStatus === 'UNKNOWN_ERROR').length;
      const rejectedCount = tested.filter((row) => row.verified === true && row.verificationStatus !== SUCCESS_STATUS).length;
      const history = tested.slice().reverse().map((row) => ({ code: row.code, tone: resultTone(row), label: resultLabel(row), saving: finite(Number(row.saving)), verificationStatus: row.verificationStatus, best: row === best || (!!best && row.code === best.code) }));
      const canCopyResults = !!session && !ACTIVE_SESSION.has(session.status) && tested.length > 0;
      const active = ACTIVE_SESSION.has(session?.status); const countryCounts = model.plan?.diagnostics?.countryMatchCounts || { match: 0, global: 0, unknown: 0, mismatch: 0 };
      return {
        state, mode: model.mode, visible: widgetVisible(), available: !!model.context?.available,
        foundCount: model.library.length, applicableCount: model.plan ? model.plan.diagnostics?.eligible ?? 0 : null,
        queueCount: total, progress, testedCount: tested.length, workingCount, rejectedCount, unknownCount, currentCode: session?.current || null,
        bestCode: best?.code || null, bestSaving: finite(Number(best?.saving)), currency: best?.priceAfter?.currency || best?.priceBefore?.currency || session?.currency || model.context?.currency || null,
        recentResults: history, resultHistory: history,
        countryCode: model.countryTarget.code, countryMode: model.countrySettings.promoCountryMode, countrySource: model.countryTarget.source,
        countryName: Country.displayName(model.countryTarget.code, 'ru'), includeUnknownCountryCodes: model.countrySettings.includeUnknownCountryCodes,
        countryMatchCounts: countryCounts, countrySelectionDisabled: active,
        sessionStatus: session?.status || null, completed: session?.status === 'COMPLETE', bestApplied: session?.bestApplied === true,
        message: state === STATES.SAFETY_STOP ? safetyMessage(session) : session?.stopReason || model.error || model.context?.reason || null,
        canStart: !!model.context?.available && !ACTIVE_SESSION.has(session?.status) && !!model.plan?.queue?.length,
        canStop: ACTIVE_SESSION.has(session?.status), canApplyBest: session?.status === 'COMPLETE' && !!best?.code && session?.bestApplied !== true,
        canCopyResults, resultsExport: canCopyResults ? safeResultsExport(session) : null,
        feedStatus: model.feedStatus, diagnostics: model.context?.diagnostics ? { ...model.context.diagnostics, countryCode: model.countryTarget.code, countryMode: model.countrySettings.promoCountryMode, countrySource: model.countryTarget.source, countryMatchCounts: countryCounts } : null
      };
    }

    async function refresh({ refreshFeed = false } = {}) {
      model.error = null;
      try {
        model.countrySettings = Country.sanitizeSettings(await dependencies.loadCountrySettings?.() || model.countrySettings);
        model.context = await dependencies.getContext();
        model.countryTarget = Country.resolveTarget(model.countrySettings, model.context?.countrySignal || { code: model.context?.countryCode, source: model.context?.countrySource, strong: !!model.context?.countryCode });
        model.session = await dependencies.loadSession?.() || null;
        const visible = widgetVisible();
        if (!visible) { model.library = []; model.plan = null; notify(); return view(); }
        if (refreshFeed && typeof dependencies.refreshFeed === 'function') {
          try { model.feedStatus = await dependencies.refreshFeed(false); } catch (error) { model.feedStatus = { ok: false, error: error?.message || String(error) }; }
        }
        model.library = await dependencies.loadLibrary();
        if (model.context?.available) rebuildPlan(); else model.plan = null;
        notify(); return view();
      } catch (error) { model.error = error?.message || String(error); notify(); return view(); }
    }

    async function initialize() { return refresh({ refreshFeed: true }); }

    function setMode(mode) {
      const session = sessionForCurrentContext(); if (ACTIVE_SESSION.has(session?.status)) return view();
      model.mode = modeName(mode); rebuildPlan(); notify(); return view();
    }

    async function setCountry(value) {
      const session = sessionForCurrentContext(); if (ACTIVE_SESSION.has(session?.status)) return view();
      const code = Country.normalizeCountry(value);
      model.countrySettings = Country.sanitizeSettings({ ...model.countrySettings, promoCountryMode: value === 'AUTO' ? Country.MODES.AUTO : code ? Country.MODES.MANUAL : model.countrySettings.promoCountryMode, promoCountry: value === 'AUTO' ? model.countrySettings.promoCountry : code || model.countrySettings.promoCountry });
      await dependencies.saveCountrySettings?.(model.countrySettings); model.countryTarget = Country.resolveTarget(model.countrySettings, model.context?.countrySignal || { code: model.context?.countryCode, source: model.context?.countrySource, strong: !!model.context?.countryCode });
      rebuildPlan(); notify(); return view();
    }

    async function setIncludeUnknownCountryCodes(value) {
      const session = sessionForCurrentContext(); if (ACTIVE_SESSION.has(session?.status)) return view();
      model.countrySettings = Country.sanitizeSettings({ ...model.countrySettings, includeUnknownCountryCodes: value !== false });
      await dependencies.saveCountrySettings?.(model.countrySettings); rebuildPlan(); notify(); return view();
    }

    async function start() {
      await refresh({ refreshFeed: false }); const current = view();
      if (!current.canStart) return current;
      const limit = modeLimit(model.mode, limits); const candidates = (model.plan?.queue || []).slice(0, limit);
      model.startedHere = true;
      model.session = { status: 'TESTING', codes: candidates.map((row) => row.code), results: [], current: null, bestCode: null, currency: model.context?.currency || null };
      notify();
      try {
        model.session = await dependencies.sendCommand({ type: 'CH_TEST_PROMOS', candidates, queueMeta: { mode: model.mode, ...(model.plan?.diagnostics || {}) } });
        model.startedHere = false;
        return view();
      } catch (error) { model.startedHere = false; model.error = error?.message || String(error); return view(); }
      finally { notify(); }
    }

    async function stop() { return dependencies.sendCommand({ type: 'CH_CANCEL_PROMO_TEST' }); }

    async function applyBest() {
      const current = view(); if (!current.canApplyBest) return { status: 'ERROR', message: 'Нет проверенного лучшего кода' };
      const response = await dependencies.sendCommand({ type: 'CH_APPLY_BEST_PROMO', code: current.bestCode });
      if (response?.status === 'APPLIED' && model.session) model.session = { ...model.session, bestApplied: true };
      notify(); return response;
    }

    function restoreSession(session) {
      model.session = session || null;
      if (session?.origin && session?.checkoutFingerprint) model.startedHere = false;
      notify(); return view();
    }

    return { initialize, refresh, setMode, setCountry, setIncludeUnknownCountryCodes, start, stop, applyBest, restoreSession, view };
  }

  globalThis.CouponHunterCheckoutWidgetCore = { STATES, modeLimit, bestResult, stateFor, resultTone, resultLabel, safeResponseEvidence, safeResultsExport, safetyMessage, createController };
})();
