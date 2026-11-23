// Byte+ staff accounts.
//
// Sign-in is checked by the backend's own admin login, server to server, so
// the passwords, their hashes and the backend's limits stay in one place. The
// inbox keeps neither the password nor the backend's token.
//
// After sign-in, wa_lookup.staff() (db/migrations/013_staff_signin.sql) says
// whether the account is still active and still has an ops role, so removing
// a person ends their inbox session within RECHECK_MS.

const db = require('./db');
const { makeWarner } = require('./warn');

const ROLES = ['ops', 'super_admin'];
const TIMEOUT_MS = 8000;
const RECHECK_MS = 3 * 60 * 1000;
const RETRY_MS = 30 * 1000;
const NAME_MAX = 40;
const FIELD_MAX = 200;

const SENTENCES = {
  missing: 'Enter your email and password.',
  wrong: 'That email or password is not right.',
  role: 'This account cannot open the inbox. It needs the ops role on the ops dashboard.',
  limited: 'Too many tries. Wait 15 minutes, then try again.',
  down: 'Could not check your account just now. Try again in a minute.',
  ended: 'Your account no longer has access to the inbox.',
};

const warnDown = makeWarner('staff sign-in: the backend did not answer');
const warnLookup = makeWarner('staff lookup unavailable, signed-in sessions are kept as they are');

let fetchImpl = (...args) => fetch(...args);

function base() {
  return (process.env.BACKEND_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
}

// The backend takes the caller's address from the proxy hops it trusts (the
// load balancer, one hop). The inbox calls it directly, so it writes the
// agent's address where the backend looks: otherwise every inbox sign-in
// would count against one address in the backend's login limit. One value is
// read as the caller whether the backend trusts one hop or two; padding is
// only for a backend that sits behind more proxies than that.
function forwardedFor(ip) {
  const hops = Math.max(1, Number(process.env.BACKEND_PROXY_HOPS) || 1);
  const clean = String(ip || '').replace(/[^0-9a-fA-F.:]/g, '') || '127.0.0.1';
  return [clean, ...Array(hops - 1).fill('127.0.0.1')].join(', ');
}

async function call(path, { method = 'GET', body, token, ip }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${base()}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-byteplus-client': 'inbox',
        'x-forwarded-for': forwardedFor(ip),
        ...(token ? { 'x-admin-access-token': token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* no body */ }
    return { status: res.status, data: (json && json.data) || null };
  } finally {
    clearTimeout(timer);
  }
}

// A staff picture as the dashboards store it ({ url, backgroundColor }), or
// null. Only an https link is passed on to the browser.
function pictureOf(value) {
  let v = value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { return null; } }
  if (!v || typeof v !== 'object' || typeof v.url !== 'string' || !/^https:\/\//i.test(v.url) || v.url.length > 1000) return null;
  const bg = typeof v.backgroundColor === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v.backgroundColor) ? v.backgroundColor : null;
  return { url: v.url, backgroundColor: bg };
}

function displayName(admin, email) {
  const [first, last] = [admin.first_name, admin.last_name].map((v) => String(v || '').trim());
  // Some accounts were made with the first name typed into both fields.
  const full = [first, last && last.toLowerCase() !== first.toLowerCase() ? last : ''].filter(Boolean).join(' ');
  return (full || String(email).split('@')[0]).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

// -> { ok: true, staff: { adminId, email, name, role } } or { ok: false, why }
async function signIn(email, password, ip) {
  const mail = typeof email === 'string' ? email.trim() : '';
  if (!mail || typeof password !== 'string' || !password || mail.length > FIELD_MAX || password.length > FIELD_MAX) {
    return { ok: false, why: 'missing' };
  }
  let login;
  let me;
  try {
    login = await call('/api/auth/v1/admins/login', { method: 'POST', body: { email: mail, password }, ip });
    if (login.status === 429) return { ok: false, why: 'limited' };
    if (login.status === 400 || login.status === 401) return { ok: false, why: 'wrong' };
    const token = login.data && login.data.accessToken;
    const admin = login.data && login.data.adminData;
    if (login.status !== 200 || !token || !admin || admin.admin_id == null) throw new Error(`login answered ${login.status}`);

    me = await call('/api/ops/v1/me', { token, ip });
    if (me.status === 403) return { ok: false, why: 'role' };
    if (me.status === 429) return { ok: false, why: 'limited' };
    if (me.status !== 200 || !me.data) throw new Error(`me answered ${me.status}`);
    const role = me.data.opsRole;
    if (!ROLES.includes(role)) return { ok: false, why: 'role' };

    const adminId = Number(admin.admin_id);
    const image = pictureOf(admin.image) || pictureOf(me.data.admin && me.data.admin.image);
    seen.set(adminId, { at: Date.now(), ok: true, image });
    return { ok: true, staff: { adminId, email: String(admin.email || mail), name: displayName(admin, mail), role, image } };
  } catch (e) {
    warnDown(e);
    return { ok: false, why: 'down' };
  }
}

async function sqlLookup(adminId) {
  const { rows } = await db.raw('SELECT * FROM wa_lookup.staff($1::int)', [adminId]);
  return rows[0] || null;
}
let lookupImpl = sqlLookup;

const seen = new Map();
const asking = new Map();

async function ask(adminId) {
  const before = seen.get(adminId);
  try {
    const row = await lookupImpl(adminId);
    const ok = Boolean(row && row.active && ROLES.includes(row.role));
    const image = row && Object.prototype.hasOwnProperty.call(row, 'image') ? pictureOf(row.image) : (before ? before.image : null);
    seen.set(adminId, { at: Date.now(), ok, image: image || null });
    return ok;
  } catch (e) {
    // Not answered is not the same as removed: nobody is thrown out because
    // the lookup is missing or the database blinked.
    warnLookup(e);
    const ok = before ? before.ok : true;
    seen.set(adminId, { at: Date.now() - RECHECK_MS + RETRY_MS, ok, image: before ? before.image : null });
    return ok;
  }
}

// Is this account still active with an ops role? Asked at most once every
// RECHECK_MS per account.
async function stillAllowed(adminId) {
  const id = Number(adminId);
  if (!Number.isInteger(id)) return false;
  const hit = seen.get(id);
  if (hit && Date.now() - hit.at < RECHECK_MS) return hit.ok;
  if (!asking.has(id)) asking.set(id, ask(id).finally(() => asking.delete(id)));
  return asking.get(id);
}

// The signed-in person's picture as last read at sign-in or on the re-check.
function imageOf(adminId) {
  const hit = seen.get(Number(adminId));
  return (hit && hit.image) || null;
}

function __setBackendForTesting(fn) { fetchImpl = fn || ((...args) => fetch(...args)); }
function __setLookupForTesting(fn) { lookupImpl = fn || sqlLookup; seen.clear(); }
function __forget() { seen.clear(); }

module.exports = {
  ROLES,
  SENTENCES,
  RECHECK_MS,
  signIn,
  stillAllowed,
  imageOf,
  pictureOf,
  forwardedFor,
  __setBackendForTesting,
  __setLookupForTesting,
  __forget,
};
