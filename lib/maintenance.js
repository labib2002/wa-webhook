// Daily maintenance handler for GET /api/cron/maintenance (scheduled by
// vercel.json at 03:00 UTC). Registered in api/index.js BEFORE the passcode
// router; auth is its own, see authorized() below.
//
// Steps (each isolated: one failing step never aborts the others):
//   1) media retention  — bucket objects for messages stored longer than
//      MEDIA_RETENTION_DAYS are removed, rows flip media_status='expired'.
//      Message text, media_meta and conversations are NEVER deleted.
//   2) prune login_attempts rows older than 24h.
//   3) usage measurement — total media bytes (bucket walk, capped at 20k
//      objects) and messages row count.
//   4) usage alert — above 70% of MEDIA_CAP_MB / MESSAGES_CAP_ROWS, send one
//      WhatsApp text to WA_USAGE_ALERT_TO (skipped when unset / below 70%).
//
// Response JSON carries the numbers so the Vercel cron log shows them.

const { getDb, isConfigured: dbConfigured } = require('./db');
const { safeEqual } = require('./auth');
const media = require('./media');
const wa = require('./whatsapp');

const WALK_CAP_OBJECTS = 20000;
const RETENTION_BATCH_ROWS = 500;
const REMOVE_CHUNK = 100;

function envInt(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

// If CRON_SECRET is set, require Vercel's cron header `authorization:
// Bearer <CRON_SECRET>`. Otherwise fall back to the x-service-token gate
// used by /api/service/* (SERVICE_SEND_TOKEN) so the endpoint is never open.
function authorized(req) {
  const cronSecret = process.env.CRON_SECRET || '';
  if (cronSecret) {
    return safeEqual(req.headers.authorization || '', `Bearer ${cronSecret}`);
  }
  const serviceToken = process.env.SERVICE_SEND_TOKEN || '';
  if (!serviceToken) return false;
  return safeEqual(req.headers['x-service-token'] || '', serviceToken);
}

// Remove expired media bytes from the bucket, then mark those rows 'expired'.
// Rows whose removal chunk failed stay 'stored' and are retried next run.
async function expireOldMedia(db, days, errors) {
  const cutoffIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data: rows, error } = await db
    .from('messages')
    .select('id, media_path')
    .not('media_path', 'is', null)
    .eq('media_status', 'stored')
    .lt('created_at', cutoffIso)
    .limit(RETENTION_BATCH_ROWS);
  if (error) throw error;
  if (!rows || !rows.length) return 0;

  // A path can back several rows (forward fallback), so group ids by path.
  const idsByPath = new Map();
  for (const r of rows) {
    if (!r.media_path) continue;
    const list = idsByPath.get(r.media_path) || [];
    list.push(r.id);
    idsByPath.set(r.media_path, list);
  }

  const paths = [...idsByPath.keys()];
  const expiredIds = [];
  for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
    const chunk = paths.slice(i, i + REMOVE_CHUNK);
    const { error: rmErr } = await db.storage.from(media.BUCKET()).remove(chunk);
    if (rmErr) {
      errors.push(`retention remove chunk: ${rmErr.message || rmErr}`);
      continue;
    }
    for (const p of chunk) expiredIds.push(...idsByPath.get(p));
  }
  if (!expiredIds.length) return 0;

  const { error: updErr } = await db
    .from('messages')
    .update({ media_status: 'expired' }) // media_meta kept: bubble says what it was
    .in('id', expiredIds);
  if (updErr) throw updErr;
  return expiredIds.length;
}

async function pruneLoginAttempts(db) {
  const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { error } = await db.from('login_attempts').delete().lt('attempted_at', cutoffIso);
  if (error) throw error;
}

