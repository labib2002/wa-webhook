// Dashboard JSON API. Every route here (except /api/login and /api/session)
// is behind requireAuth: the session is checked server-side, not just by
// hiding UI.

const express = require('express');
const auth = require('./auth');
const staff = require('./staff');
const limiter = require('./loginLimiter');
const idem = require('./idempotency');
const { sendTemplateFlow, resolveKey, markFailed, markSent } = require('./templateSend');
const { getDb, isConfigured: dbConfigured } = require('./db');
const wa = require('./whatsapp');
const media = require('./media');
const transcode = require('./transcode');
const voiceFallback = require('./voiceFallback');
const dims = require('./dims');
const phone = require('../web/phone');
const templates = require('./templates');
const tpl = require('../web/tpl');
const { makeWarner } = require('./warn');
const live = require('./live');
const push = require('./push');
const features = require('./features');
const inbox = require('./inbox');
const win = require('./window');

const router = express.Router();

// Saved names live in conversations.display_name (db/migrations/008). Until
// that column exists the inbox keeps working without them.
const NAME_MAX = 80;
const NO_SAVED_NAMES = "Saving names isn't switched on yet.";
const BAD_NUMBER = 'Enter a valid number: 010 1234 5678 for Egypt, or + and the country code for other countries.';
const warnNoSavedNames = makeWarner('conversations.display_name missing, saved names are off');

