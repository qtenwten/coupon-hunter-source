const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('./harness');
const Production = require('../src/production-feed-config');
const { verifyFeed } = require('../collector/signature');
const { PRODUCTION_FEED_VALIDITY_MS, EXTENSION_MAX_FEED_BYTES, loadProductionPrivateKey, buildProductionPages } = require('../collector/production-feed');
const { verifyProductionFile } = require('../collector/verify-production-feed');

const NOW = Date.parse('2026-10-04T12:00:00Z');
const privateKeyB64 = (privateKey) => Buffer.from(privateKey.export({ format: 'pem', type: 'pkcs8' }), 'utf8').toString('base64');
function feedicoAdapter(onFetch = () => {}) {
  return {
    id: 'feedico', sourceGroup: 'feedico', category: 'VERIFIED_PROVIDER', trust: 0.7, mode: 'FULL_SNAPSHOT', enabled: true,
    async fetch() { onFetch(); return { rows: [{ code: 'PROD10', discountAmount: 10, currency: 'USD' }], rawCount: 1, diagnostics: { normalizedCount: 1, pagesRequested: 1, feedicoTruncated: false } }; },
    normalize(value) { return value; }
  };
}

test('production builder signs, verifies and writes only public Pages files with 18 hour validity', async (t) => {
  const keys = crypto.generateKeyPairSync('ed25519'); const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'coupon-hunter-pages-')); let providerCalls = 0; const logs = [];
  const result = await buildProductionPages({ adapters: [feedicoAdapter(() => { providerCalls += 1; })], privateKeyB64: privateKeyB64(keys.privateKey), publicKeyJwk: keys.publicKey.export({ format: 'jwk' }), outputDirectory, nowMs: NOW, logger: (message) => logs.push(message) });
  t.equal(result.signatureValid, true); t.equal(verifyFeed(result.feed, keys.publicKey), true);
  t.equal(Date.parse(result.feed.expiresAt) - Date.parse(result.feed.generatedAt), PRODUCTION_FEED_VALIDITY_MS);
  t.ok(result.bytes < EXTENSION_MAX_FEED_BYTES); t.equal(result.feed.signature.keyId, Production.keyId);
  t.deep((await fs.readdir(outputDirectory)).sort(), ['health.json', 'promo-feed.json']);
  const health = JSON.parse(await fs.readFile(path.join(outputDirectory, 'health.json'), 'utf8'));
  t.deep(Object.keys(health).sort(), ['feedicoStatus', 'generatedAt', 'pagesRequested', 'promoCount', 'revision', 'truncated']);
  t.equal((await verifyProductionFile(path.join(outputDirectory, 'promo-feed.json'), { publicKeyJwk: keys.publicKey.export({ format: 'jwk' }) })).signatureValid, true);
  t.equal(providerCalls, 1); t.deep(logs, ['Production signing key preflight: OK']);
});

test('valid base64 PKCS8 Ed25519 private key passes exact public JWK preflight', (t) => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const loaded = loadProductionPrivateKey({ privateKeyB64: privateKeyB64(keys.privateKey), publicKeyJwk: keys.publicKey.export({ format: 'jwk' }) });
  t.equal(loaded.type, 'private'); t.equal(loaded.asymmetricKeyType, 'ed25519');
});

test('standalone production verifier rejects a tampered generated feed', async (t) => {
  const keys = crypto.generateKeyPairSync('ed25519'); const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'coupon-hunter-pages-'));
  await buildProductionPages({ adapters: [feedicoAdapter()], privateKeyB64: privateKeyB64(keys.privateKey), publicKeyJwk: keys.publicKey.export({ format: 'jwk' }), outputDirectory, nowMs: NOW });
  const file = path.join(outputDirectory, 'promo-feed.json'); const feed = JSON.parse(await fs.readFile(file, 'utf8')); feed.promos[0].discountAmount = 999; await fs.writeFile(file, JSON.stringify(feed));
  let errorCode = null; try { await verifyProductionFile(file, { publicKeyJwk: keys.publicKey.export({ format: 'jwk' }) }); } catch (error) { errorCode = error.code; }
  t.equal(errorCode, 'PRODUCTION_SIGNATURE_INVALID');
});

