const fs = require('node:fs');
const path = require('node:path');
const { test } = require('./harness');
const { ROOT } = require('./helpers');

const workflowPath = path.join(ROOT, '.github/workflows/feedico-smoke.yml');

test('Feedico workflow is manual-only and consumes the GitHub Secret', (t) => {
  const source = fs.readFileSync(workflowPath, 'utf8');
  t.match(source, /workflow_dispatch:/); t.ok(!/^\s*schedule:/m.test(source)); t.match(source, /FEEDICO_TOKEN:\s*\$\{\{ secrets\.FEEDICO_TOKEN \}\}/);
});

test('Feedico workflow tests before collector and uploads only safe artifacts', (t) => {
  const source = fs.readFileSync(workflowPath, 'utf8');
  t.ok(source.indexOf('run: npm test') < source.indexOf('collector/feedico-smoke.js'));
  t.match(source, /actions\/upload-artifact@v4/); t.match(source, /promo-feed\.json/); t.match(source, /provider-diagnostics\.json/);
  t.ok(!/git\s+(?:add|commit|push)/.test(source)); t.ok(!/COUPON_HUNTER_FEED_PRIVATE_KEY/.test(source));
});
