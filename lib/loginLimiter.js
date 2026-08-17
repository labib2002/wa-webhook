// Durable rate limiter for POST /api/login, backed by the login_attempts
// table (db/schema.sql).
//
// Policy, enforced BEFORE the passcode is compared:
//   - per IP:  >= 5 failed attempts in the last 15 minutes  -> 429
//   - global:  >= 50 failed attempts across ALL IPs in 15m  -> 429
//     (backstop against distributed guessing)
// Every compared attempt is recorded (success and failure); a successful
// login deletes that IP's failed rows so the counter resets. Rows older than
// 24h are pruned by the daily maintenance cron.
//
// Graceful fallback: if the DB is unreachable, an in-process Map enforces the
// same policy. It guarantees login never 500s because the limiter broke. The
// process is long-lived and single-fork, so that Map now survives across
// requests rather than resetting on every cold start.

const { getDb, isConfigured } = require('./db');
const { makeWarner } = require('./warn');

const WINDOW_MS = 15 * 60 * 1000;
const PER_IP_MAX_FAILS = 5;
const GLOBAL_MAX_FAILS = 50;

// ---- in-memory fallback state (per instance) ----
const memFails = new Map(); // ip -> [failure timestamps, ms]

const noteFallback = makeWarner('login limiter: DB unavailable, using in-memory fallback');

// The ALB's xff_header_processing mode is `append`: it appends the real peer
// and leaves any client-supplied header in place, so the FIRST entry is
// attacker-controlled and the per-IP limit would be trivially evadable. The
// last entry is the one the ALB itself wrote.
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function memPrune(now) {
  for (const [ip, arr] of memFails) {
    const keep = arr.filter((t) => now - t < WINDOW_MS);
    if (keep.length) memFails.set(ip, keep);
    else memFails.delete(ip);
  }
}

function memIsLimited(ip) {
  const now = Date.now();
  memPrune(now);
  let total = 0;
  for (const arr of memFails.values()) total += arr.length;
  if (total >= GLOBAL_MAX_FAILS) return true;
  return (memFails.get(ip) || []).length >= PER_IP_MAX_FAILS;
}

function memRecord(ip, success) {
  if (success) {
    memFails.delete(ip);
    return;
  }
  const arr = memFails.get(ip) || [];
  arr.push(Date.now());
  memFails.set(ip, arr);
}

// True -> answer 429 without comparing the passcode. Never throws.
async function isLimited(ip) {
  try {
    if (!isConfigured()) throw new Error('DB not configured');
    const db = getDb();
    const sinceIso = new Date(Date.now() - WINDOW_MS).toISOString();

    const global = await db
      .from('login_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('success', false)
      .gte('attempted_at', sinceIso);
    if (global.error) throw global.error;
    if ((global.count || 0) >= GLOBAL_MAX_FAILS) return true;

    const perIp = await db
      .from('login_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('ip', ip)
      .eq('success', false)
      .gte('attempted_at', sinceIso);
    if (perIp.error) throw perIp.error;
    return (perIp.count || 0) >= PER_IP_MAX_FAILS;
  } catch (e) {
    noteFallback(e);
    return memIsLimited(ip);
  }
}

// Record the outcome of a compared passcode. Never throws.
async function recordAttempt(ip, success) {
  try {
    if (!isConfigured()) throw new Error('DB not configured');
    const db = getDb();
    const { error } = await db.from('login_attempts').insert({ ip, success });
    if (error) throw error;
    if (success) {
      // Reset the counter; a failed delete is harmless (rows age out anyway).
      await db.from('login_attempts').delete().eq('ip', ip).eq('success', false);
    }
  } catch (e) {
    noteFallback(e);
    memRecord(ip, success);
  }
}

module.exports = { clientIp, isLimited, recordAttempt };
