const { test } = require('./harness');
const { sandbox, load } = require('./helpers');

const box = load(sandbox(), 'src/checkout-core.js', 'src/verifier-engine.js');
const C = box.CouponHunterCheckoutCore;
const V = box.CouponHunterVerifierEngine;

class FakeCheckoutEnvironment {
  constructor(behaviors = {}, options = {}) {
    this.time = 1_700_000_000_000; this.behaviors = behaviors; this.options = options;
    this.baselineFinancial = { subtotal: 9990, shipping: 0, tax: 0, discount: 0, total: 9990, currency: 'RUB', ...(options.financial || {}) };
    this.financial = { ...this.baselineFinancial }; this.feedback = ''; this.safety = null;
    this.applied = false; this.currentCode = null; this.events = []; this.actions = []; this.sessions = [];
    this.items = options.items || [{ itemId: 'ITEM-A', skuId: 'SKU-A', quantity: 1, sellerId: 'STORE-A' }];
    this.shippingMethodId = options.shippingMethodId || 'STANDARD';
    this.origin = options.origin || 'https://aliexpress.ru'; this.pageClass = options.pageClass || 'CHECKOUT'; this.pathClass = options.pathClass || '/p/trade/confirm.html';
  }
  get total() { return this.financial.total; }
  set total(value) { this.financial.total = value; }
  get baselineTotal() { return this.baselineFinancial.total; }
  checkout() {
    const financial = C.buildFinancialSnapshot(this.financial); const breakdown = { ...financial };
    return { breakdown, financial, fingerprint: C.buildCheckoutFingerprint({ currency: financial.currency, items: this.items, shippingMethodId: this.shippingMethodId }) };
  }
  applyDue() {
    const due = this.events.filter((event) => event.at <= this.time); this.events = this.events.filter((event) => event.at > this.time);
    for (const event of due) {
      for (const key of ['subtotal', 'shipping', 'tax', 'discount', 'total', 'currency']) if (key in event) this.financial[key] = event[key];
      if (event.financial) Object.assign(this.financial, event.financial);
      if ('feedback' in event) this.feedback = event.feedback;
      if ('applied' in event) this.applied = event.applied;
      if ('safety' in event) this.safety = event.safety;
      if (event.items) this.items = event.items;
      this.actions.push(`event:${event.name || event.at}`);
    }
  }
  adapter() {
    return {
      now: () => this.time,
      getBinding: () => ({ origin: this.origin, pageClass: this.pageClass, pathClass: this.pathClass }),
      normalizeCandidates: (rows) => rows.map((row) => typeof row === 'string' ? { code: row, source: 'TEST' } : row),
      normalizeCandidate: (row) => ({ ...row, verified: false }),
      ensureReady: async () => ({ ok: true }), existingCode: async () => null,
      readCheckout: async () => { this.applyDue(); return this.checkout(); },
      readStableCheckout: async () => { this.applyDue(); return this.checkout(); },
      enterCode: async (code) => { this.currentCode = code; this.feedback = ''; this.applied = !!this.behaviors[code]?.staleApplied; this.actions.push(`enter:${code}`); return { ok: true }; },
      clickApply: async (code) => {
        this.actions.push(`apply:${code}`); const behavior = this.behaviors[code] || {};
        for (const event of behavior.events || []) this.events.push({ ...event, at: this.time + (event.delay || 0) });
        return behavior.applyFailure ? { ok: false, message: 'Apply missing' } : { ok: true };
      },
      observe: async (code) => {
        this.applyDue();
        return {
          checkout: this.checkout(), feedbackText: this.feedback, safetyStatus: this.safety,
          appliedEvidence: this.applied ? { applied: true, confidence: 85, evidenceType: 'PROMO_SUCCESS_TEXT', snippet: { text: 'Promo code applied' } } : { applied: false, confidence: 0, evidenceType: null, snippet: null },
          code
        };
      },
      waitForSignal: async (ms) => {
        const next = this.events.map((event) => event.at).filter((at) => at > this.time && at <= this.time + ms).sort((a, b) => a - b)[0];
        this.time = next || this.time + ms; this.applyDue();
      },
      removeCode: async (code) => {
        this.actions.push(`remove:${code}`); const behavior = this.behaviors[code] || {};
        if (behavior.removeFailure) return { ok: false, message: 'Remove unavailable' };
        if (behavior.afterRemoveFinancial) { this.financial = { ...this.financial, ...behavior.afterRemoveFinancial }; this.applied = false; this.feedback = ''; this.actions.push(`restored:${code}`); }
        else if (!behavior.noRestore) { this.financial = { ...this.baselineFinancial }; this.applied = false; this.feedback = ''; this.actions.push(`restored:${code}`); }
        if (behavior.itemsAfterRemove) this.items = behavior.itemsAfterRemove;
        return { ok: true };
      },
      clearCode: async () => {
        this.actions.push(`clear:${this.currentCode}`); this.feedback = ''; this.applied = false;
        const behavior = this.behaviors[this.currentCode] || {};
        for (const event of behavior.clearEvents || []) this.events.push({ ...event, at: this.time + (event.delay || 0) });
      },
      safetyStatus: async () => this.safety, isCancelled: () => false,
      delay: async (ms) => { this.time += ms; this.applyDue(); },
      persist: async (session) => { this.sessions.push(JSON.parse(JSON.stringify(session))); }
    };
  }
}

