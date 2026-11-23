// Inbox sessions.
//
// A person signs in with their Byte+ staff account (lib/staff.js). The session
// is a signed, httpOnly cookie that carries who they are; nothing is stored
// server-side. Every /api/* data route runs requireAuth, which verifies the
// cookie and asks lib/staff.js whether the account still has access.

const crypto = require('crypto');
const staff = require('./staff');

const COOKIE_NAME = 'wa_session';
const TOKEN_KIND = 's2';
// A phone stays signed in while it keeps being used: the session is renewed
// once a day, and ends after this long without a visit.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RENEW_EVERY_MS = 24 * 60 * 60 * 1000;
const NOT_SET_UP = 'Sign-in is not set up on this server.';

function secret() {
  return process.env.SESSION_SECRET || '';
}

// Constant-time string compare that won't throw on length mismatch.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('hex');
}

// Token = "s2.<who, base64url>.<hmac>". A cookie from the shared-passcode days
// has another shape and no longer verifies, so everyone signs in once.
function issueToken(who, expires = Date.now() + SESSION_TTL_MS) {
  const body = Buffer.from(JSON.stringify({ a: who.adminId, e: who.email, n: who.name, x: expires })).toString('base64url');
  const payload = `${TOKEN_KIND}.${body}`;
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !secret()) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_KIND) return null;
  if (!safeEqual(parts[2], sign(`${parts[0]}.${parts[1]}`))) return null;
  let who;
  try { who = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (_) { return null; }
  const expires = Number(who && who.x);
  if (!Number.isFinite(expires) || Date.now() > expires) return null;
  if (!Number.isInteger(who.a)) return null;
  return { adminId: who.a, email: String(who.e || ''), name: String(who.n || ''), expires };
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
    if (!k) return;
    try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; }
  });
  return out;
}

function setSessionCookie(res, token, ttlMs = SESSION_TTL_MS) {
  const secure = process.env.NODE_ENV === 'production';
  const maxAge = Math.max(1, Math.floor(ttlMs / 1000));
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

function session(req) {
  return verifyToken(parseCookies(req)[COOKIE_NAME]);
}

// The signed-in person, or null: no cookie, a bad or expired one, or an
// account that has since been removed, deactivated or lost its ops role.
async function current(req) {
  const s = session(req);
  if (!s) return { who: null, ended: false };
  if (!(await staff.stillAllowed(s.adminId))) return { who: null, ended: true };
  return { who: s, ended: false };
}

// Express middleware: 401 unless the request carries a session whose account
// still has access. Sets req.staff = { adminId, email, name }.
async function requireAuth(req, res, next) {
  if (!secret()) return res.status(500).json({ error: NOT_SET_UP });
  let found;
  try {
    found = await current(req);
  } catch (e) {
    return next(e);
  }
  if (found.ended) {
    clearSessionCookie(res);
    return res.status(401).json({ error: staff.SENTENCES.ended, ended: true });
  }
  if (!found.who) return res.status(401).json({ error: 'Not authenticated.' });
  req.staff = found.who;
  if (found.who.expires - Date.now() < SESSION_TTL_MS - RENEW_EVERY_MS) {
    setSessionCookie(res, issueToken(found.who));
  }
  next();
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_MS,
  NOT_SET_UP,
  safeEqual,
  issueToken,
  verifyToken,
  setSessionCookie,
  clearSessionCookie,
  current,
  requireAuth,
};
