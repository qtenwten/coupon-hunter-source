const fs = require('node:fs');
const { test } = require('./harness');
const { ROOT, FakeElement, sandbox, load } = require('./helpers');

const box = load(sandbox(), 'src/safety.js');
const S = box.CouponHunterSafety;

test('central safeClick allows a visible promo action', (t) => {
  const button = new FakeElement({ tag: 'button', text: 'Применить промокод' });
  const result = S.safeClick(button, { purpose: 'test', intent: 'APPLY_PROMO' });
  t.equal(result.clicked, true); t.equal(button.clicked, 1);
});

test('central safeClick blocks checkout and payment actions', (t) => {
  for (const label of ['Place order', 'Continue to payment', 'Оплатить', 'Купить', 'Заказать']) {
    const button = new FakeElement({ tag: 'button', text: label }); let blocked = false;
    try { S.safeClick(button, { purpose: 'test' }); } catch (_) { blocked = true; }
    t.equal(blocked, true, label); t.equal(button.clicked || 0, 0, label);
  }
});

test('all programmatic element clicks are centralized in safety.js', (t) => {
  const files = fs.readdirSync(`${ROOT}/src`).filter((name) => name.endsWith('.js'));
  const offenders = [];
  for (const file of files) {
    if (file === 'safety.js') continue;
    if (/\.click\s*\(/.test(fs.readFileSync(`${ROOT}/src/${file}`, 'utf8'))) offenders.push(file);
  }
  t.deep(offenders, []);
});
