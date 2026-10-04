'use strict';
const crypto = require('node:crypto');
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).filter((key) => key !== 'signature').sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}
function signFeed(feed, privateKey, keyId = 'production') {
  const value = crypto.sign(null, Buffer.from(canonicalize(feed)), privateKey).toString('base64url'); return { ...feed, signature: { algorithm: 'Ed25519', keyId, value } };
}
function verifyFeed(feed, publicKey) { if (feed?.signature?.algorithm !== 'Ed25519') return false; return crypto.verify(null, Buffer.from(canonicalize(feed)), publicKey, Buffer.from(feed.signature.value, 'base64url')); }
module.exports = { canonicalize, signFeed, verifyFeed };
