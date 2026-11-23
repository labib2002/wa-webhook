// A voice note WhatsApp refused ("Media upload error", 131053) goes out again
// as an ordinary audio file: the same recording down a different road. Retry
// uses it when an agent asks, the status webhook uses it once by itself.

const wa = require('./whatsapp');
const media = require('./media');
const transcode = require('./transcode');

const REFUSED_MEDIA = /media upload error|131053/i;
const ROW_COLS = 'id, wa_id, direction, type, body, status, error, media_meta, media_path, media_status, created_at';
// Only a voice note just sent re-sends itself; an old one waits for the agent.
const FRESH_MS = 15 * 60 * 1000;

function isRefusedVoice(row) {
  const mm = (row && row.media_meta) || {};
  return mm.voice === true && (REFUSED_MEDIA.test(row.error || '') || Boolean(mm.auto_resend));
}

// The stored recording as an AAC file, kept beside the original.
// -> { ok, buf, mm, extra } or { ok: false, error }
async function asAudioFile(bucket, row, buf) {
  const mm = row.media_meta || {};
  const tr = await transcode.toM4a(buf, media.extFromMime(mm.mime_type));
  if (!tr.ok) return { ok: false, error: tr.error };
  const next = { ...mm, voice: null, mime_type: tr.mime, filename: 'voice-note.m4a', sent_as_audio: true };
  const extra = { media_meta: next, body: '🎵 Audio' };
  const target = media.compatPath(row.media_path);
  const stored = await bucket.upload(target, tr.buffer, { contentType: tr.mime, upsert: true });
  if (!stored.error) extra.media_path = target;
  return { ok: true, buf: tr.buffer, mm: next, extra };
}

// Called for a failed status. Sends at most once per message: the claim takes
// the row away from the refused wa_message_id, so a second delivery of the
// same status finds nothing to claim.
async function resendRefused(db, waMessageId) {
  const found = await db.from('messages').select(ROW_COLS).eq('wa_message_id', waMessageId).maybeSingle();
  const row = found.data;
  if (!row || row.direction !== 'out' || row.status !== 'failed' || !row.media_path) return false;
  const mm = row.media_meta || {};
  if (mm.voice !== true || mm.auto_resend || !REFUSED_MEDIA.test(row.error || '')) return false;
  if (!row.created_at || Date.now() - new Date(row.created_at).getTime() > FRESH_MS) return false;

  const claimedMeta = { ...mm, auto_resend: new Date().toISOString(), first_error: row.error };
  const claim = await db.from('messages')
    .update({ status: 'pending', wa_message_id: null, media_meta: claimedMeta })
    .eq('id', row.id).eq('wa_message_id', waMessageId).eq('status', 'failed')
    .select().maybeSingle();
  if (claim.error || !claim.data) return false;

  const giveBack = (why) => db.from('messages')
    .update({ status: 'failed', error: `${row.error}. Sent again as an audio file, which failed too: ${why}`.slice(0, 600) })
    .eq('id', row.id).eq('status', 'pending');
  try {
    const bucket = db.storage.from(media.BUCKET());
    const dl = await bucket.download(row.media_path);
    if (dl.error || !dl.data) { await giveBack('the stored recording could not be read'); return false; }
    const audio = await asAudioFile(bucket, { ...row, media_meta: claimedMeta }, Buffer.from(await dl.data.arrayBuffer()));
    if (!audio.ok) { await giveBack(audio.error); return false; }
    const up = await wa.uploadMedia(audio.buf, audio.mm.mime_type, audio.mm.filename);
    if (!up.ok) { await giveBack(up.error); return false; }
    const sent = await wa.sendMedia(row.wa_id, 'audio', up.mediaId, { replyTo: mm.reply_to || undefined, voice: false });
    if (!sent.ok) { await giveBack(sent.error); return false; }
    await db.from('messages')
      .update({ wa_message_id: sent.waMessageId || null, status: 'sent', error: null, ...audio.extra })
      .eq('id', row.id);
    return true;
  } catch (e) {
    await giveBack(e.message).catch(() => {});
    return false;
  }
}

module.exports = { REFUSED_MEDIA, isRefusedVoice, asAudioFile, resendRefused };
