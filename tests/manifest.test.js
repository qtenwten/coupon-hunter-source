const fs = require('node:fs');
const { test } = require('./harness');
const { ROOT } = require('./helpers');

test('Manifest V3 uses minimal permissions and no remote executable code', (t) => {
  const manifest = JSON.parse(fs.readFileSync(`${ROOT}/manifest.json`, 'utf8'));
  t.equal(manifest.manifest_version, 3); t.equal(manifest.version, '3.1.1');
  t.deep(manifest.permissions, ['storage', 'activeTab']);
  t.equal(manifest.background, undefined);
  const scripts = manifest.content_scripts.flatMap((row) => row.js || []);
  t.ok(scripts.every((file) => !/^https?:/i.test(file)));
  t.ok(scripts.includes('src/checkout-core.js')); t.ok(scripts.includes('src/verifier-engine.js')); t.ok(scripts.includes('src/safety.js'));
  t.ok(scripts.includes('src/storage.js')); t.ok(scripts.includes('src/page-adapter.js'));
});

test('known-code bundle is data-only and intentionally makes no stale claims', (t) => {
  const payload = JSON.parse(fs.readFileSync(`${ROOT}/data/known-codes.json`, 'utf8'));
  t.equal(payload.schemaVersion, 1); t.deep(payload.codes, []);
});
