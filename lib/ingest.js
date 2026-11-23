// Parse an incoming WhatsApp webhook payload and persist it.
//
// Design rule: this must be FAST and tolerant. The webhook returns 200 quickly;
// if anything here is malformed we skip that piece rather than throw, so Meta
// never sees a 500 (which would trigger retries / duplicates).
//
// Idempotency: messages.wa_message_id is UNIQUE and we upsert on it, so a
// retried delivery of the same payload never creates a duplicate row.

const { getDb } = require('./db');
const push = require('./push');
const { withSize } = require('./dims');
const voiceFallback = require('./voiceFallback');

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
  unsupported: "⚠️ Message that can't be shown",
  unknown: '💬 Message',
};

function epochToIso(ts) {
  // WhatsApp timestamps are seconds-as-string.
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

// The button of one of our templates, or a choice from a list, that the
// person tapped. WhatsApp sends its label, not a text message.
function tappedText(msg) {
  if (msg.type === 'button') return (msg.button && (msg.button.text || msg.button.payload)) || '';
  const i = msg.interactive || {};
  const reply = i.button_reply || i.list_reply;
  if (reply) return reply.title || reply.id || '';
  return i.nfm_reply ? 'Filled in a form' : '';
}

function contactCards(list) {
  return (Array.isArray(list) ? list : []).slice(0, 10).map((c) => ({
    name: (c.name && (c.name.formatted_name || [c.name.first_name, c.name.last_name].filter(Boolean).join(' '))) || null,
    phones: (Array.isArray(c.phones) ? c.phones : []).slice(0, 5)
      .map((p) => ({ phone: p.phone || null, wa_id: p.wa_id || null }))
      .filter((p) => p.phone || p.wa_id),
  })).filter((c) => c.name || c.phones.length);
}

// Build {body, media_meta} for any message type.
function describeMessage(msg) {
  const type = msg.type || 'unknown';
  // A swipe-reply carries the quoted message's wa_message_id in context.id.
  // Forwards also send a context, but with no id.
  const replyTo = (msg.context && msg.context.id) || null;
  if (type === 'text') {
    return { body: (msg.text && msg.text.body) || '', media_meta: replyTo ? { reply_to: replyTo } : null };
  }
  if (type === 'button' || type === 'interactive') {
    const media_meta = { tapped: true };
    if (replyTo) media_meta.reply_to = replyTo;
    return { body: tappedText(msg) || 'Tapped a button', media_meta };
  }
  if (type === 'contacts') {
    const cards = contactCards(msg.contacts);
    const media_meta = { contacts: cards };
    if (replyTo) media_meta.reply_to = replyTo;
    const first = cards[0] && (cards[0].name || (cards[0].phones[0] && cards[0].phones[0].phone));
    const more = cards.length > 1 ? ` +${cards.length - 1}` : '';
    return { body: first ? `${TYPE_LABELS.contacts} · ${first}${more}` : TYPE_LABELS.contacts, media_meta };
  }
  const media = msg[type];
  // A voice note arrives as type 'audio' with audio.voice === true.
  const isVoice = type === 'audio' && media && media.voice === true;
  const label = isVoice ? TYPE_LABELS.voice : (TYPE_LABELS[type] || TYPE_LABELS.unknown);
  let media_meta = null;
  if (media && typeof media === 'object') {
    media_meta = {
      id: media.id || null,
      mime_type: media.mime_type || null,
      filename: media.filename || null,
      // a caption, if any, is worth showing alongside the label
      caption: media.caption || null,
      voice: isVoice || null,           // distinguishes a voice note from a music file
      // location specifics
      latitude: media.latitude ?? null,
      longitude: media.longitude ?? null,
      name: media.name || null,
    };
  }
  if (type === 'unsupported') {
    // WhatsApp sometimes says what it could not hand over (an album marker, a
    // poll, a view-once photo). Kept so the inbox can tell them apart.
    try {
      const said = JSON.stringify({ unsupported: msg.unsupported ?? null, errors: msg.errors ?? null });
      if (said.length <= 1000) media_meta = { ...(media_meta || {}), said: JSON.parse(said) };
    } catch (_) { /* never fail the webhook over a label */ }
  }
  if (replyTo) media_meta = { ...(media_meta || {}), reply_to: replyTo };
  // If there's a caption, fold it into the preview for nicer list text.
  const caption = media_meta && media_meta.caption;
  const body = caption ? `${label} · ${caption}` : label;
  return { body, media_meta };
}

// Ticks only move forward. Meta can deliver "delivered" after "read", and a
// late one must not take the blue ticks back.
const STATUS_ORDER = ['pending', 'sent', 'delivered', 'read', 'played'];
function statusesBefore(status) {
  if (status === 'failed') return ['pending', 'sent', 'failed'];
  const at = STATUS_ORDER.indexOf(status);
  return at < 0 ? null : STATUS_ORDER.slice(0, at);
}

// Everything WhatsApp says about a refusal: the title alone ("Media upload
// error") does not say why.
function failureText(e) {
  const title = e.title || e.message || 'Delivery failed';
  const detail = (e.error_data && e.error_data.details) || (e.message !== title ? e.message : '');
  let text = e.code ? `${title} (${e.code})` : title;
  if (detail && detail !== title) text += `: ${detail}`;
  return text.slice(0, 600);
}

// Ensure the conversation row exists and refresh its preview. Deliberately
// does NOT touch unread_count: the bump is conditional on the message row
// actually being new (see bumpUnread), because this runs on every delivery
// including Meta's retries.
async function upsertConversationPreview(db, { wa_id, phone_number_id, profile_name, previewText, atIso }) {
  const row = {
    wa_id,
    phone_number_id: phone_number_id || null,
    last_message_text: previewText,
    last_message_at: atIso,
    last_message_direction: 'in',
  };
  // Only set profile_name when we actually have one (don't overwrite with null).
  if (profile_name) row.profile_name = profile_name;

  const { error } = await db.from('conversations').upsert(row, { onConflict: 'wa_id' });
  if (error) throw new Error(`conversation upsert failed: ${error.message}`);
}

// Incremented in SQL so concurrent inbound messages cannot lose a count the way
// the old read-then-write could.
async function bumpUnread(db, wa_id) {
  const { error } = await db
    .from('conversations')
    .upsert({ wa_id }, { onConflict: 'wa_id', increment: { unread_count: 1 } });
  if (error) throw new Error(`unread bump failed: ${error.message}`);
}

// Main entry: process one webhook body. Returns a small summary for logging.
// `dbOverride` lets tests inject a fake Supabase-shaped client.
async function ingestWebhook(body, dbOverride) {
  const db = dbOverride || getDb();
  const summary = { messages: 0, statuses: 0, contacts: 0, media: 0 };
  const mediaJobs = [];
  const refusedVoice = [];

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

        // Reactions aren't standalone messages — they attach an emoji to one of
        // OUR messages. Update that target row instead of inserting a bubble.
        if (msg.type === 'reaction' && msg.reaction) {
          const targetId = msg.reaction.message_id;
          const emoji = msg.reaction.emoji || null; // empty string => reaction removed
          if (targetId) {
            await db
              .from('messages')
              .update({ reaction: emoji || null })
              .eq('wa_message_id', targetId);
          }
          // Surface the reaction in the inbox like WhatsApp does: bump the
          // conversation (rises in the list, shows a preview, increments unread)
          // so the agent is notified without having to be in the chat. A
          // reaction REMOVAL (empty emoji) only clears the bubble pill above —
          // no bump, so un-reacting doesn't ping the agent.
          if (emoji) {
            await upsertConversationPreview(db, {
              wa_id,
              phone_number_id: phoneNumberId,
              profile_name: nameByWaId[wa_id] || null,
              previewText: `${emoji} Reacted to your message`,
              atIso,
            });
            await bumpUnread(db, wa_id);
            push.noteInbound(wa_id, `${emoji} Reacted to your message`);
          }
          summary.messages++;
          continue;
        }

        const { body: text, media_meta } = describeMessage(msg);
        const profile_name = nameByWaId[wa_id] || null;

        // Does this message carry downloadable media (vs. location/contacts/text)?
        const hasMedia = Boolean(media_meta && media_meta.id);
        const mediaStatus = hasMedia ? 'pending' : null;

        // Conversation first (messages FK to it).
        await upsertConversationPreview(db, {
          wa_id,
          phone_number_id: phoneNumberId,
          profile_name,
          previewText: text,
          atIso,
        });

        // Idempotent insert. DO NOTHING + RETURNING gives back a row only when
        // this delivery actually inserted one, which is what tells a first
        // delivery apart from a Meta retry.
        const { data: inserted, error: msgErr } = await db.from('messages').upsert(
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
        ).select();
        if (msgErr) throw new Error(`message upsert failed: ${msgErr.message}`);

        // Only a genuinely new message makes the inbox unread. A retry must not.
        if (Array.isArray(inserted) ? inserted.length : inserted) {
          await bumpUnread(db, wa_id);
          push.noteInbound(wa_id, text);
        }
        summary.messages++;

        // Queue a media download job (processed after the row is durable).
        if (hasMedia && msg.id) {
          mediaJobs.push({
            wa_message_id: msg.id,
            wa_id,
            mediaId: media_meta.id,
            kind: msg.type,
            filename: media_meta.filename,
            media_meta,
          });
        }
      }

      // --- status updates for messages WE sent ---
      for (const st of value.statuses || []) {
        summary.statuses++;
        const waMessageId = st.id;
        if (!waMessageId) continue;
        const patch = { status: st.status };
        if (st.status === 'failed') patch.error = failureText((st.errors && st.errors[0]) || {});
        // Only updates an existing outgoing row; no-op if we don't have it.
        let q = db.from('messages').update(patch).eq('wa_message_id', waMessageId);
        const before = statusesBefore(st.status);
        if (before) q = q.in('status', before);
        await q;
        if (st.status === 'failed' && voiceFallback.REFUSED_MEDIA.test(patch.error)) refusedVoice.push(waMessageId);
      }
    }
  }

  // A refused voice note goes out once more as an audio file, by itself.
  for (const waMessageId of refusedVoice) {
    try {
      if (await voiceFallback.resendRefused(db, waMessageId)) summary.resent = (summary.resent || 0) + 1;
    } catch (e) {
      console.error(`Voice note re-send failed for ${waMessageId}:`, e.message);
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

      const stored = await mediaFetcher(job.mediaId, job.wa_id, job.kind, job.filename);
      const patch = { media_path: stored.path, media_status: 'stored' };
      if (stored.pixels) patch.media_meta = withSize(job.media_meta, stored.pixels);
      await db
        .from('messages')
        .update(patch)
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

module.exports = { ingestWebhook, describeMessage, failureText, TYPE_LABELS, __setMediaFetcher };
