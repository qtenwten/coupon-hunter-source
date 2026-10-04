const crypto = require('node:crypto');
const { test } = require('./harness');
const { sandbox, load } = require('./helpers');
const { signFeed, verifyFeed, canonicalize } = require('../collector/signature');

const box = load(sandbox({ crypto: crypto.webcrypto, TextEncoder, atob: (value) => Buffer.from(value, 'base64').toString('binary') }), 'src/feed-signature.js');

test('Ed25519 canonical feed signature verifies in collector and extension modules', async (t) => {
  const keys = crypto.generateKeyPairSync('ed25519'); const feed = { schemaVersion: 3, feedId: 'coupon-hunter-aliexpress', revision: 'signed-1', mode: 'FULL_SNAPSHOT', merchant: 'aliexpress', generatedAt: '2026-10-04T00:00:00Z', expiresAt: '2026-10-05T00:00:00Z', promos: [{ code: 'SIGNED10' }] };
  const signed = signFeed(feed, keys.privateKey, 'test'); const jwk = keys.publicKey.export({ format: 'jwk' });
  t.equal(verifyFeed(signed, keys.publicKey), true); t.equal(await box.CouponHunterFeedSignature.verifyEnvelope(signed, jwk, crypto.webcrypto), true);
  t.equal(canonicalize(signed), box.CouponHunterFeedSignature.canonicalize(signed));
});

test('feed signature fails closed after payload tampering or without a key', async (t) => {
  const keys = crypto.generateKeyPairSync('ed25519'); const signed = signFeed({ schemaVersion: 3, feedId: 'coupon-hunter-aliexpress', revision: 'signed-2', mode: 'FULL_SNAPSHOT', merchant: 'aliexpress', promos: [] }, keys.privateKey, 'test');
  signed.promos.push({ code: 'TAMPER10' }); const jwk = keys.publicKey.export({ format: 'jwk' });
  t.equal(verifyFeed(signed, keys.publicKey), false); t.equal(await box.CouponHunterFeedSignature.verifyEnvelope(signed, jwk, crypto.webcrypto), false); t.equal(await box.CouponHunterFeedSignature.verifyEnvelope(signed, null, crypto.webcrypto), false);
});