// Storage list() is per-folder (objects live under <wa_id>/<kind>/<file>), so
// walk folders breadth-first, paging 1000 per call, capped at 20k objects.
async function measureMediaBytes(db) {
  const bucket = media.BUCKET();
  const state = { bytes: 0, objects: 0, truncated: false };
  const queue = ['']; // '' = bucket root
  while (queue.length && !state.truncated) {
    const prefix = queue.shift();
    let offset = 0;
    for (;;) {
      const { data, error } = await db.storage.from(bucket).list(prefix, { limit: 1000, offset });
      if (error) throw error;
      if (!data || !data.length) break;
      for (const entry of data) {
        if (!entry.id) {
          // folders come back with id null and no metadata
          queue.push(prefix ? `${prefix}/${entry.name}` : entry.name);
        } else {
          state.objects += 1;
          state.bytes += Number(entry.metadata && entry.metadata.size) || 0;
          if (state.objects >= WALK_CAP_OBJECTS) {
            state.truncated = true;
            break;
          }
        }
      }
      if (state.truncated || data.length < 1000) break;
      offset += data.length;
    }
  }
  return state;
}

async function countMessageRows(db) {
  const { count, error } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true });
  if (error) throw error;
  return count || 0;
}

module.exports = async function maintenance(req, res) {
  if (!authorized(req)) {
    const configured = Boolean(process.env.CRON_SECRET || process.env.SERVICE_SEND_TOKEN);
    return res
      .status(configured ? 401 : 503)
      .json({ error: configured ? 'Unauthorized.' : 'Cron auth is not configured (set CRON_SECRET or SERVICE_SEND_TOKEN).' });
  }

  const errors = [];
  const out = { ok: true, media_expired: 0, media_bytes: null, message_rows: null, alerts: [] };

  if (!dbConfigured()) {
    errors.push('db: not configured');
    return res.json({ ...out, errors });
  }
  const db = getDb();

  // 1) media retention (0 disables)
  const retentionDays = envInt('MEDIA_RETENTION_DAYS', 90);
  if (retentionDays > 0) {
    try {
      out.media_expired = await expireOldMedia(db, retentionDays, errors);
    } catch (e) {
      errors.push(`retention: ${(e && e.message) || e}`);
    }
  }

  // 2) prune login_attempts
  try {
    await pruneLoginAttempts(db);
  } catch (e) {
    errors.push(`login_attempts prune: ${(e && e.message) || e}`);
  }

  // 3) usage measurement
  try {
    const m = await measureMediaBytes(db);
    out.media_bytes = m.bytes;
    if (m.truncated) out.media_bytes_truncated = true; // walk hit the 20k-object cap
  } catch (e) {
    errors.push(`media usage: ${(e && e.message) || e}`);
  }
  try {
    out.message_rows = await countMessageRows(db);
  } catch (e) {
    errors.push(`message count: ${(e && e.message) || e}`);
  }

  // 4) usage alert (one per run, only above 70% of either cap)
  try {
    const capMb = envInt('MEDIA_CAP_MB', 1000);
    const capRows = envInt('MESSAGES_CAP_ROWS', 400000);
    const alertTo = (process.env.WA_USAGE_ALERT_TO || '').replace(/\D/g, '');
    const mediaMb = out.media_bytes == null ? null : Math.round(out.media_bytes / (1024 * 1024));
    const mediaHot = mediaMb != null && capMb > 0 && mediaMb > capMb * 0.7;
    const rowsHot = out.message_rows != null && capRows > 0 && out.message_rows > capRows * 0.7;
    if ((mediaHot || rowsHot) && alertTo) {
      const text = `wa-webhook storage alert: media ${mediaMb == null ? '?' : mediaMb} MB / ${capMb} MB, messages ${out.message_rows == null ? '?' : out.message_rows} / ${capRows}`;
      const sent = await wa.sendText(alertTo, text);
      if (sent.ok) out.alerts.push(text);
      else errors.push(`alert send: ${sent.error}`);
    }
  } catch (e) {
    errors.push(`alert: ${(e && e.message) || e}`);
  }

  out.errors = errors;
  res.json(out);
};
