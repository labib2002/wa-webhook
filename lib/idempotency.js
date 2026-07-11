// Optional client-supplied idempotency keys for outbound sends
// (/api/send, /api/send-media, /api/service/send-template).
//
// Callers pass `x-idempotency-key` (header) or `client_key` (body field);
// the header wins. Keys land in messages.client_key, UNIQUE when present
// (migration 007). To avoid a double-send race the flow is reserve-first:
//   1) SELECT by key: found -> return it deduped, nothing is sent.
//   2) INSERT a status='pending' reservation BEFORE calling Meta. A
//      concurrent duplicate loses this insert (23505), reads the winner's
//      row and returns it deduped, so only one request reaches Meta.
//   3) After the Meta call, UPDATE the reservation to sent (or failed, which
//      POST /api/retry/:id can pick up).
// Requests without a key skip all of this and behave exactly as before.
//
// Degradation: until migration 007 runs (client_key column missing: 42703 /
// PGRST204) or on any other DB error in these helpers, the send proceeds
// WITHOUT dedupe, exactly as pre-feature. One console.error, never a 500.

let warned = false;

function warnDisabled(e) {
  if (warned) return;
  warned = true;
  console.error(
    'idempotency disabled, sending without dedupe (run migration 007_hardening.sql?):',
    (e && (e.code || e.message)) || e
  );
}

// -> { key: string|null, invalid?: string }
function keyFromRequest(req) {
  const header = req.headers['x-idempotency-key'];
  const bodyKey = req.body && req.body.client_key;
  const raw = header != null && String(header).trim() !== '' ? header : bodyKey;
  if (raw == null) return { key: null };
  const key = String(raw).trim();
  if (!key) return { key: null };
  if (key.length > 128) return { key: null, invalid: 'Idempotency key too long (max 128 chars).' };
  return { key };
}

// -> { row } (dedupe hit), { row: null } (key free), { skip: true } (degrade).
async function findByKey(db, key) {
  const { data, error } = await db
    .from('messages')
    .select('*')
    .eq('client_key', key)
    .limit(1)
    .maybeSingle();
  if (error) {
    warnDisabled(error);
    return { skip: true };
  }
  return { row: data || null };
}

// Insert the pending reservation row carrying the key.
// -> { row }        reserved: caller sends, then settles the row
//    { existing }   lost the insert race: return it deduped, do NOT send
//    { conflict }   race detected but winner's row unreadable: caller 409s
//    { skip }       column missing / DB error: degrade to keyless behavior
async function reserve(db, key, fields) {
  const { data, error } = await db
    .from('messages')
    .insert({ ...fields, client_key: key, status: 'pending' })
    .select()
    .single();
  if (!error) return { row: data };
  if (error.code === '23505') {
    const again = await db
      .from('messages')
      .select('*')
      .eq('client_key', key)
      .limit(1)
      .maybeSingle();
    if (!again.error && again.data) return { existing: again.data };
    return { conflict: true };
  }
  warnDisabled(error);
  return { skip: true };
}

module.exports = { keyFromRequest, findByKey, reserve };
