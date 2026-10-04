const fs = require('node:fs');
const path = require('node:path');
const { test } = require('./harness');
const { ROOT } = require('./helpers');

const workflowPath = path.join(ROOT, '.github/workflows/feedico-smoke.yml');

test('Feedico workflow is manual-only and consumes the GitHub Secret', (t) => {
  const source = fs.readFileSync(workflowPath, 'utf8');
  const beforeSteps = source.slice(0, source.indexOf('    steps:'));
  const smokeStepStart = source.indexOf('      - name: Run Feedico Stage A smoke test');
  const nextStepStart = source.indexOf('\n      - name:', smokeStepStart + 1);
  const smokeStep = source.slice(smokeStepStart, nextStepStart);
  const secretReference = /FEEDICO_TOKEN:\s*\$\{\{ secrets\.FEEDICO_TOKEN \}\}/g;

  t.match(source, /workflow_dispatch:/);
  t.ok(!/^\s*schedule:/m.test(source));
  t.ok(!/FEEDICO_TOKEN:/.test(beforeSteps), 'FEEDICO_TOKEN is not defined at job level');
  t.match(smokeStep, /^\s{8}env:\s*$/m);
  t.match(smokeStep, /FEEDICO_TOKEN:\s*\$\{\{ secrets\.FEEDICO_TOKEN \}\}/);
  t.equal([...source.matchAll(secretReference)].length, 1, 'secret is referenced only by the smoke step');
});

test('Feedico workflow tests before collector and uploads only safe artifacts', (t) => {
  const source = fs.readFileSync(workflowPath, 'utf8');
  t.ok(source.indexOf('run: npm test') < source.indexOf('collector/feedico-smoke.js'));
  t.match(source, /actions\/upload-artifact@v4/); t.match(source, /promo-feed\.json/); t.match(source, /provider-diagnostics\.json/);
  t.ok(!/git\s+(?:add|commit|push)/.test(source)); t.ok(!/COUPON_HUNTER_FEED_PRIVATE_KEY/.test(source));
});
