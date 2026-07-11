// Dashboard JSON API. Every route here (except /api/login and /api/session)
// is behind requireAuth — the passcode gate is enforced server-side, not just
// by hiding UI.

const express = require('express');
const auth = require('./auth');
const limiter = require('./loginLimiter');
const idem = require('./idempotency');
const { getDb, isConfigured: dbConfigured } = require('./db');
const wa = require('./whatsapp');
const media = require('./media');
const transcode = require('./transcode');

const router = express.Router();

// --- auth endpoints (public) ---

// Tells the browser whether it already has a valid session (so the SPA can
// skip the login screen on reload) and whether sending is configured.
router.get('/session', (req, res) => {
  res.json({
    authed: auth.isAuthed(req),
    sendConfigured: wa.isConfigured(),
    dbConfigured: dbConfigured(),
  });
});

router.post('/login', async (req, res) => {
  if (!process.env.SESSION_SECRET) {
    return res.status(500).json({ error: 'Server misconfigured: SESSION_SECRET is not set.' });
  }
  if (!process.env.DASHBOARD_PASSCODE) {
    return res.status(500).json({ error: 'Server misconfigured: DASHBOARD_PASSCODE is not set.' });
  }
  // Rate limit BEFORE comparing the passcode (per-IP + global backstop).
  const ip = limiter.clientIp(req);
  if (await limiter.isLimited(ip)) {
    return res.status(429).json({ error: 'too many attempts, try later' });
  }
  const { passcode } = req.body || {};
  const matched = auth.passcodeMatches(passcode);
  // Awaited: on serverless a fire-and-forget write can be frozen and lost.
  await limiter.recordAttempt(ip, matched);
  if (!matched) {
    return res.status(401).json({ error: 'Incorrect passcode.' });
  }
  auth.setSessionCookie(res, auth.issueToken());
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// --- everything below requires a valid session ---
router.use(auth.requireAuth);

// Small helper to turn a thrown DB-not-configured error into a clean 503.
function handleDbError(res, e) {
  if (e && e.code === 'DB_NOT_CONFIGURED') {
    return res.status(503).json({ error: e.message, code: 'DB_NOT_CONFIGURED' });
  }
  console.error('API DB error:', e);
  return res.status(500).json({ error: 'Database error.' });
}

// GET /api/conversations -> list for the left pane, most recent first.
router.get('/conversations', async (req, res) => {
  try {
    const db = getDb();
    const { data, error } = await db
      .from('conversations')
      .select('wa_id, profile_name, last_message_text, last_message_at, last_message_direction, unread_count')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(200);
    if (error) throw error;
    res.json({ conversations: data || [] });
  } catch (e) {
    handleDbError(res, e);
  }
});

// GET /api/messages?wa_id=...&after=<id>  -> thread (optionally only new rows).
router.get('/messages', async (req, res) => {
  const wa_id = (req.query.wa_id || '').toString();
  if (!wa_id) return res.status(400).json({ error: 'wa_id is required.' });
  // `since` (ISO timestamp) drives the incremental poll: it returns every row
  // CHANGED since then — new messages AND edits to existing ones (reactions,
  // status ticks). Without it, the full thread loads.
  const since = req.query.since ? String(req.query.since) : null;
  try {
    const db = getDb();
    // `forwarded` (migration 006) is optional; `updated_at` (migration 005) is
    // optional too. We tolerate either column not existing yet so a deploy that
    // precedes a migration still serves threads — it just won't carry that
    // column until migrated, then lights up automatically. The query is retried
    // with whichever column the error names stripped out.
    const baseCols = ['id', 'wa_message_id', 'wa_id', 'direction', 'type', 'body', 'media_meta', 'media_status', 'reaction', 'forwarded', 'status', 'error', 'wa_timestamp', 'created_at', 'updated_at'];

    async function runQuery(cols) {
      let q = db.from('messages').select(cols.join(', ')).eq('wa_id', wa_id);
      if (since) {
        // Incremental poll relies on updated_at; if it's been stripped we can't
        // detect changes, so signal the caller to return an empty batch.
        if (!cols.includes('updated_at')) return { noSince: true };
        q = q.gt('updated_at', since).order('updated_at', { ascending: true }).limit(500);
      } else {
        q = q.order('created_at', { ascending: true }).order('id', { ascending: true }).limit(500);
      }
      return q;
    }

    let cols = baseCols.slice();
    let { data, error, noSince } = await runQuery(cols);
    // Retry up to twice, dropping whichever optional column the error names.
    for (let i = 0; i < 2 && error; i++) {
      const msg = error.message || '';
      const drop = /forwarded/.test(msg) ? 'forwarded' : /updated_at/.test(msg) ? 'updated_at' : null;
      if (!drop) break;
      cols = cols.filter((c) => c !== drop);
      ({ data, error, noSince } = await runQuery(cols));
    }
    if (noSince) { res.json({ messages: [] }); return; } // no updated_at: can't detect changes yet
    if (error) throw error;
    res.json({ messages: data || [] });
  } catch (e) {
    handleDbError(res, e);
  }
});

// GET /api/media/:id  -> short-lived signed URL for a stored media object.
// :id is the internal message id. We redirect to the signed URL so the browser
// can use it directly in <img>/<video>/<aud> tags or links.
router.get('/media/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id.' });
  try {
    const db = getDb();
    const { data: row, error } = await db
      .from('messages')
      .select('media_path, media_status')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ error: 'Message not found.' });
    if (row.media_status !== 'stored' || !row.media_path) {
      return res.status(409).json({ error: 'Media not available.', media_status: row.media_status });
    }
    const url = await media.signedUrl(row.media_path, 600);
    // 302 to the signed URL keeps the token off our origin and lets the browser
    // cache the bytes from Supabase directly.
    res.redirect(302, url);
  } catch (e) {
    handleDbError(res, e);
  }
});