function cleanName(raw) {
  return String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function nameError(raw) {
  if (raw != null && typeof raw !== 'string') return 'name must be text.';
  if (cleanName(raw).length > NAME_MAX) return `Keep the name under ${NAME_MAX} characters.`;
  return null;
}

// A reply quotes one earlier message by its wa_message_id. It rides in
// media_meta.reply_to (text rows included) so no schema change is needed.
const WAMID_RE = /^[A-Za-z0-9._:=+\/-]{1,256}$/;
function replyToFrom(body) {
  const raw = body && body.reply_to;
  if (raw == null || raw === '') return {};
  if (typeof raw !== 'string' || !WAMID_RE.test(raw)) return { invalid: 'reply_to is not a valid message id.' };
  return { replyTo: raw };
}

// Deliberately narrower than the service allow-list (which takes any ops_
// template): an agent in the inbox is here to reopen a conversation whose 24h
// window closed, not to fire arbitrary ops templates at a customer.
const HUMAN_TEMPLATES = ['ops_support_followup'];
// This WABA registers the ops_ templates under plain 'ar'/'en'. Sending
// 'ar_EG' or 'en_US' is a different (name, language) pair to Meta → 132001.
const TEMPLATE_LANGUAGES = ['en', 'ar'];
const STALE_RESEND_MS = 2 * 60 * 1000;
const THREAD_MAX = 500;
// A tapped button or list choice is stored under its own type and is text.
const TEXT_TYPES = ['text', 'button', 'interactive'];

// Who sent a message: the name on the staff account that is signed in.
function agentFrom(req) {
  return (req.staff && req.staff.name) || null;
}

// What every message an agent sends carries: `stamp` goes on the message row,
// `answered` on the chat, which stops needing a reply the moment one is sent.
async function sendContext(req) {
  const f = await features.load();
  return {
    stamp: f.agent ? { agent: agentFrom(req) } : {},
    answered: f.done ? { unread_count: 0 } : {},
  };
}

// Refuses a free message or media into a closed 24-hour window before
// anything reaches WhatsApp. Answers true when it has sent the refusal.
async function refuseClosedWindow(res, waId) {
  if (!dbConfigured()) return false;
  const w = await win.check(getDb(), waId);
  if (w.open) return false;
  res.status(409).json({ error: w.error, code: 'WINDOW_CLOSED', last_inbound_at: w.last });
  return true;
}

// --- auth endpoints (public) ---

// Tells the browser whether it already has a valid session (so the SPA can
// skip the login screen on reload), who is signed in, and whether sending is
// configured.
router.get('/session', async (req, res) => {
  const { who, ended } = await auth.current(req).catch(() => ({ who: null, ended: false }));
  if (ended) auth.clearSessionCookie(res);
  res.json({
    authed: Boolean(who),
    agent: who ? { name: who.name, email: who.email, image: staff.imageOf(who.adminId) } : null,
    ...(ended ? { ended: staff.SENTENCES.ended } : {}),
    sendConfigured: wa.isConfigured(),
    dbConfigured: dbConfigured(),
  });
});

const LOGIN_STATUS = { missing: 400, wrong: 401, role: 403, limited: 429, down: 503 };

router.post('/login', async (req, res) => {
  if (!process.env.SESSION_SECRET) {
    return res.status(500).json({ error: auth.NOT_SET_UP });
  }
  // The inbox's own limit comes first (per address, plus one for everyone);
  // the backend then applies its limits per account and per address.
  const ip = limiter.clientIp(req);
  if (await limiter.isLimited(ip)) {
    return res.status(429).json({ error: staff.SENTENCES.limited });
  }
  const { email, password } = req.body || {};
  const out = await staff.signIn(email, password, ip);
  // Only a right or a wrong password counts: an account without the role or
  // a backend that did not answer says nothing about guessing.
  if (out.ok || out.why === 'wrong') await limiter.recordAttempt(ip, out.ok);
  if (!out.ok) {
    return res.status(LOGIN_STATUS[out.why] || 503).json({ error: staff.SENTENCES[out.why] || staff.SENTENCES.down });
  }
  auth.setSessionCookie(res, auth.issueToken(out.staff));
  res.json({ ok: true, agent: { name: out.staff.name, email: out.staff.email, image: out.staff.image || null } });
});

router.post('/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// --- everything below requires a valid session ---
router.use(auth.requireAuth);

// GET /api/events -> Server-Sent Events stream of "change" pings (lib/live.js).
router.get('/events', live.subscribe);

// Small helper to turn a thrown DB-not-configured error into a clean 503.
function handleDbError(res, e) {
  if (e && e.code === 'DB_NOT_CONFIGURED') {
    return res.status(503).json({ error: e.message, code: 'DB_NOT_CONFIGURED' });
  }
  console.error('API DB error:', e);
  return res.status(500).json({ error: 'Database error.' });
}

// GET /api/templates -> the approved template copy, so bubbles show what was sent.
router.get('/templates', async (_req, res) => {
  res.json({ templates: await templates.listTemplates() });
});

// GET /api/conversations?view=&q=&offset=&limit=  -> one page of the left
// pane, most recent first, each chat with its saved name, its member and
// company, and whether it still needs a reply (lib/inbox.js).
//   view: chats (default), needs_reply
//   q:    searches every chat by name, number and company, and message text
// members_available false means the lookup is not installed or failed, which
// the inbox must not read as "not a member".
router.get('/conversations', async (req, res) => {
  try {
    const f = await features.load();
    const out = await inbox.list(getDb(), f, {
      view: String(req.query.view || 'chats'),
      q: String(req.query.q || '').slice(0, 120),
      offset: req.query.offset,
      limit: req.query.limit,
    });
    res.json({ ...out, teamwork: f.done, agent_names: f.agent, saved_replies: f.replies });
  } catch (e) {
    handleDbError(res, e);
  }
});

// PATCH /api/conversations/:wa_id  { name }  -> the name this inbox shows for
// the number. WhatsApp never shares the name a person is saved under, and the
// webhook only refreshes profile_name, so display_name is never overwritten by
// an incoming message. An empty name clears it.
router.patch('/conversations/:wa_id', async (req, res) => {
  const wa_id = (req.params.wa_id || '').toString();
  const raw = (req.body || {}).name;
  const invalid = nameError(raw);
  if (invalid) return res.status(400).json({ error: invalid });
  const name = cleanName(raw) || null;
  try {
    const db = getDb();
    const { data, error } = await db
      .from('conversations')
      .update({ display_name: name })
      .eq('wa_id', wa_id)
      .select()
      .maybeSingle();
    if (error && error.code === '42703') {
      warnNoSavedNames(error);
      return res.status(503).json({ error: NO_SAVED_NAMES, code: 'SAVED_NAMES_OFF' });
    }
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Conversation not found.' });
    res.json({ ok: true, wa_id, display_name: data.display_name ?? null });
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
    const f = await features.load();
    const cols = `id, wa_message_id, wa_id, direction, type, body, media_meta, media_status, reaction, forwarded, status, error, wa_timestamp, created_at, updated_at${f.agent ? ', agent' : ''}`;

    let q = db.from('messages').select(cols).eq('wa_id', wa_id);
    if (since) {
      q = q.gt('updated_at', since).order('updated_at', { ascending: true }).limit(THREAD_MAX);
    } else {
      // The newest messages, so a long chat opens on today and not on its first week.
      q = q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(THREAD_MAX);
    }

    const { data, error } = await q;
    if (error) throw error;
    const messages = since ? (data || []) : (data || []).reverse();
    if (since) return res.json({ messages, server_now: new Date().toISOString() });

    // When the member last wrote decides whether the 24-hour window is open.
    // server_now lets the browser judge it on the server's clock.
    const { data: lastIn } = await db.from('messages').select('wa_timestamp, created_at')
      .eq('wa_id', wa_id).eq('direction', 'in')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    res.json({
      messages,
      last_inbound_at: lastIn ? (lastIn.wa_timestamp || lastIn.created_at) : null,
      server_now: new Date().toISOString(),
      more: messages.length >= THREAD_MAX,
    });
  } catch (e) {
    handleDbError(res, e);
  }
});

// The AAC copy of a voice note, made on first request and kept beside the
// original. Null when it can't be made; the caller then serves the original.
async function compatAudio(db, path, mime) {
  try {
    const target = media.compatPath(path);
    const bucket = db.storage.from(media.BUCKET());
    const have = await bucket.exists(target);
    if (have.data) return target;
    const dl = await bucket.download(path);
    if (dl.error || !dl.data) return null;
    const tr = await transcode.toM4a(Buffer.from(await dl.data.arrayBuffer()), media.extFromMime(mime));
    if (!tr.ok) throw new Error(tr.error);
    const { error } = await bucket.upload(target, tr.buffer, { contentType: tr.mime });
    return error ? null : target;
  } catch (e) {
    console.warn(`compat audio for ${path}: ${e.message}`);
    return null;
  }
}

// GET /api/media/:id  -> short-lived signed URL for a stored media object.
// :id is the internal message id. We redirect to the signed URL so the browser
// can use it directly in <img>/<video>/<aud> tags or links. ?compat=1 on audio
// returns an AAC copy for browsers that can't play OGG/Opus or AMR.
router.get('/media/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id.' });
  try {
    const db = getDb();
    const { data: row, error } = await db
      .from('messages')
      .select('media_path, media_status, media_meta')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ error: 'Message not found.' });
    if (row.media_status !== 'stored' || !row.media_path) {
      return res.status(409).json({ error: 'Media not available.', media_status: row.media_status });
    }
    // Without a download name the browser falls back to the storage path, which
    // is the bare Meta media id.
    const mm = row.media_meta || {};
    if (req.query.compat && media.needsCompatAudio(mm.mime_type)) {
      const compat = await compatAudio(getDb(), row.media_path, mm.mime_type);
      if (compat) return res.redirect(302, await media.signedUrl(compat, 600));
    }
    // ?inline=1 skips the attachment name so a PDF can render in the viewer.
    const name = req.query.inline ? undefined : media.downloadName(mm, mm.id, mm.mime_type);
    const url = await media.signedUrl(row.media_path, 600, name);
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
// can never double-send (see lib/idempotency.js), except onto a 'failed' row
// that never reached Meta, which re-sends. Keyless requests are untouched:
// send first, persist after.
router.post('/send', async (req, res) => {
  const { wa_id, text } = req.body || {};
  const body = (text || '').toString().trim();
  if (!wa_id) return res.status(400).json({ error: 'wa_id is required.' });
  if (!body) return res.status(400).json({ error: 'Message text is empty.' });
  if (body.length > 4096) return res.status(400).json({ error: 'Message too long (max 4096 characters).' });
  const { replyTo, invalid: badReply } = replyToFrom(req.body);
  if (badReply) return res.status(400).json({ error: badReply });
  const media_meta = replyTo ? { reply_to: replyTo } : null;
  if (await refuseClosedWindow(res, wa_id)) return;

  const { key, invalid } = idem.keyFromRequest(req);
  if (invalid) return res.status(400).json({ error: invalid });
  const ctx = dbConfigured() ? await sendContext(req) : { stamp: {}, answered: {} };

  if (key && dbConfigured()) {
    const db = getDb();
    const nowIso = new Date().toISOString();
    const k = await resolveKey(db, key, {
      wa_id,
      direction: 'out',
      type: 'text',
      body,
      media_meta,
      ...ctx.stamp,
      wa_timestamp: nowIso,
    });
    if (k.deduped) {
      return res.json({ ok: true, deduped: true, id: k.deduped.id, message: k.deduped });
    }
    if (k.conflict) {
      return res.status(409).json({ error: 'Duplicate request already in flight.' });
    }
    if (k.row) {
      const result = await wa.sendText(wa_id, body, { replyTo });
      if (!result.ok) {
        // Leave a retryable failed row (a replay of the key resends it, as
        // does POST /api/retry/:id).
        await markFailed(db, k.row.id, result.error);
        return res.status(502).json({ error: result.error });
      }
      await db.from('conversations').upsert(
        { wa_id, last_message_text: body, last_message_at: nowIso, last_message_direction: 'out', ...ctx.answered },
        { onConflict: 'wa_id' }
      );
      const upd = await markSent(db, k.row.id, result.waMessageId).select().single();
      if (upd.error) {
        console.error('Send persisted-failed:', upd.error);
        return res.status(207).json({
          warning: 'Message sent but could not be saved. It may reappear after refresh.',
          waMessageId: result.waMessageId || null,
        });
      }
      return res.json({ message: upd.data });
    }
    // k.skip -> degrade to the keyless flow below.
  }

  // Fire the WhatsApp call first; only persist if it was accepted.
  const result = await wa.sendText(wa_id, body, { replyTo });
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
          ...ctx.answered,
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
        media_meta,
        ...ctx.stamp,
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
  const { replyTo, invalid: badReply } = replyToFrom(req.body);
  if (badReply) return res.status(400).json({ error: badReply });
  if (await refuseClosedWindow(res, wa_id)) return;

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
  // delivery; OGG/Opus actually delivers. An uploaded audio FILE in a format
  // iPhones can't play as plain audio (OGG, WebM) goes out as AAC instead.
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
  } else if (category === 'audio' && media.needsCompatAudio(mime) && !/^audio\/amr/i.test(mime)) {
    const tr = await transcode.toM4a(buffer, media.extFromMime(mime));
    if (!tr.ok) return res.status(502).json({ error: tr.error });
    uploadBuffer = tr.buffer;
    uploadMime = tr.mime;             // audio/mp4
    uploadFilename = String(filename || 'audio').replace(/\.[^.]*$/, '') + '.m4a';
    storeExt = tr.ext;               // m4a
  }
  const sendAsVoice = Boolean(voice && category === 'audio');

  const labelMap = { image: '📷 Image', video: '🎬 Video', audio: '🎵 Audio', document: '📄 Document' };
  const baseLabel = (voice && category === 'audio') ? '🎤 Voice message' : labelMap[category];
  const preview = caption ? `${baseLabel} · ${caption}` : baseLabel;
  const pixels = category === 'image' || category === 'video'
    ? await dims.mediaSize(uploadBuffer, uploadMime, storeExt).catch(() => null)
    : null;
  const mediaMeta = dims.withSize(
    { filename: uploadFilename || null, mime_type: uploadMime || null, caption: caption || null, voice: (voice && category === 'audio') || null },
    pixels,
  );
  if (replyTo) mediaMeta.reply_to = replyTo;

  // Optional idempotency (same reservation flow as /api/send): with a key we
  // reserve a pending row and store our bucket copy BEFORE the Meta calls, so
  // a duplicate never double-sends while a failed send stays retryable.
  const { key, invalid } = idem.keyFromRequest(req);
  if (invalid) return res.status(400).json({ error: invalid });

  const ctx = dbConfigured() ? await sendContext(req) : { stamp: {}, answered: {} };

  if (key && dbConfigured()) {
    const db = getDb();
    const nowIso = new Date().toISOString();
    const k = await resolveKey(db, key, {
      wa_id,
      direction: 'out',
      type: category,
      body: preview,
      media_meta: mediaMeta,
      ...ctx.stamp,
      wa_timestamp: nowIso,
    });
    if (k.deduped) {
      return res.json({ ok: true, deduped: true, id: k.deduped.id, message: k.deduped });
    }
    if (k.conflict) {
      return res.status(409).json({ error: 'Duplicate request already in flight.' });
    }
    if (k.row) {
      // Bucket copy first, named by row id (no wa_message_id yet), so the
      // bubble renders and a failed send can be retried from stored bytes.
      // Seeded from the row so a re-send whose upload fails keeps the copy
      // an earlier attempt stored (POST /api/retry/:id needs it).
      let media_path = k.row.media_path || null;
      let media_status = media_path && k.row.media_status === 'stored' ? 'stored' : 'failed';
      try {
        const safeWa = String(wa_id).replace(/[^0-9]/g, '') || 'unknown';
        const path = `${safeWa}/out/k${k.row.id}.${storeExt}`;
        const { error: upErr } = await db.storage
          .from(media.BUCKET())
          .upload(path, uploadBuffer, { contentType: uploadMime || 'application/octet-stream', upsert: true });
        if (!upErr) { media_path = path; media_status = 'stored'; }
      } catch (_) { /* non-fatal: bubble falls back to placeholder */ }

      const upK = await wa.uploadMedia(uploadBuffer, uploadMime, uploadFilename);
      if (!upK.ok) {
        await markFailed(db, k.row.id, upK.error, { media_path, media_status });
        return res.status(502).json({ error: upK.error });
      }
      const sentK = await wa.sendMedia(wa_id, category, upK.mediaId, { caption, filename: uploadFilename, replyTo, voice: sendAsVoice });
      if (!sentK.ok) {
        await markFailed(db, k.row.id, sentK.error, { media_path, media_status });
        return res.status(502).json({ error: sentK.error });
      }
      await db.from('conversations').upsert(
        { wa_id, last_message_text: preview, last_message_at: nowIso, last_message_direction: 'out', ...ctx.answered },
        { onConflict: 'wa_id' }
      );
      const upd = await markSent(db, k.row.id, sentK.waMessageId, { media_path, media_status }).select().single();
      if (upd.error) {
        console.error('send-media persist failed:', upd.error);
        return res.status(207).json({ warning: 'Media sent but could not be saved.', waMessageId: sentK.waMessageId || null });
      }
      return res.json({ message: upd.data });
    }
    // k.skip -> degrade to the keyless flow below.
  }

  // 1) upload bytes to WhatsApp -> media id
  const up = await wa.uploadMedia(uploadBuffer, uploadMime, uploadFilename);
  if (!up.ok) return res.status(502).json({ error: up.error });

  // 2) send the media message
  const sent = await wa.sendMedia(wa_id, category, up.mediaId, { caption, filename: uploadFilename, replyTo, voice: sendAsVoice });
  if (!sent.ok) return res.status(502).json({ error: sent.error });

  // 3) persist (conversation + message) and store a copy for our own thread view
  try {
    const db = getDb();
    const nowIso = new Date().toISOString();

    await db.from('conversations').upsert(
      { wa_id, last_message_text: preview, last_message_at: nowIso, last_message_direction: 'out', ...ctx.answered },
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
        ...ctx.stamp,
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

// POST /api/send-template  { wa_id, template, language, params[], client_key? }
// The agent's way out of a closed 24-hour window: only an approved template can
// open a business-initiated conversation, and the customer's reply reopens the
// window for free-form messages. Same idempotency + persistence as /api/send.
router.post('/send-template', async (req, res) => {
  const { wa_id, template, language, params } = req.body || {};
  if (!wa_id) return res.status(400).json({ error: 'wa_id is required.' });
  const name = String(template || '');
  if (!HUMAN_TEMPLATES.includes(name)) {
    return res.status(400).json({ error: `Template '${name}' can't be sent from the inbox.` });
  }
  const lang = String(language || '');
  if (!TEMPLATE_LANGUAGES.includes(lang)) {
    return res.status(400).json({ error: "language must be 'en' or 'ar'." });
  }
  // Meta rejects a template parameter that is empty or carries a newline/tab.
  const values = Array.isArray(params) ? params : [];
  if (!values.length || values.some((p) => typeof p !== 'string' || !p.trim() || /[\n\t]/.test(p))) {
    return res.status(400).json({ error: 'Template values must be plain, non-empty text.' });
  }

  const { key, invalid } = idem.keyFromRequest(req);
  if (invalid) return res.status(400).json({ error: invalid });

  const { status, body } = await sendTemplateFlow(dbConfigured() ? getDb() : null, {
    waId: wa_id,
    template: name,
    language: lang,
    components: [{ type: 'body', parameters: values.map((t) => ({ type: 'text', text: t.trim() })) }],
    key,
    ctx: dbConfigured() ? await sendContext(req) : null,
  });
  res.status(status).json(body);
});

// POST /api/retry/:id  -> re-attempt sending a previously-FAILED outgoing row.
// Used when the message reached our server (so a row exists) but WhatsApp
// rejected it or it later flipped to failed via the status webhook. Re-sends
// from the stored copy; on success flips the SAME row back to sent (new
// wa_message_id, error cleared) — no duplicate row.
router.post('/retry/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id.' });
  let claimed = false;
  const db = dbConfigured() ? getDb() : null;
  // Hand the row back as failed, with the reason, so Retry shows again.
  const giveBack = async (status, error) => {
    if (claimed) await db.from('messages').update({ status: 'failed', error }).eq('id', id);
    return res.status(status).json({ error });
  };
  try {
    if (!db) getDb();
    const { data: row, error } = await db
      .from('messages')
      .select('id, wa_id, direction, type, body, status, error, media_meta, media_path, media_status, updated_at')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ error: 'Message not found.' });
    if (row.direction !== 'out') return res.status(400).json({ error: 'Only outgoing messages can be retried.' });

    const replyTo = (row.media_meta && row.media_meta.reply_to) || undefined;
    const sentTpl = row.media_meta && row.media_meta.template;
    if (row.type === 'text' && /^📋 /.test(row.body || '') && !sentTpl) {
      return res.status(400).json({ error: 'This template was sent before resends were possible. Send it again from the ops dashboard.' });
    }
    const isMedia = !sentTpl && row.type !== 'text';
    if (isMedia && !row.media_path) return res.status(400).json({ error: 'No stored media to resend.' });
    if (!sentTpl && await refuseClosedWindow(res, row.wa_id)) return;

    // Two agents pressing Retry on the same bubble: only the first one sends.
    // A resend that died half way leaves the row pending; after two minutes it
    // can be taken again.
    const stale = row.status === 'pending' && row.updated_at
      && Date.now() - Date.parse(row.updated_at) > STALE_RESEND_MS;
    let take = db.from('messages').update({ status: 'pending' }).eq('id', id);
    take = stale ? take.eq('status', 'pending').eq('updated_at', row.updated_at) : take.eq('status', 'failed');
    const claim = await take.select().maybeSingle();
    if (claim.error) throw claim.error;
    if (!claim.data) return res.status(409).json({ error: 'This message is already being sent again, or it went through.' });
    claimed = true;

    let sent;
    const extra = {};
    if (sentTpl) {
      sent = await wa.sendTemplate(row.wa_id, { name: sentTpl.name, language: sentTpl.language, components: sentTpl.components || [] });
    } else if (row.type === 'text') {
      sent = await wa.sendText(row.wa_id, row.body || '', { replyTo });
    } else {
      // media: re-upload the stored bucket copy, then re-send
      const bucket = db.storage.from(media.BUCKET());
      const dl = await bucket.download(row.media_path);
      if (dl.error || !dl.data) return giveBack(502, 'Could not read stored media to resend.');
      let buf = Buffer.from(await dl.data.arrayBuffer());
      let mm = row.media_meta || {};
      if (voiceFallback.isRefusedVoice(row)) {
        const audio = await voiceFallback.asAudioFile(bucket, row, buf);
        if (!audio.ok) return giveBack(502, audio.error);
        buf = audio.buf;
        mm = audio.mm;
        Object.assign(extra, audio.extra);
      }
      const upMime = mm.mime_type || 'application/octet-stream';
      const category = wa.mediaCategory(upMime);
      const up = await wa.uploadMedia(buf, upMime, mm.filename || 'file');
      if (!up.ok) return giveBack(502, up.error);
      sent = await wa.sendMedia(row.wa_id, category, up.mediaId, { caption: mm.caption || '', filename: mm.filename, replyTo, voice: mm.voice === true });
    }
    if (!sent.ok) return giveBack(502, sent.error);

    const { data: updated, error: upErr } = await db
      .from('messages')
      .update({ wa_message_id: sent.waMessageId || null, status: 'sent', error: null, ...extra })
      .eq('id', id)
      .select()
      .single();
    if (upErr) throw upErr;
    const f = await features.load();
    if (f.done) await db.from('conversations').update({ unread_count: 0 }).eq('wa_id', row.wa_id);
    res.json({ message: updated });
  } catch (e) {
    if (claimed) {
      try {
        await db.from('messages').update({ status: 'failed', error: 'Could not send it again. Try once more.' }).eq('id', id);
      } catch (_) { /* the row stays pending; the reply below still says it failed */ }
    }
    handleDbError(res, e);
  }
});