function verifierFor(environment, options = {}) {
  return V.createVerifier(environment.adapter(), { pollMs: 250, verificationTimeoutMs: 4000, restorationTimeoutMs: 2000, attemptDelayMs: 10, ...options });
}

test('PromoTester CASE A: valid code is measured, removed and baseline restored before CODE2', async (t) => {
  const env = new FakeCheckoutEnvironment({
    CODE1: { events: [{ delay: 0, applied: true, name: 'applied' }, { delay: 250, total: 8790, name: 'total-changed' }] },
    CODE2: { events: [{ delay: 0, feedback: 'Minimum spend is not met', name: 'rejected' }] }
  });
  const session = await verifierFor(env).run([{ code: 'CODE1' }, { code: 'CODE2' }]);
  t.equal(session.status, 'COMPLETE'); t.equal(session.results[0].verificationStatus, C.STATUS.VALID_APPLIED);
  t.equal(session.origin, 'https://aliexpress.ru'); t.equal(session.pageClass, 'CHECKOUT'); t.equal(session.pathClass, '/p/trade/confirm.html');
  t.equal(session.currency, 'RUB'); t.equal(session.baseline.total, 9990); t.ok(!!session.checkoutFingerprint.signature); t.ok(!!session.createdAt);
  t.equal(session.results[0].saving, 1200); t.equal(session.results[0].baselineRestored, true);
  t.deep(session.results[0].transitions.map((row) => row.state), ['IDLE','ENTERING','APPLYING','WAITING_RESPONSE','APPLIED','REMOVING','RESTORING_BASELINE']);
  t.ok(env.actions.indexOf('restored:CODE1') < env.actions.indexOf('enter:CODE2'));
  t.equal(session.results[1].verificationStatus, C.STATUS.MINIMUM_SPEND_NOT_MET);
});

test('PromoTester CASE B: rejected promo keeps baseline and queue continues', async (t) => {
  const env = new FakeCheckoutEnvironment({
    CODE1: { events: [{ delay: 0, feedback: 'Минимальная сумма заказа не достигнута' }] },
    CODE2: { events: [{ delay: 0, feedback: 'This code is invalid' }] }
  });
  const session = await verifierFor(env).run([{ code: 'CODE1' }, { code: 'CODE2' }]);
  t.equal(session.status, 'COMPLETE'); t.equal(session.results[0].verificationStatus, C.STATUS.MINIMUM_SPEND_NOT_MET);
  t.equal(session.results[0].priceAfter.total, 9990); t.ok(env.actions.includes('enter:CODE2'));
  t.ok(!env.actions.includes('remove:CODE1'));
});

test('PromoTester CASE C: early Applied waits for delayed total recalculation', async (t) => {
  const env = new FakeCheckoutEnvironment({ CODE1: { events: [{ delay: 0, applied: true }, { delay: 1500, total: 8790, name: 'delayed-total' }] } });
  const session = await verifierFor(env, { verificationTimeoutMs: 3500 }).run([{ code: 'CODE1' }]);
  t.equal(session.results[0].verificationStatus, C.STATUS.VALID_APPLIED); t.equal(session.results[0].saving, 1200);
  t.ok(env.actions.includes('event:delayed-total')); t.ok(env.time >= 1_700_000_001_500);
});

