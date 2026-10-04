const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('./harness');
const Production = require('../src/production-feed-config');
const { verifyFeed } = require('../collector/signature');
const { PRODUCTION_FEED_VALIDITY_MS, EXTENSION_MAX_FEED_BYTES, buildProductionPages } = require('../collector/production-feed');
const { verifyProductionFile } = require('../collector/verify-production-feed');

const NOW = Date.parse('2026-10-04T12:00:00Z');
function feedicoAdapter(onFetch = () => {}) {
  return {
    id: 'feedico', sourceGroup: 'feedico', category: 'VERIFIED_PROVIDER', trust: 0.7, mode: 'FULL_SNAPSHOT', enabled: true,
    async fetch() { onFetch(); return { rows: [{ code: 'PROD10', discountAmount: 10, currency: 'USD' }], rawCount: 1, diagnostics: { normalizedCount: 1, pagesRequested: 1, feedicoTruncated: false } }; },
    normalize(value) { return value; }
  };
}

test('production builder signs, verifies and writes only public Pages files with 18 hour validity', async (t) => {
  const keys = crypto.generateKeyPairSync('ed25519'); const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'coupon-hunter-pages-')); let providerCalls = 0;
  const result = await buildProductionPages({ adapters: [feedicoAdapter(() => { providerCalls += 1; })], privateKey: keys.privateKey, publicKeyJwk: keys.publicKey.export({ format: 'jwk' }), outputDirectory, nowMs: NOW });
  t.equal(result.signatureValid, true); t.equal(verifyFeed(result.feed, keys.publicKey), true);
  t.equal(Date.parse(result.feed.expiresAt) - Date.parse(result.feed.generatedAt), PRODUCTION_FEED_VALIDITY_MS);
  t.ok(result.bytes < EXTENSION_MAX_FEED_BYTES); t.equal(result.feed.signature.keyId, Production.keyId);
  t.deep((await fs.readdir(outputDirectory)).sort(), ['health.json', 'promo-feed.json']);
  const health = JSON.parse(await fs.readFile(path.join(outputDirectory, 'health.json'), 'utf8'));
  t.deep(Object.keys(health).sort(), ['feedicoStatus', 'generatedAt', 'pagesRequested', 'promoCount', 'revision', 'truncated']);
  t.equal((await verifyProductionFile(path.join(outputDirectory, 'promo-feed.json'), { publicKeyJwk: keys.publicKey.export({ format: 'jwk' }) })).signatureValid, true);
  t.equal(providerCalls, 1);
});

test('standalone production verifier rejects a tampered generated feed', async (t) => {
  const keys = crypto.generateKeyPairSync('ed25519'); const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'coupon-hunter-pages-'));
  await buildProductionPages({ adapters: [feedicoAdapter()], privateKey: keys.privateKey, publicKeyJwk: keys.publicKey.export({ format: 'jwk' }), outputDirectory, nowMs: NOW });
  const file = path.join(outputDirectory, 'promo-feed.json'); const feed = JSON.parse(await fs.readFile(file, 'utf8')); feed.promos[0].discountAmount = 999; await fs.writeFile(file, JSON.stringify(feed));
  let errorCode = null; try { await verifyProductionFile(file, { publicKeyJwk: keys.publicKey.export({ format: 'jwk' }) }); } catch (error) { errorCode = error.code; }
  t.equal(errorCode, 'PRODUCTION_SIGNATURE_INVALID');
});

test('missing production private key fails before any provider request or output', async (t) => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'coupon-hunter-pages-')); let calls = 0; let errorCode = null;
  try { await buildProductionPages({ adapters: [feedicoAdapter(() => { calls += 1; })], privateKey: '', outputDirectory, nowMs: NOW }); } catch (error) { errorCode = error.code; }
  t.equal(errorCode, 'PRODUCTION_PRIVATE_KEY_REQUIRED'); t.equal(calls, 0); t.deep(await fs.readdir(outputDirectory), []);
});

test('private and public key mismatch fails production verification without Pages output', async (t) => {
  const signing = crypto.generateKeyPairSync('ed25519'); const verification = crypto.generateKeyPairSync('ed25519');
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'coupon-hunter-pages-')); let errorCode = null;
  try { await buildProductionPages({ adapters: [feedicoAdapter()], privateKey: signing.privateKey, publicKeyJwk: verification.publicKey.export({ format: 'jwk' }), outputDirectory, nowMs: NOW }); } catch (error) { errorCode = error.code; }
  t.equal(errorCode, 'PRODUCTION_SIGNATURE_INVALID'); t.deep(await fs.readdir(outputDirectory), []);
});

test('production quality gate rejects EMPTY Feedico before Pages output', async (t) => {
  const keys = crypto.generateKeyPairSync('ed25519'); const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'coupon-hunter-pages-'));
  const empty = feedicoAdapter(); empty.fetch = async () => ({ rows: [], rawCount: 0, diagnostics: { normalizedCount: 0, pagesRequested: 1, feedicoTruncated: false } }); let errorCode = null;
  try { await buildProductionPages({ adapters: [empty], privateKey: keys.privateKey, publicKeyJwk: keys.publicKey.export({ format: 'jwk' }), outputDirectory, nowMs: NOW }); } catch (error) { errorCode = error.code; }
  t.equal(errorCode, 'PRODUCTION_FEEDICO_EMPTY'); t.deep(await fs.readdir(outputDirectory), []);
});
