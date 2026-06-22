// Minimal shared-passcode access gate.
//
// Flow: the browser POSTs the passcode to /api/login. If it matches
// DASHBOARD_PASSCODE we set a signed, httpOnly cookie. Every /api/* data route
// runs requireAuth, which verifies that cookie server-side. No DB, no sessions
// table — the cookie itself is the proof, signed with SESSION_SECRET so it
// can't be forged.

const crypto = require('crypto');

const COOKIE_NAME = 'wa_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function secret() {
  // Fall back to SESSION_SECRET; if unset we still run but warn loudly once.
  return process.env.SESSION_SECRET || '';
}

// Constant-time string compare that won't throw on length mismatch.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Still do a compare to keep timing roughly constant, then return false.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('hex');
}

// Token = "<expiresAtMs>.<hmac>". We don't store anything user-specific; this
// is a single shared gate, so the token just proves "knew the passcode + not
// expired".
function issueToken() {
  const expires = Date.now() + SESSION_TTL_MS;
  const payload = String(expires);
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!safeEqual(mac, sign(payload))) return false;
  const expires = Number(payload);
  if (!Number.isFinite(expires) || Date.now() > expires) return false;
  return true;
}

function passcodeMatches(input) {
  const expected = process.env.DASHBOARD_PASSCODE || '';
  if (!expected) return false; // no passcode set => gate is closed, not open
  return safeEqual(input || '', expected);
}

// --- tiny cookie helpers (avoid pulling in a cookie dep) ---
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production'; // Vercel serves HTTPS
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
  );
}

function isAuthed(req) {
  const cookies = parseCookies(req);
  return verifyToken(cookies[COOKIE_NAME]);
}

// Express middleware: 401 unless the request carries a valid session cookie.
function requireAuth(req, res, next) {
  if (!process.env.SESSION_SECRET) {
    return res.status(500).json({
      error: 'Server misconfigured: SESSION_SECRET is not set.',
    });
  }
  if (!isAuthed(req)) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  next();
}

module.exports = {
  COOKIE_NAME,
  issueToken,
  verifyToken,
  passcodeMatches,
  setSessionCookie,
  clearSessionCookie,
  isAuthed,
  requireAuth,
};