test('pre-existing generic Applied evidence cannot validate a new code', async (t) => {
  const env = new FakeCheckoutEnvironment({ CODE1: { staleApplied: true, events: [{ delay: 250, total: 8790, name: 'unrelated-total-change' }] } });
  const session = await verifierFor(env, { verificationTimeoutMs: 1000 }).run([{ code: 'CODE1' }]);
  t.ok(session.results[0].verificationStatus !== C.STATUS.VALID_APPLIED); t.equal(session.results[0].verified, false);
});

test('PromoTester CASE D: missing safe Remove stops queue before CODE2', async (t) => {
  const env = new FakeCheckoutEnvironment({
    CODE1: { events: [{ delay: 0, applied: true, total: 8790 }], removeFailure: true },
    CODE2: { events: [{ delay: 0, feedback: 'invalid' }] }
  });
  const session = await verifierFor(env).run([{ code: 'CODE1' }, { code: 'CODE2' }]);
  t.equal(session.status, 'REMOVE_FAILED'); t.ok(!env.actions.includes('enter:CODE2'));
  t.match(session.stopReason, /Remove unavailable/);
});

test('PromoTester CASE E: total not restored after Remove stops BASELINE_LOST', async (t) => {
  const env = new FakeCheckoutEnvironment({
    CODE1: { events: [{ delay: 0, applied: true, total: 8790 }], noRestore: true },
    CODE2: { events: [{ delay: 0, feedback: 'invalid' }] }
  });
  const session = await verifierFor(env).run([{ code: 'CODE1' }, { code: 'CODE2' }]);
  t.equal(session.status, 'BASELINE_LOST'); t.ok(!env.actions.includes('enter:CODE2'));
});

test('PromoTester CASE F: CAPTCHA during wait immediately stops queue', async (t) => {
  const env = new FakeCheckoutEnvironment({
    CODE1: { events: [{ delay: 500, safety: C.STATUS.CAPTCHA, feedback: 'Security verification CAPTCHA', name: 'captcha' }] },
    CODE2: { events: [{ delay: 0, feedback: 'invalid' }] }
  });
  const session = await verifierFor(env).run([{ code: 'CODE1' }, { code: 'CODE2' }]);
  t.equal(session.status, 'SAFETY_STOP'); t.equal(session.results[0].verificationStatus, C.STATUS.CAPTCHA);
  t.ok(!env.actions.includes('enter:CODE2')); t.ok(env.time < 1_700_000_004_000);
});

test('RATE_LIMITED during verification stops the entire queue', async (t) => {
  const env = new FakeCheckoutEnvironment({
    CODE1: { events: [{ delay: 250, safety: C.STATUS.RATE_LIMITED, feedback: 'Too many attempts, try again later' }] },
    CODE2: { events: [{ delay: 0, feedback: 'invalid' }] }
  });
  const session = await verifierFor(env).run([{ code: 'CODE1' }, { code: 'CODE2' }]);
  t.equal(session.status, 'SAFETY_STOP'); t.equal(session.results[0].verificationStatus, C.STATUS.RATE_LIMITED);
  t.ok(!env.actions.includes('enter:CODE2'));
});

test('PromoTester CASE G: checkout fingerprint change stops even with same total', async (t) => {
  const differentItems = [{ itemId: 'ITEM-B', skuId: 'SKU-B', quantity: 1, sellerId: 'STORE-B' }];
  const env = new FakeCheckoutEnvironment({
    CODE1: { events: [{ delay: 500, items: differentItems, name: 'cart-changed' }] },
    CODE2: { events: [{ delay: 0, feedback: 'invalid' }] }
  });
  const session = await verifierFor(env).run([{ code: 'CODE1' }, { code: 'CODE2' }]);
  t.equal(session.status, 'CART_CHANGED'); t.equal(env.total, 9990);
  t.ok(!env.actions.includes('enter:CODE2'));
});

