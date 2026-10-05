// Which member, HR contact or coordinator a WhatsApp number belongs to.
//
// wa_app reaches no platform table. The one way in is wa_lookup.members(text[])
// from db/migrations/009_member_lookup.sql: an admin-owned function that takes
// wa_ids and returns name + company for the numbers that match a roster row,
// an app account or a company contact. Until it is installed, or while it
// errors, membersFor() answers null and the inbox shows no company at all
// rather than a wrong "Not a member".

const db = require('./db');
const { makeWarner } = require('./warn');

const TTL_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const TIMEOUT_MS = 2000;
const MAX_CACHED = 5000;
const SOURCE_RANK = { roster: 0, app: 1, contact: 2 };

const warnDown = makeWarner('member lookup unavailable, showing no companies');
const cache = new Map();
let downUntil = 0;

async function sqlLookup(waIds) {
  const { rows } = await db.raw(
    'SELECT wa_id, source, kind, name, company, active FROM wa_lookup.members($1::text[])',
    [waIds],
  );
  return rows;
}
let lookupImpl = sqlLookup;
let timeoutMs = TIMEOUT_MS;

// A number can sit on a roster, an app account and a contact list at once, or
// on two companies' rosters after a move. Show one: active first, then the
// roster's spelling of the name, and count the other companies.
function pick(rows) {
  const sorted = [...rows].sort((a, b) =>
    (Number(Boolean(b.active)) - Number(Boolean(a.active))) ||
    ((SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9)));
  const best = sorted[0];
  const companies = new Set(rows.map((r) => r.company).filter(Boolean));
  return {
    name: best.name || (sorted.find((r) => r.name) || {}).name || null,
    company: best.company || null,
    kind: best.kind || 'member',
    active: Boolean(best.active),
    more: Math.max(0, companies.size - (best.company ? 1 : 0)),
  };
}

// The list poll waits on this, so a slow lookup must never hold the inbox up.
function withTimeout(promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('member lookup timed out'), { code: 'LOOKUP_TIMEOUT' })), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// -> Map(wa_id -> member | null), or null when the lookup is unavailable.
async function membersFor(waIds) {
  const now = Date.now();
  if (now < downUntil) return null;
  const ids = [...new Set((waIds || []).filter(Boolean).map(String))];
  const stale = ids.filter((id) => {
    const hit = cache.get(id);
    return !hit || now - hit.at > TTL_MS;
  });
  if (stale.length) {
    let rows;
    try {
      rows = await withTimeout(lookupImpl(stale));
    } catch (e) {
      warnDown(e);
      downUntil = now + RETRY_MS;
      return null;
    }
    if (cache.size > MAX_CACHED) cache.clear();
    const grouped = new Map(stale.map((id) => [id, []]));
    for (const r of rows || []) if (grouped.has(r.wa_id)) grouped.get(r.wa_id).push(r);
    for (const [id, list] of grouped) cache.set(id, { at: now, member: list.length ? pick(list) : null });
  }
  return new Map(ids.map((id) => [id, (cache.get(id) || {}).member || null]));
}

function __setLookupForTesting(fn, opts = {}) {
  lookupImpl = fn || sqlLookup;
  timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  cache.clear();
  downUntil = 0;
}

module.exports = { membersFor, pick, __setLookupForTesting };