// POST /api/start-conversation  { wa_id, name? }
// Create (or surface) a conversation row so the agent can message a number
// that hasn't written in yet. Sending still respects the 24h window. The
// number may be typed the local Egyptian way; a name is saved whether the chat
// is new or already there.
router.post('/start-conversation', async (req, res) => {
  const { wa_id: typed, name } = req.body || {};
  const wa_id = phone.toWaId(typed);
  if (!wa_id) return res.status(400).json({ error: BAD_NUMBER });
  const invalid = nameError(name);
  if (invalid) return res.status(400).json({ error: invalid });
  const saved = cleanName(name);
  try {
    const db = getDb();
    const { data: existing, error: findErr } = await db
      .from('conversations').select('wa_id').eq('wa_id', wa_id).maybeSingle();
    if (findErr) throw findErr;
    if (!existing) {
      const { error } = await db.from('conversations').upsert(
        { wa_id, last_message_at: new Date().toISOString(), unread_count: 0 },
        { onConflict: 'wa_id', ignoreDuplicates: true }
      );
      if (error) throw error;
    }
    let display_name = null;
    if (saved) {
      const { error } = await db.from('conversations').update({ display_name: saved }).eq('wa_id', wa_id);
      if (error && error.code !== '42703') throw error;
      if (error) warnNoSavedNames(error);
      else display_name = saved;
    }
    res.json({ wa_id, created: !existing, display_name });
  } catch (e) {
    handleDbError(res, e);
  }
});

