// Parse an incoming WhatsApp webhook payload and persist it.
//
// Design rule: this must be FAST and tolerant. The webhook returns 200 quickly;
// if anything here is malformed we skip that piece rather than throw, so Meta
// never sees a 500 (which would trigger retries / duplicates).
//
// Idempotency: messages.wa_message_id is UNIQUE and we upsert on it, so a
// retried delivery of the same payload never creates a duplicate row.

const { getDb } = require('./db');

// Friendly placeholder + preview text for non-text message types.
const TYPE_LABELS = {
  image: '📷 Image',
  audio: '🎵 Audio',
  voice: '🎤 Voice message',
  video: '🎬 Video',
  document: '📄 Document',
  sticker: '💟 Sticker',
  location: '📍 Location',
  contacts: '👤 Contact',
  unknown: '💬 Message',
};

function epochToIso(ts) {
  // WhatsApp timestamps are seconds-as-string.
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

// Build {body, media_meta} for any message type.
function describeMessage(msg) {
  const type = msg.type || 'unknown';
  if (type === 'text') {
    return { body: (msg.text && msg.text.body) || '', media_meta: null };
  }
  const label = TYPE_LABELS[type] || TYPE_LABELS.unknown;
  let media_meta = null;
  const media = msg[type];
  if (media && typeof media === 'object') {
    media_meta = {
      id: media.id || null,
      mime_type: media.mime_type || null,
      filename: media.filename || null,
      // a caption, if any, is worth showing alongside the label
      caption: media.caption || null,
      // location specifics
      latitude: media.latitude ?? null,
      longitude: media.longitude ?? null,
      name: media.name || null,
    };
  }
  // If there's a caption, fold it into the preview for nicer list text.
  const caption = media_meta && media_meta.caption;
  const body = caption ? `${label} · ${caption}` : label;
  return { body, media_meta };
}

// Upsert the conversation row and bump unread on inbound.
async function upsertConversationOnInbound(db, { wa_id, phone_number_id, profile_name, previewText, atIso }) {
  // Read current unread so we can increment (Supabase has no atomic ++ via API
  // without an RPC; for a single-agent inbox this read-then-write is fine).
  const { data: existing } = await db
    .from('conversations')
    .select('unread_count')
    .eq('wa_id', wa_id)
    .maybeSingle();

  const unread = (existing && existing.unread_count ? existing.unread_count : 0) + 1;

  const row = {
    wa_id,
    phone_number_id: phone_number_id || null,
    last_message_text: previewText,
    last_message_at: atIso,
    last_message_direction: 'in',
    unread_count: unread,
  };
  // Only set profile_name when we actually have one (don't overwrite with null).
  if (profile_name) row.profile_name = profile_name;

  const { error } = await db.from('conversations').upsert(row, { onConflict: 'wa_id' });
  if (error) throw new Error(`conversation upsert failed: ${error.message}`);
}

// Main entry: process one webhook body. Returns a small summary for logging.
// `dbOverride` lets tests inject a fake Supabase-shaped client.
async function ingestWebhook(body, dbOverride) {
  const db = dbOverride || getDb();
  const summary = { messages: 0, statuses: 0, contacts: 0, media: 0 };
  const mediaJobs = [];

  const entries = (body && body.entry) || [];
  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const change of changes) {
      const value = change.value || {};
      const phoneNumberId =
        value.metadata && value.metadata.phone_number_id;

      // Map wa_id -> profile name from contacts[].
      const nameByWaId = {};
      for (const c of value.contacts || []) {
        summary.contacts++;
        if (c.wa_id) nameByWaId[c.wa_id] = c.profile && c.profile.name;
      }

      // --- inbound messages ---
      for (const msg of value.messages || []) {
        const wa_id = msg.from;
        if (!wa_id) continue;
        const atIso = epochToIso(msg.timestamp) || new Date().toISOString();
        const { body: text, media_meta } = describeMessage(msg);
        const profile_name = nameByWaId[wa_id] || null;

        // Does this message carry downloadable media (vs. location/contacts/text)?
        const hasMedia = Boolean(media_meta && media_meta.id);
        const mediaStatus = hasMedia ? 'pending' : null;

        // Conversation first (messages FK to it).
        await upsertConversationOnInbound(db, {
          wa_id,
          phone_number_id: phoneNumberId,
          profile_name,
          previewText: text,
          atIso,
        });

        // Idempotent insert of the message.
        const { error: msgErr } = await db.from('messages').upsert(
          {
            wa_message_id: msg.id || null,
            wa_id,
            direction: 'in',
            type: msg.type || 'unknown',
            body: text,
            media_meta,
            media_status: mediaStatus,
            status: 'received',
            wa_timestamp: atIso,
          },
          { onConflict: 'wa_message_id', ignoreDuplicates: true }
        );
        if (msgErr) throw new Error(`message upsert failed: ${msgErr.message}`);
        summary.messages++;

        // Queue a media download job (processed after the row is durable).
        if (hasMedia && msg.id) {
          mediaJobs.push({
            wa_message_id: msg.id,
            wa_id,
            mediaId: media_meta.id,
            kind: msg.type,
          });
        }
      }

      // --- status updates for messages WE sent ---
      for (const st of value.statuses || []) {
        summary.statuses++;
        const waMessageId = st.id;
        if (!waMessageId) continue;
        const patch = { status: st.status };
        if (st.status === 'failed') {
          const e = (st.errors && st.errors[0]) || {};
          patch.error = e.title || e.message || 'Delivery failed';
        }
        // Only updates an existing outgoing row; no-op if we don't have it.
        await db
          .from('messages')
          .update(patch)
          .eq('wa_message_id', waMessageId);
      }
    }
  }

  // --- media download pass (after rows are durable) ---
  // We await these so the serverless function stays alive through the upload,
  // but the message row already exists, so a failure here only downgrades the
  // bubble to its labeled placeholder — no data is lost.
  for (const job of mediaJobs) {
    try {
      // Skip if already stored (idempotent on webhook retries).
      const { data: existing } = await db
        .from('messages')
        .select('media_status, media_path')
        .eq('wa_message_id', job.wa_message_id)
        .maybeSingle();
      if (existing && existing.media_status === 'stored' && existing.media_path) {
        continue;
      }

      const stored = await mediaFetcher(job.mediaId, job.wa_id, job.kind);
      await db
        .from('messages')
        .update({ media_path: stored.path, media_status: 'stored' })
        .eq('wa_message_id', job.wa_message_id);
      summary.media++;
    } catch (e) {
      console.error(`Media fetch failed for ${job.wa_message_id}:`, e.message);
      await db
        .from('messages')
        .update({ media_status: 'failed' })
        .eq('wa_message_id', job.wa_message_id);
    }
  }

  return summary;
}

// The media fetcher is swappable so tests can avoid real network/storage.
let mediaFetcher = require('./media').fetchAndStore;
function __setMediaFetcher(fn) { mediaFetcher = fn; }

module.exports = { ingestWebhook, describeMessage, TYPE_LABELS, __setMediaFetcher };
