'use strict';

class ProviderError extends Error {
  constructor(errorClass, message, status = null) { super(message || errorClass); this.name = 'ProviderError'; this.errorClass = errorClass; this.status = status; }
}

function retryAfterMs(value, nowMs = Date.now()) {
  if (!value) return 0; const seconds = Number(value); if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value); return Number.isFinite(date) ? Math.max(0, date - nowMs) : 0;
}
function sanitizeError(error) {
  const message = String(error?.message || error || 'Provider request failed').replace(/((?:^|[?&\s])(?:api_key|key|token)=)[^&\s]+/gi, '$1[REDACTED]').replace(/(bearer\s+)[a-z0-9._-]+/gi, '$1[REDACTED]');
  return { errorClass: error?.errorClass || 'FAILED', message: message.slice(0, 240), status: Number.isFinite(error?.status) ? error.status : null };
}

async function requestJson(url, options = {}) {
  const fetchImpl = options.fetchImpl || fetch; const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const retries = Math.max(0, Math.min(3, options.retries ?? 2)); const timeoutMs = options.timeoutMs || 10_000;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { method: options.method || 'GET', headers: options.headers || {}, body: options.body, signal: controller.signal });
      if (response.status === 401 || response.status === 403) throw new ProviderError('AUTH_REQUIRED', `Provider authentication failed (${response.status})`, response.status);
      if (response.status === 429) {
        const waitMs = Math.min(60_000, retryAfterMs(response.headers?.get?.('retry-after'))); if (waitMs) await sleep(waitMs);
        throw new ProviderError('RATE_LIMITED', 'Provider rate limit reached', 429);
      }
      if (!response.ok) {
        if (response.status >= 500 && attempt < retries) { await sleep(Math.min(4000, 250 * (2 ** attempt))); continue; }
        throw new ProviderError('FAILED', `Provider HTTP ${response.status}`, response.status);
      }
      let payload; try { payload = await response.json(); } catch (_) { throw new ProviderError('INVALID_RESPONSE', 'Provider returned invalid JSON'); }
      return payload;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (attempt < retries) { await sleep(Math.min(4000, 250 * (2 ** attempt))); continue; }
      throw new ProviderError(error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', error?.name === 'AbortError' ? 'Provider request timed out' : 'Provider network request failed');
    } finally { clearTimeout(timer); }
  }
  throw new ProviderError('FAILED', 'Provider request failed');
}

module.exports = { ProviderError, retryAfterMs, sanitizeError, requestJson };