// POST /api/send  { wa_id, text }  -> Graph API call + persist outgoing row.
// Optional idempotency: x-idempotency-key header (or body.client_key). With a
// key we reserve a pending row BEFORE calling Meta so a duplicated request
// can never double-send (see lib/idempotency.js). Keyless requests are
// untouched: send first, persist after.
router.post('/send', async (req, res) => {
  const { wa_id, text } = req.body || {};
  const body = (text || '').toString().trim();
  if (!wa_id) return res.status(400).json({ error: 'wa_id is required.' });
  if (!body) return res.status(400).json({ error: 'Message text is empty.' });
  if (body.length > 4096) return res.status(400).json({ error: 'Message too long (max 4096 characters).' });

  const { key, invalid } = idem.keyFromRequest(req);
  if (invalid) return res.status(400).json({ error: invalid });

  if (key && dbConfigured()) {
    const db = getDb();
    const found = await idem.findByKey(db, key);
    if (found.row) {
      return res.json({ ok: true, deduped: true, id: found.row.id, message: found.row });
    }
    if (!found.skip) {
      const nowIso = new Date().toISOString();
      // Conversation first (messages FK to it); the preview is set post-send.
      await db.from('conversations').upsert({ wa_id }, { onConflict: 'wa_id' });
      const r = await idem.reserve(db, key, {
        wa_id,
        direction: 'out',
        type: 'text',
        body,
        wa_timestamp: nowIso,
      });
      if (r.existing) {
        return res.json({ ok: true, deduped: true, id: r.existing.id, message: r.existing });
      }
      if (r.conflict) {
        return res.status(409).json({ error: 'Duplicate request already in flight.' });
      }
      if (r.row) {
        const result = await wa.sendText(wa_id, body);
        if (!result.ok) {
          // Leave a retryable failed row (POST /api/retry/:id resends it).
          await db.from('messages')
            .update({ status: 'failed', error: result.error })
            .eq('id', r.row.id);
          return res.status(502).json({ error: result.error });
        }
        await db.from('conversations').upsert(
          { wa_id, last_message_text: body, last_message_at: nowIso, last_message_direction: 'out' },
          { onConflict: 'wa_id' }
        );
        const upd = await db.from('messages')
          .update({ wa_message_id: result.waMessageId || null, status: 'sent', error: null })
          .eq('id', r.row.id)
          .select()
          .single();
        if (upd.error) {
          console.error('Send persisted-failed:', upd.error);
          return res.status(207).json({
            warning: 'Message sent but could not be saved. It may reappear after refresh.',
            waMessageId: result.waMessageId || null,
          });
        }
        return res.json({ message: upd.data });
      }
      // r.skip -> degrade to the keyless flow below.
    }
    // found.skip -> degrade to the keyless flow below.
  }

  // Fire the WhatsApp call first; only persist if it was accepted.
  const result = await wa.sendText(wa_id, body);
  if (!result.ok) {
    return res.status(502).json({ error: result.error });
  }

  // Persist the outgoing message + update the conversation preview.
  try {
    const db = getDb();
    const nowIso = new Date().toISOString();

    // Conversation first — messages FK to it (the row normally already exists,
    // but this keeps the insert safe even for a brand-new recipient).
    await db
      .from('conversations')
      .upsert(
        {
          wa_id,
          last_message_text: body,
          last_message_at: nowIso,
          last_message_direction: 'out',
        },
        { onConflict: 'wa_id' }
      );

    const { data, error } = await db
      .from('messages')
      .insert({
        wa_message_id: result.waMessageId || null,
        wa_id,
        direction: 'out',
        type: 'text',
        body,
        status: 'sent',
        wa_timestamp: nowIso,
      })
      .select()
      .single();
    if (error) throw error;

    res.json({ message: data });
  } catch (e) {
    // The message DID send (WhatsApp accepted it) but we failed to persist.
    // Tell the client so it can reconcile rather than show a false failure.
    console.error('Send persisted-failed:', e);
    res.status(207).json({
      warning: 'Message sent but could not be saved. It may reappear after refresh.',
      waMessageId: result.waMessageId || null,
    });
  }
});

