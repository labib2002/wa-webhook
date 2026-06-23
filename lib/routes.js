// Dashboard JSON API. Every route here (except /api/login and /api/session)
// is behind requireAuth — the passcode gate is enforced server-side, not just
// by hiding UI.

const express = require('express');
const auth = require('./auth');
const { getDb, isConfigured: dbConfigured } = require('./db');
const wa = require('./whatsapp');
const media = require('./media');

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

router.post('/login', (req, res) => {
  if (!process.env.SESSION_SECRET) {
    return res.status(500).json({ error: 'Server misconfigured: SESSION_SECRET is not set.' });
  }
  if (!process.env.DASHBOARD_PASSCODE) {
    return res.status(500).json({ error: 'Server misconfigured: DASHBOARD_PASSCODE is not set.' });
  }
  const { passcode } = req.body || {};
  if (!auth.passcodeMatches(passcode)) {
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
    const withUpd = 'id, wa_message_id, wa_id, direction, type, body, media_meta, media_status, reaction, status, error, wa_timestamp, created_at, updated_at';
    let q = db.from('messages').select(withUpd).eq('wa_id', wa_id);
    if (since) {
      q = q.gt('updated_at', since).order('updated_at', { ascending: true }).limit(500);
    } else {
      q = q.order('created_at', { ascending: true }).order('id', { ascending: true }).limit(500);
    }
    let { data, error } = await q;

    // Graceful fallback if migration 005 (updated_at) hasn't been run yet, so a
    // deploy that precedes the migration still serves threads (just without the
    // incremental-update poll). Lights up automatically once the column exists.
    if (error && /updated_at/.test(error.message || '')) {
      const cols = 'id, wa_message_id, wa_id, direction, type, body, media_meta, media_status, reaction, status, error, wa_timestamp, created_at';
      if (since) { res.json({ messages: [] }); return; } // no way to detect changes yet
      const r = await db.from('messages').select(cols).eq('wa_id', wa_id)
        .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(500);
      if (r.error) throw r.error;
      res.json({ messages: r.data || [] });
      return;
    }
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
router.post('/send', async (req, res) => {
  const { wa_id, text } = req.body || {};
  const body = (text || '').toString().trim();
  if (!wa_id) return res.status(400).json({ error: 'wa_id is required.' });
  if (!body) return res.status(400).json({ error: 'Message text is empty.' });
  if (body.length > 4096) return res.status(400).json({ error: 'Message too long (max 4096 characters).' });

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

  // 1) upload bytes to WhatsApp -> media id
  const up = await wa.uploadMedia(buffer, mime, filename);
  if (!up.ok) return res.status(502).json({ error: up.error });

  // 2) send the media message
  const sent = await wa.sendMedia(wa_id, category, up.mediaId, { caption, filename });
  if (!sent.ok) return res.status(502).json({ error: sent.error });

  // 3) persist (conversation + message) and store a copy for our own thread view
  try {
    const db = getDb();
    const nowIso = new Date().toISOString();
    const labelMap = { image: '📷 Image', video: '🎬 Video', audio: '🎵 Audio', document: '📄 Document' };
    const baseLabel = (voice && category === 'audio') ? '🎤 Voice message' : labelMap[category];
    const preview = caption ? `${baseLabel} · ${caption}` : baseLabel;

    await db.from('conversations').upsert(
      { wa_id, last_message_text: preview, last_message_at: nowIso, last_message_direction: 'out' },
      { onConflict: 'wa_id' }
    );

    // Store our copy in the bucket so the outgoing bubble can render it.
    let media_path = null;
    let media_status = 'failed';
    try {
      const ext = media.extFromMime(mime);
      const safeWa = String(wa_id).replace(/[^0-9]/g, '') || 'unknown';
      const path = `${safeWa}/out/${(sent.waMessageId || 'msg').replace(/[^a-zA-Z0-9]/g, '')}.${ext}`;
      const { error: upErr } = await db.storage
        .from(media.BUCKET())
        .upload(path, buffer, { contentType: mime || 'application/octet-stream', upsert: true });
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
        media_meta: { filename: filename || null, mime_type: mime || null, caption: caption || null, voice: (voice && category === 'audio') || null },
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

module.exports = router;