// POST /api/mark-read  { wa_id }  -> an agent opened the chat: blue-tick the
// member via WhatsApp's mark-as-read on the latest inbound message. The chat
// keeps its unread count for the other agents until someone replies or marks
// it done; before migration 011 opening it still clears the count.
router.post('/mark-read', async (req, res) => {
  const { wa_id } = req.body || {};
  if (!wa_id) return res.status(400).json({ error: 'wa_id is required.' });
  try {
    const db = getDb();
    const f = await features.load();
    if (!f.done) await db.from('conversations').update({ unread_count: 0 }).eq('wa_id', wa_id);

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

async function insertForwardedMessage(db, row) {
  const { data, error } = await db.from('messages').insert(row).select().single();
  if (error) throw error;
  return data;
}

// Forward one source message to one destination wa_id. Re-sends through the
// existing WhatsApp helpers (text → sendText; media → re-upload the stored
// bucket copy → sendMedia) and persists a forwarded outgoing row. Returns
// { ok, wa_id, message } or { ok:false, wa_id, error }.
async function forwardToDestination(db, src, dest, ctx) {
  const nowIso = new Date().toISOString();

  if (TEXT_TYPES.includes(src.type || 'text')) {
    const list = templates.cached();
    const sentTpl = tpl.sentTemplate(src);
    if (sentTpl && !tpl.render(sentTpl, list)) return { ok: false, wa_id: dest, error: 'The template text is not available right now. Try again in a minute.' };
    const text = tpl.messageText(src, list);
    const sent = await wa.sendText(dest, text);
    if (!sent.ok) return { ok: false, wa_id: dest, error: sent.error };

    await db.from('conversations').upsert(
      { wa_id: dest, last_message_text: text, last_message_at: nowIso, last_message_direction: 'out', ...ctx.answered },
      { onConflict: 'wa_id' }
    );
    const message = await insertForwardedMessage(db, {
      wa_message_id: sent.waMessageId || null,
      wa_id: dest, direction: 'out', type: 'text', body: text,
      ...ctx.stamp,
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
  // The quote points into the source chat, so it does not travel.
  const { reply_to: _quoted, ...mm } = src.media_meta || {};
  const upMime = mm.mime_type || 'application/octet-stream';
  const category = wa.mediaCategory(upMime);
  const up = await wa.uploadMedia(buf, upMime, mm.filename || 'file');
  if (!up.ok) return { ok: false, wa_id: dest, error: up.error };
  const sent = await wa.sendMedia(dest, category, up.mediaId, { caption: mm.caption || '', filename: mm.filename, voice: mm.voice === true });
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
    { wa_id: dest, last_message_text: src.body || '', last_message_at: nowIso, last_message_direction: 'out', ...ctx.answered },
    { onConflict: 'wa_id' }
  );
  const message = await insertForwardedMessage(db, {
    wa_message_id: sent.waMessageId || null,
    wa_id: dest, direction: 'out', type: src.type, body: src.body || '',
    media_meta: mm, media_path, media_status,
    ...ctx.stamp,
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
    if (!TEXT_TYPES.includes(src.type || 'text') && (src.media_status !== 'stored' || !src.media_path)) {
      return res.status(409).json({ error: 'This media isn’t stored yet, so it can’t be forwarded.' });
    }

    const ctx = await sendContext(req);
    const results = [];
    for (const dest of dests) {
      try {
        const w = await win.check(db, dest);
        if (!w.open) { results.push({ ok: false, wa_id: dest, error: w.error, code: 'WINDOW_CLOSED' }); continue; }
        results.push(await forwardToDestination(db, src, dest, ctx));
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
// The inbox's own flag, shared by every agent. read:true marks the chat done:
// the count clears and it leaves "Needs reply" until the member writes again.
// read:false flags it as needing a reply. Neither sends nor takes back a
// WhatsApp read receipt.
router.post('/conversations/:wa_id/read', async (req, res) => {
  const wa_id = (req.params.wa_id || '').toString();
  if (!wa_id) return res.status(400).json({ error: 'wa_id is required.' });
  const read = (req.body && req.body.read) !== false; // default to marking read
  try {
    const db = getDb();
    const f = await features.load();
    const patch = { unread_count: read ? 0 : 1 };
    if (f.done) patch.done_at = read ? new Date().toISOString() : null;
    const { error } = await db.from('conversations').update(patch).eq('wa_id', wa_id);
    if (error) throw error;
    res.json({ ok: true, wa_id, unread_count: patch.unread_count, done_at: patch.done_at ?? null });
  } catch (e) {
    handleDbError(res, e);
  }
});

// POST /api/react  { message_id, emoji }  -> react to a member's message, the
// way a long press does on a phone. An empty emoji takes the reaction back.
const EMOJI_MAX = 16;
router.post('/react', async (req, res) => {
  const id = Number((req.body || {}).message_id);
  const emoji = String((req.body || {}).emoji || '');
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'message_id is required.' });
  if (emoji.length > EMOJI_MAX || /[\u0000-\u007f]/.test(emoji)) return res.status(400).json({ error: 'Choose an emoji.' });
  try {
    const db = getDb();
    const { data: row, error } = await db.from('messages')
      .select('id, wa_id, direction, wa_message_id').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ error: 'Message not found.' });
    if (row.direction !== 'in' || !row.wa_message_id) return res.status(400).json({ error: "Only a member's message can be reacted to." });
    const sent = await wa.sendReaction(row.wa_id, row.wa_message_id, emoji);
    if (!sent.ok) return res.status(502).json({ error: sent.error });
    const upd = await db.from('messages').update({ reaction: emoji || null }).eq('id', id).select().single();
    if (upd.error) throw upd.error;
    res.json({ message: upd.data });
  } catch (e) {
    handleDbError(res, e);
  }
});

// Saved replies: answers the team reuses, shared by every agent (migration 011).
const REPLY_TITLE_MAX = 60;
const REPLY_BODY_MAX = 4096;
function replyFields(body) {
  const title = cleanName((body || {}).title);
  const text = String((body || {}).body == null ? '' : (body || {}).body).trim();
  if (!title) return { invalid: 'Give the reply a short name.' };
  if (title.length > REPLY_TITLE_MAX) return { invalid: `Keep the name under ${REPLY_TITLE_MAX} characters.` };
  if (!text) return { invalid: 'The reply has no text.' };
  if (text.length > REPLY_BODY_MAX) return { invalid: `Keep the reply under ${REPLY_BODY_MAX} characters.` };
  return { title, body: text };
}
async function repliesOn(res) {
  const f = await features.load();
  if (!f.replies) res.status(503).json({ error: "Saved replies aren't switched on yet.", code: 'SAVED_REPLIES_OFF' });
  return f.replies;
}

router.get('/saved-replies', async (req, res) => {
  try {
    const f = await features.load();
    if (!f.replies) return res.json({ on: false, replies: [] });
    const { data, error } = await getDb().from('saved_replies').select('id, title, body, created_by, updated_at')
      .order('title', { ascending: true }).limit(500);
    if (error) throw error;
    res.json({ on: true, replies: data || [] });
  } catch (e) {
    handleDbError(res, e);
  }
});

router.post('/saved-replies', async (req, res) => {
  const fields = replyFields(req.body);
  if (fields.invalid) return res.status(400).json({ error: fields.invalid });
  try {
    if (!(await repliesOn(res))) return;
    const { data, error } = await getDb().from('saved_replies')
      .insert({ ...fields, created_by: agentFrom(req) }).select().single();
    if (error) throw error;
    res.json({ reply: data });
  } catch (e) {
    handleDbError(res, e);
  }
});

router.patch('/saved-replies/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id.' });
  const fields = replyFields(req.body);
  if (fields.invalid) return res.status(400).json({ error: fields.invalid });
  try {
    if (!(await repliesOn(res))) return;
    const { data, error } = await getDb().from('saved_replies')
      .update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'That saved reply is gone.' });
    res.json({ reply: data });
  } catch (e) {
    handleDbError(res, e);
  }
});

router.delete('/saved-replies/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id.' });
  try {
    if (!(await repliesOn(res))) return;
    const { error } = await getDb().from('saved_replies').delete().eq('id', id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    handleDbError(res, e);
  }
});

// Notifications on a phone or a closed tab (lib/push.js). The key answers
// { on: false } until migration 010 has run, and the page then hides the bell.
router.get('/push/key', async (req, res) => {
  const key = await push.publicKey(`https://${req.get('host')}`);
  res.json(key ? { on: true, key } : { on: false });
});

router.post('/push/subscribe', async (req, res) => {
  try {
    const out = await push.saveSubscription(req.body, req.get('user-agent'), req.staff.adminId);
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json({ ok: true });
  } catch (e) {
    handleDbError(res, e);
  }
});

router.post('/push/unsubscribe', async (req, res) => {
  try {
    await push.removeSubscription(req.body && req.body.endpoint);
    res.json({ ok: true });
  } catch (e) {
    handleDbError(res, e);
  }
});

module.exports = router;
