(() => {
  'use strict';
  if (globalThis.CouponHunterVerifierEngine) return;

  const C = globalThis.CouponHunterCheckoutCore;
  const Limits = globalThis.CouponHunterPromoConstants || { HARD_LIVE_ATTEMPT_LIMIT: 50 };
  const SESSION_STATUS = Object.freeze({
    TESTING: 'TESTING', COMPLETE: 'COMPLETE', CANCELLED: 'CANCELLED', UNAVAILABLE: 'UNAVAILABLE',
    BLOCKED: 'BLOCKED', SAFETY_STOP: 'SAFETY_STOP', BASELINE_LOST: 'BASELINE_LOST',
    CART_CHANGED: 'CART_CHANGED', CHECKOUT_IDENTITY_UNCERTAIN: 'CHECKOUT_IDENTITY_UNCERTAIN',
    REMOVE_FAILED: 'REMOVE_FAILED', ERROR: 'ERROR'
  });

  function createVerifier(adapter, options = {}) {
    const maxCodes = Math.min(options.maxCodes || 25, Limits.HARD_LIVE_ATTEMPT_LIMIT);
    const verificationTimeoutMs = options.verificationTimeoutMs || 10_000;
    const restorationTimeoutMs = options.restorationTimeoutMs || 9_000;
    const pollMs = options.pollMs || 350;
    const quietWindowMs = options.quietWindowMs || 1_000;
    const attemptDelayMs = options.attemptDelayMs ?? 900;
    const now = () => adapter.now?.() ?? Date.now();
    const iso = () => new Date(now()).toISOString();
    const persist = async (session) => { session.updatedAt = iso(); await adapter.persist?.(session); };

    function transition(result, state, message = null) {
      result.state = state;
      result.transitions.push({ state, at: iso(), message });
    }

    function fingerprintIsReliable(fingerprint) {
      if (!fingerprint || fingerprint.quality === 'WEAK') return false;
      if (fingerprint.quality === 'STRONG') return true;
      return fingerprint.quality === 'MEDIUM' && Array.isArray(fingerprint.items) && fingerprint.items.length > 0 &&
        fingerprint.items.every((item) => !!(item?.itemId || item?.skuId));
    }

    function cartMatches(baselineCheckout, currentCheckout) {
      const baseline = baselineCheckout?.fingerprint; const current = currentCheckout?.fingerprint;
      return fingerprintIsReliable(baseline) && fingerprintIsReliable(current) && C.sameCheckoutFingerprint(baseline, current);
    }

    function baselineMatches(baselineCheckout, currentCheckout) {
      return cartMatches(baselineCheckout, currentCheckout) && C.financialBaselineMatches(financialOf(baselineCheckout), financialOf(currentCheckout));
    }

    const financialOf = (checkout) => checkout?.financial || C.buildFinancialSnapshot(checkout?.breakdown || checkout);

    async function waitForStableCheckout(timeoutMs = 9_000, requiredQuietMs = quietWindowMs) {
      const started = now(); let lastSignature = null; let lastChangedAt = now(); let last = null;
      while (now() - started < timeoutMs) {
        const current = await adapter.readCheckout(); const financial = financialOf(current);
        const signature = C.financialSignature(financial);
        if (signature !== lastSignature) { lastSignature = signature; lastChangedAt = now(); }
        last = current;
        if (Number.isFinite(financial.total) && now() - lastChangedAt >= requiredQuietMs) return current;
        const remaining = Math.max(1, Math.min(pollMs, timeoutMs - (now() - started), requiredQuietMs - (now() - lastChangedAt)));
        await adapter.waitForSignal(remaining);
      }
      return last || await adapter.readCheckout();
    }

    async function waitForBaseline(baselineCheckout, timeoutMs = restorationTimeoutMs) {
      const started = now(); let lastSignature = null; let baselineSince = null; let checkout = null;
      while (now() - started < timeoutMs) {
        checkout = await adapter.readCheckout();
        if (!cartMatches(baselineCheckout, checkout)) return { restored: false, status: SESSION_STATUS.CART_CHANGED, reason: 'Структура корзины изменилась', checkout };
        const signature = C.financialSignature(financialOf(checkout));
        if (signature !== lastSignature) { lastSignature = signature; baselineSince = null; }
        if (C.financialBaselineMatches(financialOf(baselineCheckout), financialOf(checkout))) {
          if (baselineSince === null) baselineSince = now();
          if (now() - baselineSince >= quietWindowMs) return { restored: true, status: null, reason: null, checkout };
        } else baselineSince = null;
        await adapter.waitForSignal(Math.max(1, Math.min(pollMs, timeoutMs - (now() - started))));
      }
      return { restored: false, status: SESSION_STATUS.BASELINE_LOST, reason: 'Итоговая сумма не вернулась к baseline', checkout };
    }

    function evidenceSignature(evidence) {
      if (!evidence?.applied) return null;
      return JSON.stringify([evidence.evidenceType || null, evidence.confidence || 0, evidence.snippet?.text || null, evidence.snippet?.ariaLabel || null, evidence.snippet?.class || null]);
    }

    async function waitForTerminal(code, baselineCheckout, beforeObservation = {}) {
      const started = now(); let lastObservation = null; let appliedEvidence = { applied: false, confidence: 0, evidenceType: null, snippet: null };
      const beforeEvidenceSignature = evidenceSignature(beforeObservation.appliedEvidence);
      while (now() - started < verificationTimeoutMs) {
        const observation = await adapter.observe(code); lastObservation = observation;
        if (!cartMatches(baselineCheckout, observation.checkout)) return { type: 'CART_CHANGED', observation };
        if ([C.STATUS.CAPTCHA, C.STATUS.RATE_LIMITED].includes(observation.safetyStatus)) return { type: 'SAFETY_STOP', status: observation.safetyStatus, observation };
        const feedback = observation.feedbackText === beforeObservation.feedbackText ? '' : observation.feedbackText || '';
        if (observation.appliedEvidence?.applied && evidenceSignature(observation.appliedEvidence) !== beforeEvidenceSignature) appliedEvidence = observation.appliedEvidence;
        const saving = C.computeSaving(financialOf(baselineCheckout), financialOf(observation.checkout));
        if (appliedEvidence.applied && Number.isFinite(saving) && saving > 0) {
          const stableCheckout = await waitForStableCheckout(5000);
          if (!cartMatches(baselineCheckout, stableCheckout)) return { type: 'CART_CHANGED', observation: { ...observation, checkout: stableCheckout } };
          const stableSaving = C.computeSaving(financialOf(baselineCheckout), financialOf(stableCheckout));
          if (Number.isFinite(stableSaving) && stableSaving > 0) return { type: 'VALID', observation: { ...observation, checkout: stableCheckout, appliedEvidence }, saving: stableSaving };
        }
        const textual = C.textOutcome(feedback);
        if (textual && ![C.STATUS.CAPTCHA, C.STATUS.RATE_LIMITED].includes(textual)) return { type: 'REJECTED', status: textual, observation: { ...observation, feedbackText: feedback } };
        await adapter.waitForSignal(pollMs);
      }
      const observation = lastObservation || await adapter.observe(code);
      return { type: 'TIMEOUT', observation: { ...observation, appliedEvidence }, appliedEvidence };
    }

    async function applyCandidate(candidate, baselineCheckout) {
      const result = adapter.normalizeCandidate ? adapter.normalizeCandidate(candidate) : { ...candidate };
      result.transitions = [];
      transition(result, C.STATES.IDLE);
      transition(result, C.STATES.ENTERING);
      const entered = await adapter.enterCode(result.code);
      if (!entered?.ok) {
        transition(result, C.STATES.UNKNOWN, entered?.message || 'Поле промокода недоступно');
        return { ...result, verified: false, verificationStatus: C.STATUS.UNKNOWN_ERROR, verificationMessage: entered?.message || 'Поле промокода недоступно', priceBefore: financialOf(baselineCheckout), priceAfter: financialOf(baselineCheckout), saving: 0 };
      }
      const before = await adapter.observe(result.code);
      transition(result, C.STATES.APPLYING);
      const applied = await adapter.clickApply(result.code);
      if (!applied?.ok) {
        transition(result, C.STATES.UNKNOWN, applied?.message || 'Кнопка применения не найдена');
        return { ...result, verified: false, verificationStatus: C.STATUS.UNKNOWN_ERROR, verificationMessage: applied?.message || 'Кнопка применения не найдена', priceBefore: financialOf(baselineCheckout), priceAfter: financialOf(baselineCheckout), saving: 0 };
      }
      transition(result, C.STATES.WAITING_RESPONSE);
      const terminal = await waitForTerminal(result.code, baselineCheckout, before);
      const observation = terminal.observation || {};
      let status = C.STATUS.UNKNOWN_ERROR; let verified = false; let reason = 'NO_CONCLUSIVE_SIGNAL';
      if (terminal.type === 'VALID') { status = C.STATUS.VALID_APPLIED; verified = true; reason = 'APPLIED_AND_TOTAL_DECREASED'; }
      else if (terminal.type === 'REJECTED') { status = terminal.status || C.STATUS.UNKNOWN_ERROR; verified = status !== C.STATUS.UNKNOWN_ERROR; reason = 'SITE_RESPONSE'; }
      else if (terminal.type === 'SAFETY_STOP') { status = terminal.status; reason = 'SAFETY_STOP'; }
      else if (terminal.type === 'CART_CHANGED') reason = 'CART_CHANGED';
      transition(result, status === C.STATUS.VALID_APPLIED ? C.STATES.APPLIED : status === C.STATUS.UNKNOWN_ERROR ? C.STATES.UNKNOWN : C.STATES.REJECTED, reason);
      return {
        ...result, verified, verificationStatus: status,
        verificationMessage: (observation.feedbackText || reason).slice(0, 700),
        priceBefore: financialOf(baselineCheckout), priceAfter: financialOf(observation.checkout || baselineCheckout),
        saving: terminal.type === 'VALID' ? terminal.saving : C.computeSaving(financialOf(baselineCheckout), financialOf(observation.checkout)),
        lastVerifiedAt: iso(), appliedEvidence: observation.appliedEvidence?.applied ? observation.appliedEvidence : null,
        checkoutChanged: terminal.type === 'CART_CHANGED'
      };
    }

    async function restoreBaseline(code, baselineCheckout, result) {
      transition(result, C.STATES.REMOVING);
      const removed = await adapter.removeCode(code);
      if (!removed?.ok) return { restored: false, status: SESSION_STATUS.REMOVE_FAILED, reason: removed?.message || 'Безопасная кнопка удаления не найдена', checkout: await adapter.readCheckout() };
      transition(result, C.STATES.RESTORING_BASELINE);
      const restoration = await waitForBaseline(baselineCheckout);
      if (restoration.status === SESSION_STATUS.CART_CHANGED) restoration.reason = 'Структура корзины изменилась после удаления кода';
      return restoration;
    }

    async function run(rawCandidates) {
      const candidates = (adapter.normalizeCandidates ? adapter.normalizeCandidates(rawCandidates) : rawCandidates || []).slice(0, maxCodes);
      const binding = adapter.getBinding();
      const session = {
        version: 4, status: SESSION_STATUS.TESTING, origin: binding.origin, pageClass: binding.pageClass, pathClass: binding.pathClass || null,
        codes: candidates.map((row) => row.code), current: null, baseline: null, checkoutFingerprint: null,
        currency: null, results: [], bestCode: null, createdAt: iso(), startedAt: iso(), stopReason: null
      };
      await persist(session);
      if (!['CART', 'CHECKOUT'].includes(binding.pageClass)) { session.status = SESSION_STATUS.UNAVAILABLE; session.stopReason = 'Откройте корзину или checkout AliExpress'; await persist(session); return session; }
      if (!candidates.length) { session.status = SESSION_STATUS.ERROR; session.stopReason = 'Нет корректных промокодов'; await persist(session); return session; }
      const baselineCheckout = await waitForStableCheckout();
      session.baseline = financialOf(baselineCheckout); session.checkoutFingerprint = baselineCheckout.fingerprint; session.currency = session.baseline.currency || baselineCheckout.fingerprint?.currency || null;
      if (!fingerprintIsReliable(session.checkoutFingerprint)) {
        session.status = SESSION_STATUS.CHECKOUT_IDENTITY_UNCERTAIN;
        session.stopReason = 'Не удалось надёжно определить состав корзины. Автоматическая проверка остановлена, чтобы не сравнивать промокоды на разных состояниях заказа.';
        await persist(session); return session;
      }
      if (!Number.isFinite(session.baseline?.total)) { session.status = SESSION_STATUS.UNAVAILABLE; session.stopReason = 'Не удалось надёжно определить итоговую сумму заказа'; await persist(session); return session; }
      const ready = await adapter.ensureReady();
      if (!ready?.ok) { session.status = SESSION_STATUS.UNAVAILABLE; session.stopReason = ready?.message || 'Поле промокода не найдено'; await persist(session); return session; }
      const existing = await adapter.existingCode();
      if (existing) { session.status = SESSION_STATUS.BLOCKED; session.stopReason = `Уже применён код ${existing}. Удалите его вручную перед изолированной проверкой.`; await persist(session); return session; }
      await persist(session);

      for (const candidate of candidates) {
        if (adapter.isCancelled?.()) { session.status = SESSION_STATUS.CANCELLED; session.stopReason = 'Остановлено пользователем'; break; }
        const safety = await adapter.safetyStatus();
        if (safety) { session.status = SESSION_STATUS.SAFETY_STOP; session.stopReason = safety; break; }
        const current = await waitForStableCheckout(6000);
        if (!cartMatches(baselineCheckout, current)) { session.status = SESSION_STATUS.CART_CHANGED; session.stopReason = 'Структура корзины изменилась; очередь остановлена'; break; }
        if (!C.financialBaselineMatches(financialOf(baselineCheckout), financialOf(current))) { session.status = SESSION_STATUS.BASELINE_LOST; session.stopReason = 'Финансовое состояние заказа отличается от baseline'; break; }
        const bestSaving = Math.max(0, ...session.results.filter(C.isBestEligible).map((row) => row.saving));
        if (Number.isFinite(candidate.theoreticalMaxSaving) && bestSaving > 0 && candidate.theoreticalMaxSaving <= bestSaving) {
          session.results.push({ ...candidate, verified: false, verificationStatus: 'SKIPPED_CANNOT_BEAT_BEST', verificationMessage: `Теоретический максимум ${candidate.theoreticalMaxSaving} не превышает уже подтверждённую экономию ${bestSaving}`, saving: null, skipped: true, lastVerifiedAt: iso() });
          await persist(session); continue;
        }
        session.current = candidate.code; await persist(session);
        const result = await applyCandidate(candidate, baselineCheckout); session.results.push(result); await persist(session);
        if (result.checkoutChanged) { session.status = SESSION_STATUS.CART_CHANGED; session.stopReason = 'Структура корзины изменилась во время проверки'; break; }
        if ([C.STATUS.CAPTCHA, C.STATUS.RATE_LIMITED].includes(result.verificationStatus)) { session.status = SESSION_STATUS.SAFETY_STOP; session.stopReason = result.verificationStatus; break; }
        if (C.requiresRemovalBeforeNext(result)) {
          const restoration = await restoreBaseline(result.code, baselineCheckout, result); result.baselineRestored = restoration.restored;
          if (!restoration.restored) { session.status = restoration.status; session.stopReason = restoration.reason; await persist(session); break; }
        } else {
          await adapter.clearCode();
          const cleared = await waitForBaseline(baselineCheckout, Math.min(6_000, restorationTimeoutMs));
          if (!cleared.restored) { session.status = cleared.status; session.stopReason = cleared.status === SESSION_STATUS.CART_CHANGED ? 'Структура корзины изменилась после проверки' : 'Итоговая сумма изменилась после отклонённого кода'; break; }
        }
        await persist(session); await adapter.delay(attemptDelayMs);
      }
      const best = C.sortVerificationResults(session.results).find(C.isBestEligible);
      session.bestCode = best?.code || null; session.current = null;
      if (session.status === SESSION_STATUS.TESTING) session.status = SESSION_STATUS.COMPLETE;
      session.completedAt = iso(); await persist(session); return session;
    }

    async function applyBest(code, session) {
      const source = session?.results?.find((row) => row.code === code && C.isBestEligible(row));
      if (!source) return { status: 'ERROR', message: 'Нет проверенного рабочего результата для этого кода' };
      const binding = adapter.getBinding();
      if (binding.origin !== session.origin || binding.pageClass !== session.pageClass || (session.pathClass && binding.pathClass !== session.pathClass)) return { status: SESSION_STATUS.CART_CHANGED, message: 'Открыта другая корзина или checkout' };
      const checkout = await waitForStableCheckout();
      if (!fingerprintIsReliable(session.checkoutFingerprint) || !fingerprintIsReliable(checkout.fingerprint)) return { status: SESSION_STATUS.CHECKOUT_IDENTITY_UNCERTAIN, message: 'Не удалось надёжно подтвердить состав текущей корзины' };
      if (!C.sameCheckoutFingerprint(session.checkoutFingerprint, checkout.fingerprint) || financialOf(checkout).currency !== session.currency) return { status: SESSION_STATUS.CART_CHANGED, message: 'Структура текущей корзины отличается от проверенной' };
      if (!C.financialBaselineMatches(session.baseline, financialOf(checkout))) return { status: SESSION_STATUS.BASELINE_LOST, message: 'Финансовое состояние заказа изменилось после проверки' };
      const result = await applyCandidate(source, checkout);
      if (!(result.verified && result.verificationStatus === C.STATUS.VALID_APPLIED && result.saving > 0)) {
        if (C.requiresRemovalBeforeNext(result)) await restoreBaseline(result.code, checkout, result);
        else await adapter.clearCode();
        return { status: 'ERROR', message: 'Повторное применение не подтвердило экономию', result };
      }
      return { status: 'APPLIED', result };
    }

    return { run, applyBest, waitForStableCheckout, waitForTerminal, applyCandidate, restoreBaseline, fingerprintIsReliable, cartMatches, baselineMatches };
  }

  globalThis.CouponHunterVerifierEngine = { SESSION_STATUS, createVerifier };
})();