// POST /api/send-media  { wa_id, file_base64, mime, filename, caption }
// Uploads the file to WhatsApp, sends it, stores a copy in our bucket so it
// renders in our own thread, and persists the outgoing row.
router.post('/send-media', async (req, res) => {
  const { wa_id, file_base64, mime, filename, caption, voice } = req.body || {};
  if (!wa_id) return res.status(400).json({ error: 'wa_id is required.' });
  if (!file_base64) return res.status(400).json({ error: 'No file provided.' });

  let buffer;
  try {
    buffer = Buffer.from(file_base64, 'base64');
  } catch (_) {
    return res.status(400).json({ error: 'Invalid file encoding.' });
  }
  // WhatsApp media ceiling is generous; cap to keep our function memory sane.
  if (buffer.length > 25 * 1024 * 1024) {
    return res.status(400).json({ error: 'File too large (max 25 MB).' });
  }

  const category = wa.mediaCategory(mime);

  // For recorded VOICE notes, transcode to OGG/Opus first. Browser MediaRecorder
  // output (fragmented MP4 / webm) uploads OK but then fails async during
  // delivery; OGG/Opus actually delivers. Only voice audio is transcoded —
  // genuinely uploaded media files are sent as-is.
  let uploadBuffer = buffer;
  let uploadMime = mime;
  let uploadFilename = filename;
  let storeExt = media.extFromMime(mime);
  if (voice && category === 'audio') {
    const srcExt = media.extFromMime(mime);
    const tr = await transcode.toOggOpus(buffer, srcExt);
    if (!tr.ok) return res.status(502).json({ error: tr.error });
    uploadBuffer = tr.buffer;
    uploadMime = tr.mime;             // audio/ogg
    uploadFilename = 'voice-note.ogg';
    storeExt = tr.ext;               // ogg
  }

  const labelMap = { image: '📷 Image', video: '🎬 Video', audio: '🎵 Audio', document: '📄 Document' };
  const baseLabel = (voice && category === 'audio') ? '🎤 Voice message' : labelMap[category];
  const preview = caption ? `${baseLabel} · ${caption}` : baseLabel;
  const mediaMeta = { filename: uploadFilename || null, mime_type: uploadMime || null, caption: caption || null, voice: (voice && category === 'audio') || null };

  // Optional idempotency (same reservation flow as /api/send): with a key we
  // reserve a pending row and store our bucket copy BEFORE the Meta calls, so
  // a duplicated request never re-sends and a failed send stays retryable.
  const { key, invalid } = idem.keyFromRequest(req);
  if (invalid) return res.status(400).json({ error: invalid });

  if (key && dbConfigured()) {
    const db = getDb();
    const found = await idem.findByKey(db, key);
    if (found.row) {
      return res.json({ ok: true, deduped: true, id: found.row.id, message: found.row });
    }
    if (!found.skip) {
      const nowIso = new Date().toISOString();
      await db.from('conversations').upsert({ wa_id }, { onConflict: 'wa_id' });
      const r = await idem.reserve(db, key, {
        wa_id,
        direction: 'out',
        type: category,
        body: preview,
        media_meta: mediaMeta,
        wa_timestamp: nowIso,
      });
      if (r.existing) {
        return res.json({ ok: true, deduped: true, id: r.existing.id, message: r.existing });
      }
      if (r.conflict) {
        return res.status(409).json({ error: 'Duplicate request already in flight.' });
      }
      if (r.row) {
        // Bucket copy first, named by row id (no wa_message_id yet), so the
        // bubble renders and a failed send can be retried from stored bytes.
        let media_path = null;
        let media_status = 'failed';
        try {
          const safeWa = String(wa_id).replace(/[^0-9]/g, '') || 'unknown';
          const path = `${safeWa}/out/k${r.row.id}.${storeExt}`;
          const { error: upErr } = await db.storage
            .from(media.BUCKET())
            .upload(path, uploadBuffer, { contentType: uploadMime || 'application/octet-stream', upsert: true });
          if (!upErr) { media_path = path; media_status = 'stored'; }
        } catch (_) { /* non-fatal: bubble falls back to placeholder */ }

        const upK = await wa.uploadMedia(uploadBuffer, uploadMime, uploadFilename);
        if (!upK.ok) {
          await db.from('messages')
            .update({ status: 'failed', error: upK.error, media_path, media_status })
            .eq('id', r.row.id);
          return res.status(502).json({ error: upK.error });
        }
        const sentK = await wa.sendMedia(wa_id, category, upK.mediaId, { caption, filename: uploadFilename });
        if (!sentK.ok) {
          await db.from('messages')
            .update({ status: 'failed', error: sentK.error, media_path, media_status })
            .eq('id', r.row.id);
          return res.status(502).json({ error: sentK.error });
        }
        await db.from('conversations').upsert(
          { wa_id, last_message_text: preview, last_message_at: nowIso, last_message_direction: 'out' },
          { onConflict: 'wa_id' }
        );
        const upd = await db.from('messages')
          .update({ wa_message_id: sentK.waMessageId || null, status: 'sent', error: null, media_path, media_status })
          .eq('id', r.row.id)
          .select()
          .single();
        if (upd.error) {
          console.error('send-media persist failed:', upd.error);
          return res.status(207).json({ warning: 'Media sent but could not be saved.', waMessageId: sentK.waMessageId || null });
        }
        return res.json({ message: upd.data });
      }
      // r.skip -> degrade to the keyless flow below.
    }
    // found.skip -> degrade to the keyless flow below.
  }

  // 1) upload bytes to WhatsApp -> media id
  const up = await wa.uploadMedia(uploadBuffer, uploadMime, uploadFilename);
  if (!up.ok) return res.status(502).json({ error: up.error });

  // 2) send the media message
  const sent = await wa.sendMedia(wa_id, category, up.mediaId, { caption, filename: uploadFilename });
  if (!sent.ok) return res.status(502).json({ error: sent.error });

  // 3) persist (conversation + message) and store a copy for our own thread view
  try {
    const db = getDb();
    const nowIso = new Date().toISOString();

    await db.from('conversations').upsert(
      { wa_id, last_message_text: preview, last_message_at: nowIso, last_message_direction: 'out' },
      { onConflict: 'wa_id' }
    );

    // Store our copy in the bucket so the outgoing bubble can render it. For
    // voice notes this is the transcoded OGG, so the dashboard player matches
    // what was actually delivered.
    let media_path = null;
    let media_status = 'failed';
    try {
      const safeWa = String(wa_id).replace(/[^0-9]/g, '') || 'unknown';
      const path = `${safeWa}/out/${(sent.waMessageId || 'msg').replace(/[^a-zA-Z0-9]/g, '')}.${storeExt}`;
      const { error: upErr } = await db.storage
        .from(media.BUCKET())
        .upload(path, uploadBuffer, { contentType: uploadMime || 'application/octet-stream', upsert: true });
      if (!upErr) { media_path = path; media_status = 'stored'; }
    } catch (_) { /* non-fatal: bubble falls back to placeholder */ }

    const { data, error } = await db
      .from('messages')
      .insert({
        wa_message_id: sent.waMessageId || null,
        wa_id,
        direction: 'out',
        type: category,
        body: preview,
        media_meta: mediaMeta,
        media_path,
        media_status,
        status: 'sent',
        wa_timestamp: nowIso,
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ message: data });
  } catch (e) {
    console.error('send-media persist failed:', e);
    res.status(207).json({ warning: 'Media sent but could not be saved.', waMessageId: sent.waMessageId || null });
  }
});