test('missing B64 secret ignores legacy PEM env and fails before any provider request or output', async (t) => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'coupon-hunter-pages-')); let calls = 0; let errorCode = null;
  const previousB64 = process.env.COUPON_HUNTER_FEED_PRIVATE_KEY_B64; const previousLegacy = process.env.COUPON_HUNTER_FEED_PRIVATE_KEY;
  delete process.env.COUPON_HUNTER_FEED_PRIVATE_KEY_B64; process.env.COUPON_HUNTER_FEED_PRIVATE_KEY = 'legacy-secret-must-not-be-used';
  try { await buildProductionPages({ adapters: [feedicoAdapter(() => { calls += 1; })], outputDirectory, nowMs: NOW }); } catch (error) { errorCode = error.code; }
  finally {
    if (previousB64 === undefined) delete process.env.COUPON_HUNTER_FEED_PRIVATE_KEY_B64; else process.env.COUPON_HUNTER_FEED_PRIVATE_KEY_B64 = previousB64;
    if (previousLegacy === undefined) delete process.env.COUPON_HUNTER_FEED_PRIVATE_KEY; else process.env.COUPON_HUNTER_FEED_PRIVATE_KEY = previousLegacy;
  }
  t.equal(errorCode, 'PRODUCTION_PRIVATE_KEY_B64_REQUIRED'); t.equal(calls, 0); t.deep(await fs.readdir(outputDirectory), []);
});

test('malformed base64 fails before provider access without leaking secret material', async (t) => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'coupon-hunter-pages-')); let calls = 0; let caught = null;
  const malformed = 'not-base64!!PRIVATE-SECRET-SENTINEL';
  try { await buildProductionPages({ adapters: [feedicoAdapter(() => { calls += 1; })], privateKeyB64: malformed, outputDirectory, nowMs: NOW }); } catch (error) { caught = error; }
  t.equal(caught?.code, 'PRODUCTION_PRIVATE_KEY_B64_INVALID'); t.equal(calls, 0); t.ok(!String(caught?.stack).includes(malformed)); t.deep(await fs.readdir(outputDirectory), []);
});

test('valid PKCS8 non-Ed25519 key fails before provider access', async (t) => {
  const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'coupon-hunter-pages-')); let calls = 0; let errorCode = null;
  try { await buildProductionPages({ adapters: [feedicoAdapter(() => { calls += 1; })], privateKeyB64: privateKeyB64(keys.privateKey), outputDirectory, nowMs: NOW }); } catch (error) { errorCode = error.code; }
  t.equal(errorCode, 'PRODUCTION_PRIVATE_KEY_NOT_ED25519'); t.equal(calls, 0); t.deep(await fs.readdir(outputDirectory), []);
});

test('Ed25519 private and public key mismatch fails preflight with zero provider calls', async (t) => {
  const signing = crypto.generateKeyPairSync('ed25519'); const verification = crypto.generateKeyPairSync('ed25519');
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'coupon-hunter-pages-')); let calls = 0; let errorCode = null;
  try { await buildProductionPages({ adapters: [feedicoAdapter(() => { calls += 1; })], privateKeyB64: privateKeyB64(signing.privateKey), publicKeyJwk: verification.publicKey.export({ format: 'jwk' }), outputDirectory, nowMs: NOW }); } catch (error) { errorCode = error.code; }
  t.equal(errorCode, 'PRODUCTION_PUBLIC_KEY_MISMATCH'); t.equal(calls, 0); t.deep(await fs.readdir(outputDirectory), []);
});

test('production CLI error output never includes base64 or decoded private material', (t) => {
  const secretText = 'PRIVATE-KEY-SENTINEL-MUST-STAY-HIDDEN'; const encoded = Buffer.from(secretText, 'utf8').toString('base64');
  const result = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, '../collector/production-feed.js')], { encoding: 'utf8', env: { ...process.env, COUPON_HUNTER_FEED_PRIVATE_KEY_B64: encoded, FEEDICO_TOKEN: '' } });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  t.equal(result.status, 1); t.match(output, /PRODUCTION_PRIVATE_KEY_B64_INVALID/); t.ok(!output.includes(encoded)); t.ok(!output.includes(secretText));
});

test('production quality gate rejects EMPTY Feedico before Pages output', async (t) => {
  const keys = crypto.generateKeyPairSync('ed25519'); const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'coupon-hunter-pages-'));
  const empty = feedicoAdapter(); empty.fetch = async () => ({ rows: [], rawCount: 0, diagnostics: { normalizedCount: 0, pagesRequested: 1, feedicoTruncated: false } }); let errorCode = null;
  try { await buildProductionPages({ adapters: [empty], privateKeyB64: privateKeyB64(keys.privateKey), publicKeyJwk: keys.publicKey.export({ format: 'jwk' }), outputDirectory, nowMs: NOW }); } catch (error) { errorCode = error.code; }
  t.equal(errorCode, 'PRODUCTION_FEEDICO_EMPTY'); t.deep(await fs.readdir(outputDirectory), []);
});
