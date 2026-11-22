// Web Push for the inbox. A new member message reaches every device that
// switched notifications on, even with the inbox closed, which is the only
// way an iPhone gets one: iOS freezes a web app that is not in front.
//
// Off and silent until db/migrations/010_push.sql has run. Nothing here may
// throw into the webhook path: a push that fails is logged and dropped.

const crypto = require('crypto');
const webpush = require('web-push');
const { getDb } = require('./db');
const { makeWarner } = require('./warn');
const phone = require('../web/phone');

// A device stops getting pushes once its inbox session would have expired.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COALESCE_MS = 1500;      // an album arrives as several messages at once
const SEND_TIMEOUT_MS = 8000;
const OFF_RECHECK_MS = 5 * 60 * 1000;
const BODY_MAX = 180;

// The server posts to whatever endpoint a browser hands it, so only the real
// push services are accepted.
const PUSH_HOSTS = [
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
];
const B64URL = /^[A-Za-z0-9_-]+=*$/;

const warnOff = makeWarner('push tables missing, notifications are off');
const warnSend = makeWarner('push send failed');

let keys = null;
let offUntil = 0;
let sender = (sub, payload, opts) => webpush.sendNotification(sub, payload, opts);
const pending = new Map();

function tableMissing(error) {
  return Boolean(error && (error.code === '42P01' || error.code === '3F000'));
}

function noteError(error) {
  if (tableMissing(error)) {
    offUntil = Date.now() + OFF_RECHECK_MS;
    warnOff(error);
  }
}

async function loadKeys(db, origin) {
  if (keys) return keys;
  let { data, error } = await db.from('push_keys').select('*').eq('id', 1).maybeSingle();
  if (error) { noteError(error); return null; }
  if (!data) {
    if (!origin) return null;
    const pair = webpush.generateVAPIDKeys();
    const made = await db.from('push_keys').upsert(
      { id: 1, public_key: pair.publicKey, private_key: pair.privateKey, subject: origin },
      { onConflict: 'id', ignoreDuplicates: true },
    );
    if (made.error) { noteError(made.error); return null; }
    ({ data } = await db.from('push_keys').select('*').eq('id', 1).maybeSingle());
  }
  if (data) keys = data;
  return keys;
}

async function publicKey(origin) {
  try {
    const k = await loadKeys(getDb(), origin);
    return k ? k.public_key : null;
  } catch (_) {
    return null;
  }
}

function checkSubscription(sub) {
  const endpoint = sub && sub.endpoint;
  const k = (sub && sub.keys) || {};
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return null;
  let url;
  try { url = new URL(endpoint); } catch (_) { return null; }
  if (url.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(url.hostname))) return null;
  for (const v of [k.p256dh, k.auth]) {
    if (typeof v !== 'string' || v.length < 16 || v.length > 200 || !B64URL.test(v)) return null;
  }
  return { endpoint, p256dh: k.p256dh, auth: k.auth };
}

async function saveSubscription(sub, userAgent) {
  const row = checkSubscription(sub);
  if (!row) return { status: 400, error: 'Not a push subscription this inbox can use.' };
  const { error } = await getDb().from('push_subscriptions').upsert(
    { ...row, user_agent: String(userAgent || '').slice(0, 200), seen_at: new Date().toISOString() },
    { onConflict: 'endpoint' },
  );
  if (error) { noteError(error); return { status: 503, error: 'Notifications are not switched on yet.' }; }
  return { ok: true };
}

async function removeSubscription(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint) return { ok: true };
  const { error } = await getDb().from('push_subscriptions').delete().eq('endpoint', endpoint);
  if (error) noteError(error);
  return { ok: true };
}

function topicFor(waId) {
  return crypto.createHash('sha256').update(String(waId)).digest('base64url').slice(0, 32);
}

async function deliver(waId, text) {
  let db;
  try { db = getDb(); } catch (_) { return 0; }
  const since = new Date(Date.now() - SESSION_TTL_MS).toISOString();
  const { data: subs, error } = await db
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .gte('seen_at', since);
  if (error) { noteError(error); return 0; }
  if (!subs || !subs.length) return 0;
  const k = await loadKeys(db, null);
  if (!k) return 0;

  const { data: conv } = await db.from('conversations').select('*').eq('wa_id', waId).maybeSingle();
  const { data: unreadRows } = await db.from('conversations').select('unread_count').gt('unread_count', 0);
  const unread = (unreadRows || []).reduce((n, r) => n + (r.unread_count || 0), 0);
  const title = (conv && (conv.display_name || conv.profile_name)) || phone.formatWaId(waId);
  const payload = JSON.stringify({
    title,
    body: String(text || 'New message').slice(0, BODY_MAX),
    wa_id: waId,
    unread,
  });
  const opts = {
    vapidDetails: { subject: k.subject, publicKey: k.public_key, privateKey: k.private_key },
    TTL: 3600,
    urgency: 'high',
    topic: topicFor(waId),
    timeout: SEND_TIMEOUT_MS,
  };

  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, opts);
      sent += 1;
    } catch (e) {
      const status = e && e.statusCode;
      // 404 and 410 mean the device dropped the subscription for good.
      if (status === 404 || status === 410) {
        await db.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
      } else {
        warnSend(status ? `HTTP ${status}` : e);
      }
    }
  }));
  return sent;
}

// Called for every genuinely new inbound message. Returns at once; the push
// goes out a moment later so a burst from one member becomes one notification.
function noteInbound(waId, text) {
  if (!waId || Date.now() < offUntil) return;
  const prev = pending.get(waId);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    pending.delete(waId);
    deliver(waId, text).catch((e) => warnSend(e));
  }, COALESCE_MS);
  if (timer.unref) timer.unref();
  pending.set(waId, timer);
}

function __setSender(fn) { sender = fn; }
function __reset() {
  keys = null;
  offUntil = 0;
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
}

module.exports = {
  publicKey,
  saveSubscription,
  removeSubscription,
  noteInbound,
  deliver,
  checkSubscription,
  COALESCE_MS,
  __setSender,
  __reset,
};