// POST /api/retry/:id  -> re-attempt sending a previously-FAILED outgoing row.
// Used when the message reached our server (so a row exists) but WhatsApp
// rejected it or it later flipped to failed via the status webhook. Re-sends
// from the stored copy; on success flips the SAME row back to sent (new
// wa_message_id, error cleared) — no duplicate row.
router.post('/retry/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id.' });
  try {
    const db = getDb();
    const { data: row, error } = await db
      .from('messages')
      .select('id, wa_id, direction, type, body, media_meta, media_path, media_status')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ error: 'Message not found.' });
    if (row.direction !== 'out') return res.status(400).json({ error: 'Only outgoing messages can be retried.' });

    let sent;
    if (row.type === 'text') {
      sent = await wa.sendText(row.wa_id, row.body || '');
    } else {
      // media: re-upload the stored bucket copy, then re-send
      if (!row.media_path) return res.status(400).json({ error: 'No stored media to resend.' });
      const dl = await db.storage.from(media.BUCKET()).download(row.media_path);
      if (dl.error || !dl.data) return res.status(502).json({ error: 'Could not read stored media to resend.' });
      const buf = Buffer.from(await dl.data.arrayBuffer());
      const mm = row.media_meta || {};
      const upMime = mm.mime_type || 'application/octet-stream';
      const category = wa.mediaCategory(upMime);
      const up = await wa.uploadMedia(buf, upMime, mm.filename || 'file');
      if (!up.ok) return res.status(502).json({ error: up.error });
      sent = await wa.sendMedia(row.wa_id, category, up.mediaId, { caption: mm.caption || '', filename: mm.filename });
    }
    if (!sent.ok) return res.status(502).json({ error: sent.error });

    const { data: updated, error: upErr } = await db
      .from('messages')
      .update({ wa_message_id: sent.waMessageId || null, status: 'sent', error: null })
      .eq('id', id)
      .select()
      .single();
    if (upErr) throw upErr;
    res.json({ message: updated });
  } catch (e) {
    handleDbError(res, e);
  }
});

