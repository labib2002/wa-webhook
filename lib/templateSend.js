// Shared template-send core for both send-template routes: the token-gated
// service one (lib/serviceRoutes.js) and the passcode-gated inbox one
// (lib/routes.js). Each router keeps its own auth and its own allow-list
// policy; everything after that — idempotency reservation, the Graph call,
// settling the row, the inbox preview — is identical and lives here.

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

// `db` is the Supabase client, or null when it isn't configured (the send still
// goes out, it just isn't persisted). -> { status, body } for the caller to
// return verbatim.
async function sendTemplateFlow(db, { waId, template, language, components, key }) {
  const body = previewFromComponents(template, components);
  const nowIso = new Date().toISOString();

  let reserved = null;
  if (key && db) {
    const found = await idem.findByKey(db, key);
    if (found.row) {
      if (!resendable(found.row)) return dedupeResult(found.row);
      reserved = found.row;
    } else if (!found.skip) {
      await db.from('conversations').upsert({ wa_id: waId }, { onConflict: 'wa_id' });
      const r = await idem.reserve(db, key, {
        wa_id: waId,
        direction: 'out',
        type: 'text',
        body,
        wa_timestamp: nowIso,
      });
      if (r.existing) {
        if (!resendable(r.existing)) return dedupeResult(r.existing);
        reserved = r.existing;
      } else if (r.conflict) {
        return { status: 409, body: { error: 'Duplicate request already in flight.' } };
      } else if (r.row) {
        reserved = r.row;
      }
      // r.skip -> keyless behavior below.
    }
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
      await db.from('messages')
        .update({ status: 'failed', error: result.error })
        .eq('id', reserved.id);
    }
    return { status: 502, body: { error: result.error } };
  }

  // Persist into the inbox thread like a human-sent message, so agents see
  // what was sent. Failure to persist must not fail the send.
  if (reserved) {
    try {
      await db.from('messages')
        .update({ wa_message_id: result.waMessageId || null, status: 'sent', error: null })
        .eq('id', reserved.id);
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

module.exports = { sendTemplateFlow };