test('PromoTester CASE H: promo changing shipping is financial saving, not CART_CHANGED', async (t) => {
  const env = new FakeCheckoutEnvironment({
    CODE1: { events: [{ delay: 100, applied: true, shipping: 0, total: 10000, name: 'free-shipping-promo' }] }
  }, { financial: { subtotal: 10000, shipping: 500, tax: 0, discount: 0, total: 10500, currency: 'RUB' } });
  const session = await verifierFor(env).run([{ code: 'CODE1' }]);
  t.equal(session.status, 'COMPLETE'); t.equal(session.results[0].verificationStatus, C.STATUS.VALID_APPLIED);
  t.equal(session.results[0].saving, 500); t.equal(session.results[0].priceAfter.shipping, 0);
});

test('PromoTester CASE I: changed subtotal/tax breakdown with same items validates lower total', async (t) => {
  const env = new FakeCheckoutEnvironment({
    CODE1: { events: [{ delay: 100, applied: true, subtotal: 9500, tax: 300, total: 9800, name: 'breakdown-recalculated' }] }
  }, { financial: { subtotal: 10000, shipping: 0, tax: 500, discount: 0, total: 10500, currency: 'RUB' } });
  const session = await verifierFor(env).run([{ code: 'CODE1' }]);
  t.equal(session.status, 'COMPLETE'); t.equal(session.results[0].verificationStatus, C.STATUS.VALID_APPLIED);
  t.equal(session.results[0].saving, 700); t.equal(session.results[0].priceAfter.tax, 300);
});

test('PromoTester CASE J: same total with changed SKU or quantity stops CART_CHANGED', async (t) => {
  const changed = [{ itemId: 'ITEM-A', skuId: 'SKU-OTHER', quantity: 2, sellerId: 'STORE-A' }];
  const env = new FakeCheckoutEnvironment({ CODE1: { events: [{ delay: 500, items: changed, name: 'sku-quantity-changed' }] } });
  const session = await verifierFor(env).run([{ code: 'CODE1' }]);
  t.equal(session.status, 'CART_CHANGED'); t.equal(env.total, 9990);
});

test('WEAK baseline fingerprint refuses automatic promo verification', async (t) => {
  const env = new FakeCheckoutEnvironment({ CODE1: { events: [{ delay: 0, applied: true, total: 8790 }] } }, { items: [] });
  const session = await verifierFor(env).run([{ code: 'CODE1' }]);
  t.equal(session.status, 'CHECKOUT_IDENTITY_UNCERTAIN'); t.equal(session.checkoutFingerprint.quality, 'WEAK');
  t.match(session.stopReason, /Не удалось надёжно определить состав корзины/);
  t.ok(!env.actions.includes('enter:CODE1')); t.ok(!env.actions.includes('apply:CODE1'));
});

test('two currency-only fingerprints are not accepted as the same checkout by verifier policy', (t) => {
  const env = new FakeCheckoutEnvironment({}, { items: [] }); const verifier = verifierFor(env);
  const first = { fingerprint: C.buildCheckoutFingerprint({ currency: 'RUB', items: [] }) };
  const second = { fingerprint: C.buildCheckoutFingerprint({ currency: 'RUB', items: [] }) };
  t.equal(C.sameCheckoutFingerprint(first.fingerprint, second.fingerprint), true);
  t.equal(verifier.cartMatches(first, second), false);
});

test('MEDIUM fingerprint is allowed only when every item has itemId or skuId', (t) => {
  const env = new FakeCheckoutEnvironment(); const verifier = verifierFor(env);
  const safe = C.buildCheckoutFingerprint({ currency: 'RUB', items: [{ itemId: 'ITEM-A', quantity: null, rootEvidence: true }] });
  const unsafe = C.buildCheckoutFingerprint({ currency: 'RUB', items: [{ quantity: 1, rootEvidence: true }] });
  t.equal(safe.quality, 'MEDIUM'); t.equal(verifier.fingerprintIsReliable(safe), true);
  t.equal(unsafe.quality, 'MEDIUM'); t.equal(verifier.fingerprintIsReliable(unsafe), false);
});

test('PromoTester CASE K: equal total with different known breakdown stops BASELINE_LOST', async (t) => {
  const baseline = { subtotal: 10000, shipping: 500, tax: 0, discount: 0, total: 10500, currency: 'RUB' };
  const env = new FakeCheckoutEnvironment({
    CODE1: {
      events: [{ delay: 0, applied: true, shipping: 0, discount: 500, total: 10000 }],
      afterRemoveFinancial: { subtotal: 10500, shipping: 0, tax: 0, discount: 500, total: 10500, currency: 'RUB' }
    }
  }, { financial: baseline });
  const session = await verifierFor(env).run([{ code: 'CODE1' }]);
  t.equal(session.results[0].verificationStatus, C.STATUS.VALID_APPLIED);
  t.equal(session.status, 'BASELINE_LOST'); t.equal(session.results[0].baselineRestored, false);
});