// POST /api/start-conversation  { wa_id, name? }
// Create (or surface) a conversation row so the agent can message a number
// that hasn't written in yet. Sending still respects the 24h window.
router.post('/start-conversation', async (req, res) => {
  let { wa_id, name } = req.body || {};
  wa_id = (wa_id || '').toString().replace(/[^0-9]/g, ''); // normalize to digits (E.164 without +)
  if (wa_id.length < 8) return res.status(400).json({ error: 'Enter a valid phone number with country code.' });
  try {
    const db = getDb();
    const { data: existing } = await db
      .from('conversations').select('wa_id').eq('wa_id', wa_id).maybeSingle();
    if (!existing) {
      const row = { wa_id, last_message_at: new Date().toISOString(), unread_count: 0 };
      if (name && name.trim()) row.profile_name = name.trim();
      const { error } = await db.from('conversations').upsert(row, { onConflict: 'wa_id' });
      if (error) throw error;
    }
    res.json({ wa_id, created: !existing });
  } catch (e) {
    handleDbError(res, e);
  }
});

// POST /api/mark-read  { wa_id }  -> reset unread; optionally blue-tick the
// sender via WhatsApp's mark-as-read on the latest inbound message.
router.post('/mark-read', async (req, res) => {
  const { wa_id } = req.body || {};
  if (!wa_id) return res.status(400).json({ error: 'wa_id is required.' });
  try {
    const db = getDb();
    await db.from('conversations').update({ unread_count: 0 }).eq('wa_id', wa_id);

    // Best-effort blue ticks: find the most recent inbound message id.
    const { data: lastIn } = await db
      .from('messages')
      .select('wa_message_id')
      .eq('wa_id', wa_id)
      .eq('direction', 'in')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastIn && lastIn.wa_message_id) {
      // Don't await failures into the response path.
      wa.markRead(lastIn.wa_message_id).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) {
    handleDbError(res, e);
  }
});

