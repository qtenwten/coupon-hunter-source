const fs = require('node:fs');
const path = require('node:path');
const { test } = require('./harness');
const { ROOT } = require('./helpers');

const workflowPath = path.join(ROOT, '.github/workflows/feedico-smoke.yml');
const productionWorkflowPath = path.join(ROOT, '.github/workflows/production-feed.yml');

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

test('production workflow is manual and six-hour scheduled without pull request trigger', (t) => {
  const source = fs.readFileSync(productionWorkflowPath, 'utf8');
  t.match(source, /workflow_dispatch:/); t.match(source, /cron:\s*'17 \*\/6 \* \* \*'/);
  t.ok(!/^\s*pull_request(?:_target)?:/m.test(source)); t.ok(!/^\s*push:/m.test(source));
  t.match(source, /concurrency:/); t.match(source, /cancel-in-progress:\s*false/);
});

test('production secrets are scoped only to the gated build step after tests', (t) => {
  const source = fs.readFileSync(productionWorkflowPath, 'utf8');
  const beforeSteps = source.slice(0, source.indexOf('    steps:'));
  const productionStepStart = source.indexOf('      - name: Preflight signing key, build and quality gate production feed');
  const productionStepEnd = source.indexOf('\n      - name:', productionStepStart + 1);
  const productionStep = source.slice(productionStepStart, productionStepEnd);
  t.ok(!/FEEDICO_TOKEN|COUPON_HUNTER_FEED_PRIVATE_KEY_B64/.test(beforeSteps));
  t.equal((source.match(/secrets\.FEEDICO_TOKEN/g) || []).length, 1); t.equal((source.match(/secrets\.COUPON_HUNTER_FEED_PRIVATE_KEY_B64/g) || []).length, 1);
  t.match(productionStep, /FEEDICO_TOKEN:\s*\$\{\{ secrets\.FEEDICO_TOKEN \}\}/);
  t.match(productionStep, /COUPON_HUNTER_FEED_PRIVATE_KEY_B64:\s*\$\{\{ secrets\.COUPON_HUNTER_FEED_PRIVATE_KEY_B64 \}\}/);
  t.ok(!/COUPON_HUNTER_FEED_PRIVATE_KEY(?!_B64)/.test(source), 'legacy multiline PEM secret is not referenced');
  t.ok(source.indexOf('run: npm test') < productionStepStart);
});

test('Pages deploy depends on verified artifact and cannot precede quality gate', (t) => {
  const source = fs.readFileSync(productionWorkflowPath, 'utf8');
  const gate = source.indexOf('Preflight signing key, build and quality gate production feed'); const verify = source.indexOf('collector:verify-production'); const upload = source.indexOf('actions/upload-pages-artifact@v4'); const deploy = source.indexOf('actions/deploy-pages@v4');
  t.ok(gate >= 0 && gate < verify && verify < upload && upload < deploy); t.match(source, /deploy:\s*\n\s+needs:\s*build-and-verify/);
  t.match(source, /pages:\s*write/); t.match(source, /id-token:\s*write/); t.match(source, /name:\s*github-pages/);
  t.ok(!/git\s+(?:add|commit|push)/.test(source));
});

test('generated production feed and private key material are not tracked', (t) => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  const tracked = require('node:child_process').execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  t.match(ignore, /^\.production-pages\/$/m); t.ok(!tracked.some((file) => /(^|\/)promo-feed\.json$/.test(file) && file !== 'data/promo-feed.dev.json'));
  t.ok(!tracked.some((file) => /\.(?:pem|key|p8)$/i.test(file) || /(^|\/)\.env(?:\.|$)/.test(file)));
  for (const file of tracked.filter((name) => /\.(?:js|json|md|yml|yaml|html|css|txt)$/i.test(name))) {
    t.ok(!/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')), file);
  }
});
