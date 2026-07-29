// Shared template-send core for both send-template routes: the token-gated
// service one (lib/serviceRoutes.js) and the passcode-gated inbox one
// (lib/routes.js). Each router keeps its own auth and its own allow-list
// policy; everything after that — idempotency reservation, the Graph call,
// settling the row, the inbox preview — is identical and lives here.
//
// resolveKey/markFailed/markSent are the key lifecycle for all THREE outbound
// paths (/api/send and /api/send-media too), so text, media and template make
// one dedupe decision. What each persists differs, so that stays in the routes.

const wa = require('./whatsapp');
const idem = require('./idempotency');

// Extract the body-parameter texts for the inbox preview line.
function previewFromComponents(name, components) {
  const texts = [];
  for (const c of components || []) {
    for (const p of c.parameters || []) {
      if (p.type === 'text' && p.text) texts.push(p.text);
    }
  }
  return `📋 [${name}] ${texts.join(' · ')}`.trim();
}

// A dedupe hit only short-circuits when the original attempt reached Meta
// (sent/delivered/read, or any row carrying a wa_message_id) or is still in
// flight ('pending'). A 'failed' row never reached Meta, so deduping onto it
// would report a send that never happened.
function resendable(row) {
  return row.status === 'failed' && !row.wa_message_id;
}

function dedupeResult(row) {
  return { status: 200, body: { ok: true, deduped: true, id: row.id, waMessageId: row.wa_message_id || null } };
}

// Reserve the key before the Meta call. `fields` is the row this path persists.
// -> { row }      send now, then settle THIS row (fresh, or a failed one to re-send)
//    { deduped }  answer the replay with this row, send nothing
//    { conflict } lost the race and the winner is unreadable
//    { skip }     no dedupe available: caller runs its keyless path
async function resolveKey(db, key, fields) {
  const found = await idem.findByKey(db, key);
  if (found.row) return resendable(found.row) ? { row: found.row } : { deduped: found.row };
  if (found.skip) return { skip: true };

  // Conversation first (messages FK to it); the preview is set post-send.
  await db.from('conversations').upsert({ wa_id: fields.wa_id }, { onConflict: 'wa_id' });
  const r = await idem.reserve(db, key, fields);
  if (r.existing) return resendable(r.existing) ? { row: r.existing } : { deduped: r.existing };
  if (r.conflict) return { conflict: true };
  return r.row ? { row: r.row } : { skip: true };
}

// Both settle the reservation in place, so a re-send never leaves a second row
// under the key. Return the builder, so a caller needing the settled row back
// can chain .select().single().
function markFailed(db, id, error, extra) {
  return db.from('messages').update({ status: 'failed', error, ...extra }).eq('id', id);
}

function markSent(db, id, waMessageId, extra) {
  return db
    .from('messages')
    .update({ wa_message_id: waMessageId || null, status: 'sent', error: null, ...extra })
    .eq('id', id);
}

// `db` is the Supabase client, or null when it isn't configured (the send still
// goes out, it just isn't persisted). -> { status, body } for the caller to
// return verbatim.
async function sendTemplateFlow(db, { waId, template, language, components, key }) {
  const body = previewFromComponents(template, components);
  const nowIso = new Date().toISOString();

  let reserved = null;
  if (key && db) {
    const k = await resolveKey(db, key, {
      wa_id: waId,
      direction: 'out',
      type: 'text',
      body,
      wa_timestamp: nowIso,
    });
    if (k.deduped) return dedupeResult(k.deduped);
    if (k.conflict) return { status: 409, body: { error: 'Duplicate request already in flight.' } };
    if (k.row) reserved = k.row;
    // k.skip -> keyless behavior below.
  }

  const result = await wa.sendTemplate(waId, {
    name: template,
    language: language || 'en',
    components: Array.isArray(components) ? components : [],
  });
  if (!result.ok) {
    if (reserved) {
      // Leave a retryable failed row: a later request with the same key
      // re-sends onto it, as does POST /api/retry/:id.
      await markFailed(db, reserved.id, result.error);
    }
    return { status: 502, body: { error: result.error } };
  }

  // Persist into the inbox thread like a human-sent message, so agents see
  // what was sent. Failure to persist must not fail the send.
  if (reserved) {
    try {
      await markSent(db, reserved.id, result.waMessageId);
      await db
        .from('conversations')
        .upsert(
          { wa_id: waId, last_message_text: body, last_message_at: nowIso, last_message_direction: 'out' },
          { onConflict: 'wa_id' },
        );
    } catch (e) {
      console.error('template send persisted-failed:', e);
    }
  } else if (db) {
    try {
      await db
        .from('conversations')
        .upsert(
          { wa_id: waId, last_message_text: body, last_message_at: nowIso, last_message_direction: 'out' },
          { onConflict: 'wa_id' },
        );
      await db.from('messages').insert({
        wa_message_id: result.waMessageId || null,
        wa_id: waId,
        direction: 'out',
        type: 'text',
        body,
        status: 'sent',
        wa_timestamp: nowIso,
      });
    } catch (e) {
      console.error('template send persisted-failed:', e);
    }
  }

  return { status: 200, body: { ok: true, waMessageId: result.waMessageId || null } };
}

module.exports = { sendTemplateFlow, resolveKey, markFailed, markSent };
