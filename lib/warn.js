// Re-arming warning throttle.
//
// These sites used a module-level boolean. On Vercel every cold start reset it,
// so the warning was effectively per-request. Under a long-lived PM2 fork the
// same boolean prints once ever and then goes silent for months, which is how
// "idempotency is disabled, every template is double-sending" becomes invisible.

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

function makeWarner(tag, windowMs = DEFAULT_WINDOW_MS) {
  let last = 0;
  let suppressed = 0;
  return function warn(e) {
    const now = Date.now();
    if (last && now - last < windowMs) { suppressed += 1; return; }
    const extra = suppressed ? ` (${suppressed} more since the last one)` : '';
    last = now;
    suppressed = 0;
    console.error(`${tag}${extra}:`, (e && (e.code || e.message)) || e);
  };
}

module.exports = { makeWarner };
