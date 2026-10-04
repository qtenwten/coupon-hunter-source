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
  const STOPPED_SESSION = new Set(['CANCELLED', 'STOPPED']);
  const SUCCESS_STATUS = 'VALID_APPLIED';

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
      RATE_LIMITED: 'слишком много попыток', CAPTCHA: 'нужна проверка безопасности', UNKNOWN_ERROR: 'результат не определён',
      SKIPPED_CANNOT_BEAT_BEST: 'пропущен: не выгоднее лучшего'
    };
    if (row?.verified && row.verificationStatus === SUCCESS_STATUS && Number(row.saving) > 0 && row.baselineRestored === true) return `экономия ${row.saving}`;
    if (row?.verificationStatus === SUCCESS_STATUS) return 'проверяется возврат исходной суммы';
    return labels[row?.verificationStatus] || row?.verificationMessage || 'результат не определён';
  }

  function safetyMessage(session) {
    const reason = String(session?.stopReason || '');
    if (/CAPTCHA/i.test(reason)) return 'AliExpress запросил проверку безопасности. Очередь остановлена без повторных попыток.';
    if (/RATE_LIMITED/i.test(reason)) return 'AliExpress ограничил частоту попыток. Очередь остановлена без автоматического повтора.';
    if (session?.status === 'REMOVE_FAILED') return 'Не удалось безопасно удалить проверенный код. Очередь остановлена.';
    if (session?.status === 'CART_CHANGED') return 'Состав корзины изменился. Проверка остановлена.';
    if (session?.status === 'BASELINE_LOST') return 'Исходная стоимость заказа не восстановилась. Проверка остановлена.';
    return reason || 'Проверка остановлена для защиты заказа.';
  }

  function createController(dependencies = {}) {
    const limits = dependencies.limits || {};
    const model = { mode: 'STANDARD', context: null, library: [], plan: null, session: null, error: null, feedStatus: null, startedHere: false };
    const notify = () => dependencies.onChange?.(view());

    function sessionForCurrentContext() {
      if (!model.session) return null;
      if (model.startedHere || typeof dependencies.sessionMatchesContext !== 'function') return model.session;
      return dependencies.sessionMatchesContext(model.session, model.context) ? model.session : null;
    }

    function rebuildPlan() {
      if (!model.context?.available || typeof dependencies.buildQueue !== 'function') { model.plan = null; return; }
      model.plan = dependencies.buildQueue(model.library, model.context.intelligence || model.context, { mode: model.mode });
    }

    function view() {
      const session = sessionForCurrentContext(); const best = bestResult(session); const state = stateFor(model.context, session, model.error);
      const results = Array.isArray(session?.results) ? session.results : []; const total = session?.codes?.length || model.plan?.queue?.length || 0;
      const progress = Math.min(total, results.length + (session?.current ? 1 : 0));
      const recent = results.slice(-4); if (best && !recent.includes(best)) recent.unshift(best);
      return {
        state, mode: model.mode, visible: !!(model.context?.checkoutSurfaceCandidate ?? model.context?.checkoutSurfaceDetected), available: !!model.context?.available,
        foundCount: model.library.length, applicableCount: model.plan ? model.plan.diagnostics?.eligible ?? 0 : null,
        queueCount: total, progress, currentCode: session?.current || null,
        bestCode: best?.code || null, bestSaving: finite(Number(best?.saving)), currency: best?.priceAfter?.currency || best?.priceBefore?.currency || session?.currency || model.context?.currency || null,
        recentResults: recent.slice(-5).map((row) => ({ code: row.code, tone: resultTone(row), label: resultLabel(row), saving: finite(Number(row.saving)), verificationStatus: row.verificationStatus })),
        sessionStatus: session?.status || null, completed: session?.status === 'COMPLETE', bestApplied: session?.bestApplied === true,
        message: state === STATES.SAFETY_STOP ? safetyMessage(session) : session?.stopReason || model.error || model.context?.reason || null,
        canStart: !!model.context?.available && !ACTIVE_SESSION.has(session?.status) && !!model.plan?.queue?.length,
        canStop: ACTIVE_SESSION.has(session?.status), canApplyBest: session?.status === 'COMPLETE' && !!best?.code && session?.bestApplied !== true,
        feedStatus: model.feedStatus, diagnostics: model.context?.diagnostics || null
      };
    }

    async function refresh({ refreshFeed = false } = {}) {
      model.error = null;
      try {
        model.context = await dependencies.getContext();
        model.session = await dependencies.loadSession?.() || null;
        const visible = !!(model.context?.checkoutSurfaceCandidate ?? model.context?.checkoutSurfaceDetected);
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

    return { initialize, refresh, setMode, start, stop, applyBest, restoreSession, view };
  }

  globalThis.CouponHunterCheckoutWidgetCore = { STATES, modeLimit, bestResult, stateFor, resultTone, resultLabel, safetyMessage, createController };
})();