test('PromoTester CASE L: unknown baseline component does not cause restoration mismatch', async (t) => {
  const baseline = { subtotal: 10000, shipping: null, tax: 0, discount: 0, total: 10500, currency: 'RUB' };
  const env = new FakeCheckoutEnvironment({
    CODE1: {
      events: [{ delay: 0, applied: true, total: 10000 }],
      afterRemoveFinancial: { subtotal: 10000, shipping: 500, tax: 0, discount: 0, total: 10500, currency: 'RUB' }
    }
  }, { financial: baseline });
  const session = await verifierFor(env).run([{ code: 'CODE1' }]);
  t.equal(session.status, 'COMPLETE'); t.equal(session.results[0].baselineRestored, true);
});

test('PromoTester CASE M: financial baseline tolerance accepts 0.005 deviation', async (t) => {
  const baseline = { subtotal: 10000, shipping: 500, tax: 0, discount: 0, total: 10500, currency: 'RUB' };
  const env = new FakeCheckoutEnvironment({
    CODE1: {
      events: [{ delay: 0, applied: true, total: 10000 }],
      afterRemoveFinancial: { subtotal: 10000.005, shipping: 500.005, tax: 0, discount: 0, total: 10500.005, currency: 'RUB' }
    }
  }, { financial: baseline });
  const session = await verifierFor(env).run([{ code: 'CODE1' }]);
  t.equal(session.status, 'COMPLETE'); t.equal(session.results[0].baselineRestored, true);
});

test('quiet-window stabilization ignores unrelated mutations and captures final 8790 total', async (t) => {
  const env = new FakeCheckoutEnvironment({
    CODE1: { events: [
      { delay: 100, applied: true, total: 9290, name: 'intermediate-total' },
      { delay: 400, name: 'unrelated-mutation' },
      { delay: 900, total: 8790, name: 'final-total' }
    ] }
  });
  const session = await verifierFor(env).run([{ code: 'CODE1' }]);
  t.equal(session.results[0].verificationStatus, C.STATUS.VALID_APPLIED);
  t.equal(session.results[0].priceAfter.total, 8790); t.equal(session.results[0].saving, 1200);
  t.ok(env.actions.includes('event:unrelated-mutation')); t.ok(env.time >= 1_700_000_002_900);
});

test('quiet-window stabilization captures only last stage of 9990→9490→8990→8790', async (t) => {
  const env = new FakeCheckoutEnvironment({
    CODE1: { events: [
      { delay: 100, applied: true, total: 9490, name: 'stage-1' },
      { delay: 400, total: 8990, name: 'stage-2' },
      { delay: 800, total: 8790, name: 'stage-3' }
    ] }
  });
  const session = await verifierFor(env).run([{ code: 'CODE1' }]);
  t.equal(session.results[0].priceAfter.total, 8790); t.equal(session.results[0].saving, 1200);
  t.ok(env.actions.includes('event:stage-3'));
});

test('mathematical early stop skips a code that cannot beat verified saving', async (t) => {
  const env = new FakeCheckoutEnvironment({ CODE1: { events: [{ delay: 0, applied: true, total: 8790 }] }, CODE2: { events: [{ delay: 0, applied: true, total: 9490 }] } });
  const session = await verifierFor(env, { maxCodes: 50 }).run([{ code: 'CODE1', theoreticalMaxSaving: 1200 }, { code: 'CODE2', theoreticalMaxSaving: 500 }]);
  t.equal(session.status, 'COMPLETE'); t.equal(session.results[1].verificationStatus, 'SKIPPED_CANNOT_BEAT_BEST');
  t.ok(!env.actions.includes('enter:CODE2'));
});

