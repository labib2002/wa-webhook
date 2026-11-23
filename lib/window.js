// WhatsApp lets a free message through only within 24 hours of the member's
// last one. The send routes ask here first and refuse without calling
// WhatsApp, so an agent never sees the refusal after the fact.

const WINDOW_MS = 24 * 60 * 60 * 1000;
const CLOSED = 'The 24 hours are over. Only a template can be sent.';
const NEVER = 'They have not written to this number yet. Only a template can be sent.';

async function lastInboundAt(db, waId) {
  const { data, error } = await db.from('messages').select('wa_timestamp, created_at')
    .eq('wa_id', waId).eq('direction', 'in')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data ? (data.wa_timestamp || data.created_at) : null;
}

// { open, last, error }. A read that fails counts as open: WhatsApp still
// refuses a closed window, and a database hiccup must not block a reply.
async function check(db, waId, now = Date.now()) {
  try {
    const last = await lastInboundAt(db, waId);
    if (!last) return { open: false, last: null, error: NEVER };
    const at = Date.parse(last);
    if (!Number.isFinite(at)) return { open: true, last };
    return at + WINDOW_MS > now ? { open: true, last } : { open: false, last, error: CLOSED };
  } catch (_) {
    return { open: true, last: null };
  }
}

module.exports = { check, lastInboundAt, WINDOW_MS, CLOSED, NEVER };