// Insert a forwarded outgoing row, tolerating the `forwarded` column not
// existing yet (migration 006): on a column-missing error we retry the insert
// without it, so forwarding still works pre-migration — just without the tag.
async function insertForwardedMessage(db, row) {
  let { data, error } = await db.from('messages').insert(row).select().single();
  if (error && /forwarded/.test(error.message || '')) {
    const { forwarded, ...rest } = row;
    ({ data, error } = await db.from('messages').insert(rest).select().single());
  }
  if (error) throw error;
  return data;
}

// Forward one source message to one destination wa_id. Re-sends through the
// existing WhatsApp helpers (text → sendText; media → re-upload the stored
// bucket copy → sendMedia) and persists a forwarded outgoing row. Returns
// { ok, wa_id, message } or { ok:false, wa_id, error }.
async function forwardToDestination(db, src, dest) {
  const nowIso = new Date().toISOString();

  if (src.type === 'text' || !src.type) {
    const sent = await wa.sendText(dest, src.body || '');
    if (!sent.ok) return { ok: false, wa_id: dest, error: sent.error };

    await db.from('conversations').upsert(
      { wa_id: dest, last_message_text: src.body || '', last_message_at: nowIso, last_message_direction: 'out' },
      { onConflict: 'wa_id' }
    );
    const message = await insertForwardedMessage(db, {
      wa_message_id: sent.waMessageId || null,
      wa_id: dest, direction: 'out', type: 'text', body: src.body || '',
      forwarded: true, status: 'sent', wa_timestamp: nowIso,
    });
    return { ok: true, wa_id: dest, message };
  }

  // Media: re-upload the stored bucket copy (mirrors /api/retry), carrying the
  // original mime + caption + voice flag so it renders the same on our side.
  if (!src.media_path || src.media_status !== 'stored') {
    return { ok: false, wa_id: dest, error: 'This message has no stored media to forward.' };
  }
  const dl = await db.storage.from(media.BUCKET()).download(src.media_path);
  if (dl.error || !dl.data) return { ok: false, wa_id: dest, error: 'Could not read stored media to forward.' };
  const buf = Buffer.from(await dl.data.arrayBuffer());
  const mm = src.media_meta || {};
  const upMime = mm.mime_type || 'application/octet-stream';
  const category = wa.mediaCategory(upMime);
  const up = await wa.uploadMedia(buf, upMime, mm.filename || 'file');
  if (!up.ok) return { ok: false, wa_id: dest, error: up.error };
  const sent = await wa.sendMedia(dest, category, up.mediaId, { caption: mm.caption || '', filename: mm.filename });
  if (!sent.ok) return { ok: false, wa_id: dest, error: sent.error };

  // Copy our bucket object to a destination-namespaced path so the forwarded
  // bubble renders without re-fetching from WhatsApp.
  let media_path = src.media_path;
  let media_status = 'stored';
  try {
    const safeWa = String(dest).replace(/[^0-9]/g, '') || 'unknown';
    const storeExt = media.extFromMime(upMime);
    const path = `${safeWa}/out/${(sent.waMessageId || 'msg').replace(/[^a-zA-Z0-9]/g, '')}.${storeExt}`;
    const { error: upErr } = await db.storage
      .from(media.BUCKET())
      .upload(path, buf, { contentType: upMime, upsert: true });
    if (!upErr) media_path = path;
  } catch (_) { /* non-fatal: fall back to the source path */ }

  await db.from('conversations').upsert(
    { wa_id: dest, last_message_text: src.body || '', last_message_at: nowIso, last_message_direction: 'out' },
    { onConflict: 'wa_id' }
  );
  const message = await insertForwardedMessage(db, {
    wa_message_id: sent.waMessageId || null,
    wa_id: dest, direction: 'out', type: src.type, body: src.body || '',
    media_meta: mm, media_path, media_status,
    forwarded: true, status: 'sent', wa_timestamp: nowIso,
  });
  return { ok: true, wa_id: dest, message };
}

