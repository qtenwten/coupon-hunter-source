(() => {
  'use strict';
  if (globalThis.CouponHunterFeedSignature) return;

  function canonicalize(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    return `{${Object.keys(value).filter((key) => key !== 'signature').sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }

  function decodeBase64Url(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded); return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  async function verifyEnvelope(feed, publicKeyJwk, cryptoImpl = globalThis.crypto) {
    if (!feed?.signature || feed.signature.algorithm !== 'Ed25519' || !feed.signature.value) return false;
    if (!publicKeyJwk || !cryptoImpl?.subtle) return false;
    try {
      const key = await cryptoImpl.subtle.importKey('jwk', publicKeyJwk, { name: 'Ed25519' }, false, ['verify']);
      return cryptoImpl.subtle.verify({ name: 'Ed25519' }, key, decodeBase64Url(feed.signature.value), new TextEncoder().encode(canonicalize(feed)));
    } catch (_) { return false; }
  }

  globalThis.CouponHunterFeedSignature = { canonicalize, decodeBase64Url, verifyEnvelope };
})();