test('unknown theoretical maximum is never skipped by mathematical early stop', async (t) => {
  const env = new FakeCheckoutEnvironment({ CODE1: { events: [{ delay: 0, applied: true, total: 8790 }] }, CODE2: { events: [{ delay: 0, feedback: 'invalid' }] } });
  const session = await verifierFor(env, { maxCodes: 50 }).run([{ code: 'CODE1', theoreticalMaxSaving: 1200 }, { code: 'CODE2', theoreticalMaxSaving: null }]);
  t.ok(env.actions.includes('enter:CODE2')); t.equal(session.results[1].verificationStatus, C.STATUS.INVALID);
});

test('verifier defense-in-depth never attempts more than 50 codes', async (t) => {
  const behaviors = {}; const candidates = [];
  for (let index = 0; index < 60; index += 1) { const code = `HARD${String(index).padStart(2, '0')}`; behaviors[code] = { events: [{ delay: 0, feedback: 'invalid' }] }; candidates.push({ code }); }
  const env = new FakeCheckoutEnvironment(behaviors); const session = await verifierFor(env, { maxCodes: 500 }).run(candidates);
  t.equal(session.results.length, 50); t.equal(env.actions.filter((row) => row.startsWith('enter:')).length, 50);
});

test('rejected code clear waits for stable baseline before next code', async (t) => {
  const env = new FakeCheckoutEnvironment({
    CODE1: {
      events: [{ delay: 0, feedback: 'Minimum spend is not met', total: 9490, name: 'rejected-with-recalc' }],
      clearEvents: [{ delay: 600, total: 9990, name: 'clear-restored-baseline' }]
    },
    CODE2: { events: [{ delay: 0, feedback: 'invalid' }] }
  });
  const session = await verifierFor(env).run([{ code: 'CODE1' }, { code: 'CODE2' }]);
  t.equal(session.status, 'COMPLETE');
  t.ok(env.actions.indexOf('event:clear-restored-baseline') < env.actions.indexOf('enter:CODE2'));
});

test('checkout fingerprint is rechecked after Remove before queue continues', async (t) => {
  const changed = [{ itemId: 'ITEM-C', skuId: 'SKU-C', quantity: 1, sellerId: 'STORE-C' }];
  const env = new FakeCheckoutEnvironment({
    CODE1: { events: [{ delay: 0, applied: true, total: 8790 }], itemsAfterRemove: changed },
    CODE2: { events: [{ delay: 0, feedback: 'invalid' }] }
  });
  const session = await verifierFor(env).run([{ code: 'CODE1' }, { code: 'CODE2' }]);
  t.equal(session.status, 'CART_CHANGED'); t.ok(!env.actions.includes('enter:CODE2'));
});

test('old BEST cannot apply to different cart with coincidentally equal total', async (t) => {
  const env = new FakeCheckoutEnvironment({ CODE1: { events: [{ delay: 0, applied: true, total: 8790 }] } });
  const verifier = verifierFor(env); const session = await verifier.run([{ code: 'CODE1' }]);
  t.equal(session.bestCode, 'CODE1');
  env.items = [{ itemId: 'ITEM-OTHER', skuId: 'SKU-OTHER', quantity: 1, sellerId: 'STORE-X' }]; env.total = 9990; env.actions = [];
  const response = await verifier.applyBest('CODE1', session);
  t.equal(response.status, 'CART_CHANGED'); t.ok(!env.actions.includes('apply:CODE1'));
});

test('old BEST cannot apply on a different checkout origin or page class', async (t) => {
  const env = new FakeCheckoutEnvironment({ CODE1: { events: [{ delay: 0, applied: true, total: 8790 }] } });
  const verifier = verifierFor(env); const session = await verifier.run([{ code: 'CODE1' }]);
  env.origin = 'https://www.aliexpress.com'; env.total = 9990; env.actions = [];
  const response = await verifier.applyBest('CODE1', session);
  t.equal(response.status, 'CART_CHANGED'); t.ok(!env.actions.includes('apply:CODE1'));
});

test('old BEST cannot apply on a different checkout path class', async (t) => {
  const env = new FakeCheckoutEnvironment({ CODE1: { events: [{ delay: 0, applied: true, total: 8790 }] } });
  const verifier = verifierFor(env); const session = await verifier.run([{ code: 'CODE1' }]);
  env.pathClass = '/checkout/another-flow'; env.total = 9990; env.actions = [];
  const response = await verifier.applyBest('CODE1', session);
  t.equal(response.status, 'CART_CHANGED'); t.ok(!env.actions.includes('apply:CODE1'));
});