// POST /api/forward  { message_id, wa_ids: [...] }
// Forward an existing message to one or more existing conversations. Each
// destination is a fresh OUTGOING message from the business number (not an
// impersonation of the original sender), marked forwarded. Per-destination
// failures (e.g. a closed 24h window) are reported back individually.
router.post('/forward', async (req, res) => {
  const { message_id, wa_ids } = req.body || {};
  const srcId = Number(message_id);
  if (!Number.isFinite(srcId)) return res.status(400).json({ error: 'message_id is required.' });
  const dests = Array.isArray(wa_ids) ? [...new Set(wa_ids.map((w) => String(w || '').trim()).filter(Boolean))] : [];
  if (!dests.length) return res.status(400).json({ error: 'Choose at least one destination.' });

  try {
    const db = getDb();
    const { data: src, error } = await db
      .from('messages')
      .select('id, wa_id, direction, type, body, media_meta, media_path, media_status')
      .eq('id', srcId)
      .maybeSingle();
    if (error) throw error;
    if (!src) return res.status(404).json({ error: 'Message not found.' });
    // Only stored media can be forwarded; surface a clear error before sending.
    if (src.type && src.type !== 'text' && (src.media_status !== 'stored' || !src.media_path)) {
      return res.status(409).json({ error: 'This media isn’t stored yet, so it can’t be forwarded.' });
    }

    const results = [];
    for (const dest of dests) {
      try {
        results.push(await forwardToDestination(db, src, dest));
      } catch (e) {
        console.error('Forward to', dest, 'failed:', e);
        results.push({ ok: false, wa_id: dest, error: 'Could not forward to this chat.' });
      }
    }
    const sentCount = results.filter((r) => r.ok).length;
    res.json({ sent: sentCount, total: dests.length, results });
  } catch (e) {
    handleDbError(res, e);
  }
});

// POST /api/conversations/:wa_id/read  { read: true|false }
// DASHBOARD-LOCAL inbox flag only — sets unread_count to 0 (read) or 1
// (unread). This does NOT send or retract WhatsApp read receipts (blue ticks);
// it only controls the badge in this dashboard. A conversation manually marked
// unread (unread_count = 1) that later receives a new inbound still reads as
// unread, since inbound increments the same counter.
router.post('/conversations/:wa_id/read', async (req, res) => {
  const wa_id = (req.params.wa_id || '').toString();
  if (!wa_id) return res.status(400).json({ error: 'wa_id is required.' });
  const read = (req.body && req.body.read) !== false; // default to marking read
  try {
    const db = getDb();
    const { error } = await db
      .from('conversations')
      .update({ unread_count: read ? 0 : 1 })
      .eq('wa_id', wa_id);
    if (error) throw error;
    res.json({ ok: true, wa_id, unread_count: read ? 0 : 1 });
  } catch (e) {
    handleDbError(res, e);
  }
});

module.exports = router;
