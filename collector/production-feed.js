'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { buildFeedWithState } = require('./build-feed');
const { defaultRegistry } = require('./source-registry');
const { signFeed, verifyFeed } = require('./signature');
const { validateFeed } = require('./validate');
const { writeJsonAtomic } = require('./state-store');
const Production = require('../src/production-feed-config');

const PRODUCTION_FEED_VALIDITY_MS = 18 * 60 * 60 * 1000;
const EXTENSION_MAX_FEED_BYTES = 2 * 1024 * 1024;

function productionError(code) { const error = new Error(code); error.code = code; return error; }

function decodePrivateKeyPem(value) {
  if (!value) throw productionError('PRODUCTION_PRIVATE_KEY_B64_REQUIRED');
  const encoded = String(value).replace(/\s+/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) throw productionError('PRODUCTION_PRIVATE_KEY_B64_INVALID');
  let decoded;
  try {
    decoded = Buffer.from(encoded, 'base64');
    if (!decoded.length || decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new Error('invalid base64');
    const pem = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
    const begin = ['-----BEGIN', 'PRIVATE KEY-----'].join(' '); const end = ['-----END', 'PRIVATE KEY-----'].join(' ');
    if (!pem.startsWith(`${begin}\n`) && !pem.startsWith(`${begin}\r\n`)) throw new Error('not PKCS8 PEM');
    if (!pem.trimEnd().endsWith(end)) throw new Error('not PKCS8 PEM');
    return pem;
  } catch (_) { throw productionError('PRODUCTION_PRIVATE_KEY_B64_INVALID'); }
}

function publicJwkMatches(actual, expected) {
  return ['kty', 'crv', 'x'].every((field) => typeof expected?.[field] === 'string' && actual?.[field] === expected[field]);
}

function loadProductionPrivateKey(options = {}) {
  const pem = decodePrivateKeyPem(options.privateKeyB64 ?? process.env.COUPON_HUNTER_FEED_PRIVATE_KEY_B64);
  let privateKey;
  try { privateKey = crypto.createPrivateKey(pem); } catch (_) { throw productionError('PRODUCTION_PRIVATE_KEY_PKCS8_INVALID'); }
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw productionError('PRODUCTION_PRIVATE_KEY_NOT_ED25519');
  let derivedPublicJwk;
  try { derivedPublicJwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' }); } catch (_) { throw productionError('PRODUCTION_PUBLIC_KEY_DERIVATION_FAILED'); }
  if (!publicJwkMatches(derivedPublicJwk, options.publicKeyJwk || Production.publicKeyJwk)) throw productionError('PRODUCTION_PUBLIC_KEY_MISMATCH');
  return privateKey;
}

function productionQualityGate(feed, publicKeyJwk = Production.publicKeyJwk) {
  try { validateFeed(feed); } catch (_) { throw productionError('PRODUCTION_SCHEMA_INVALID'); }
  const health = feed?.diagnostics?.sourceHealth?.feedico || {};
  if (health.status !== 'OK') throw productionError(`PRODUCTION_FEEDICO_${health.status || 'MISSING'}`);
  if (!(Number(health.rawCount) > 0)) throw productionError('PRODUCTION_RAW_COUNT_EMPTY');
  if (!(Number(health.normalizedCount) > 0)) throw productionError('PRODUCTION_NORMALIZED_COUNT_EMPTY');
  if (!Array.isArray(feed.promos) || feed.promos.length === 0) throw productionError('PRODUCTION_PROMO_COUNT_EMPTY');
  const bytes = Buffer.byteLength(JSON.stringify(feed));
  if (bytes >= EXTENSION_MAX_FEED_BYTES) throw productionError('PRODUCTION_FEED_TOO_LARGE');
  let signatureValid = false;
  try { signatureValid = verifyFeed(feed, crypto.createPublicKey({ key: publicKeyJwk, format: 'jwk' })); } catch (_) {}
  if (!signatureValid) throw productionError('PRODUCTION_SIGNATURE_INVALID');
  return { signatureValid, bytes, health };
}

function publicHealth(feed, gate) {
  return {
    generatedAt: feed.generatedAt,
    revision: feed.revision,
    promoCount: feed.promos.length,
    feedicoStatus: gate.health.status,
    pagesRequested: Number.isFinite(gate.health.pagesRequested) ? gate.health.pagesRequested : 0,
    truncated: gate.health.feedicoTruncated === true
  };
}

async function buildProductionPages(options = {}) {
  const publicKeyJwk = options.publicKeyJwk || Production.publicKeyJwk;
  const privateKey = loadProductionPrivateKey({ privateKeyB64: options.privateKeyB64, publicKeyJwk });
  if (typeof options.logger === 'function') options.logger('Production signing key preflight: OK');
  const nowMs = options.nowMs ?? Date.now();
  const adapters = options.adapters || defaultRegistry();
  const built = await buildFeedWithState(adapters, { nowMs, validForMs: PRODUCTION_FEED_VALIDITY_MS });
  let feed;
  try { feed = signFeed(built.feed, privateKey, Production.keyId); } catch (_) { throw productionError('PRODUCTION_SIGNING_FAILED'); }
  const gate = productionQualityGate(feed, publicKeyJwk);
  const outputDirectory = path.resolve(options.outputDirectory || '.production-pages');
  await writeJsonAtomic(path.join(outputDirectory, 'promo-feed.json'), feed);
  const health = publicHealth(feed, gate); await writeJsonAtomic(path.join(outputDirectory, 'health.json'), health);
  return { feed, health, signatureValid: gate.signatureValid, bytes: gate.bytes };
}

async function main() {
  const result = await buildProductionPages({ outputDirectory: process.argv[2] || '.production-pages', logger: (message) => console.log(message) });
  console.log(`Production feed ready: promos=${result.health.promoCount} status=${result.health.feedicoStatus} signatureValid=${result.signatureValid} bytes=${result.bytes}`);
}

if (require.main === module) main().catch((error) => { console.error(`Production feed failed safely: ${error?.code || 'PRODUCTION_BUILD_FAILED'}`); process.exitCode = 1; });

module.exports = { PRODUCTION_FEED_VALIDITY_MS, EXTENSION_MAX_FEED_BYTES, decodePrivateKeyPem, publicJwkMatches, loadProductionPrivateKey, productionQualityGate, publicHealth, buildProductionPages };
