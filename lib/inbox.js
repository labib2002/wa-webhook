// The conversation list: which chats a view shows, search, and paging.
//
// Every chat is read once per request and narrowed here rather than in SQL.
// There are a few hundred of them, each row is small, and the views need the
// member lookup, which SQL run as wa_app cannot join against.

const db = require('./db');
const phone = require('../web/phone');
const { membersFor } = require('./members');
const { makeWarner } = require('./warn');

const LIST_COLS = 'wa_id, profile_name, last_message_text, last_message_at, last_message_direction, unread_count';
const MAX_CHATS = 5000;
const PAGE = 60;
const MAX_PAGE = 300;
const TEMPLATE_TTL_MS = 60 * 1000;
const MESSAGE_HITS = 30;
const RECENT = 30;

const warnNoSavedNames = makeWarner('conversations.display_name missing, saved names are off');
const warnTooMany = makeWarner(`more than ${MAX_CHATS} chats, the oldest are left out of the list`);
const warnTemplates = makeWarner('template-only lookup failed, those chats stay in the main list');
const warnSearch = makeWarner('message search failed, searching names and numbers only');

function readAll(conn, cols) {
  return conn.from('conversations').select(cols)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(MAX_CHATS + 1);
}

async function allChats(conn, features) {
  const extra = features.done ? ', done_at' : '';
  let { data, error } = await readAll(conn, `${LIST_COLS}, display_name${extra}`);
  if (error && error.code === '42703') {
    warnNoSavedNames(error);
    ({ data, error } = await readAll(conn, LIST_COLS));
  }
  if (error) throw error;
  const rows = data || [];
  if (rows.length > MAX_CHATS) { warnTooMany(rows.length); rows.length = MAX_CHATS; }
  return rows;
}

// The member wrote last and nobody has answered or marked the chat done, or
// an agent flagged it by hand.
function needsReply(c) {
  if ((c.unread_count || 0) > 0) return true;
  if (c.last_message_direction !== 'in' || !c.last_message_at) return false;
  return !c.done_at || Date.parse(c.done_at) < Date.parse(c.last_message_at);
}

// Chats that hold nothing but templates we sent: a bulk send from the ops
// dashboard makes hundreds of them, and they would bury the real ones.
async function sqlTemplateOnly() {
  const { rows } = await db.raw(`
    SELECT c.wa_id FROM conversations c
    WHERE EXISTS (SELECT 1 FROM messages m WHERE m.wa_id = c.wa_id)
      AND NOT EXISTS (
        SELECT 1 FROM messages m WHERE m.wa_id = c.wa_id
          AND (m.direction = 'in'
               OR NOT (coalesce(m.media_meta, '{}'::jsonb) ? 'template' OR m.body LIKE '📋%')))`);
  return new Set(rows.map((r) => r.wa_id));
}
let templateOnlyImpl = sqlTemplateOnly;
let templateCache = { at: 0, set: null };

async function templateOnly() {
  if (templateCache.set && Date.now() - templateCache.at < TEMPLATE_TTL_MS) return templateCache.set;
  try {
    templateCache = { at: Date.now(), set: await templateOnlyImpl() };
  } catch (e) {
    warnTemplates(e);
    templateCache = { at: Date.now(), set: templateCache.set || new Set() };
  }
  return templateCache.set;
}

// A reply or an inbound message changes which chats are template-only.
function forgetTemplateOnly(waId) {
  if (templateCache.set && waId) templateCache.set.delete(waId);
}

const PHONE_QUERY = /^[\d\s+().\-٠-٩۰-۹‎‏‪-‮]+$/;
function matchesQuery(c, q) {
  const ql = q.toLowerCase();
  const m = c.member || {};
  if ([c.display_name, c.profile_name, m.name, m.company].some((t) => t && String(t).toLowerCase().includes(ql))) return true;
  if (!PHONE_QUERY.test(q)) return false;
  const id = String(c.wa_id || '');
  return phone.searchKeys(q).some((k) => id.includes(k));
}

async function sqlMessageSearch(q) {
  const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const { rows } = await db.raw(`
    SELECT * FROM (
      SELECT DISTINCT ON (wa_id) wa_id, id, body, direction, coalesce(wa_timestamp, created_at) AS at
      FROM messages
      WHERE body ILIKE $1 AND type IN ('text', 'button', 'interactive', 'image', 'video', 'document')
      ORDER BY wa_id, coalesce(wa_timestamp, created_at) DESC
    ) hits ORDER BY at DESC LIMIT ${MESSAGE_HITS}`, [like]);
  return rows;
}
let messageSearchImpl = sqlMessageSearch;

async function messageHits(q) {
  if (q.length < 2) return [];
  try {
    return await messageSearchImpl(q);
  } catch (e) {
    warnSearch(e);
    return [];
  }
}

function snippet(body, q) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0 || text.length <= 90) return text.slice(0, 90);
  const from = Math.max(0, at - 30);
  return `${from ? '…' : ''}${text.slice(from, from + 90)}${from + 90 < text.length ? '…' : ''}`;
}

// -> { conversations, members_available, total, next, counts, message_hits, recent }
async function list(conn, features, { view = 'chats', q = '', offset = 0, limit = PAGE } = {}) {
  const rows = await allChats(conn, features);
  const members = await membersFor(rows.map((c) => c.wa_id));
  const templates = await templateOnly();
  const chats = rows.map((c) => ({
    ...c,
    member: members ? members.get(c.wa_id) || null : null,
    needs_reply: needsReply(c),
    template_only: templates.has(c.wa_id),
  }));

  const counts = {
    needs_reply: chats.filter((c) => c.needs_reply).length,
    templates: chats.filter((c) => c.template_only && !c.needs_reply).length,
    unread: chats.reduce((n, c) => n + (c.unread_count || 0), 0),
  };

  const query = String(q || '').trim();
  let shown;
  let hits = [];
  if (query) {
    shown = chats.filter((c) => matchesQuery(c, query));
    const byId = new Map(chats.map((c) => [c.wa_id, c]));
    hits = (await messageHits(query))
      .filter((h) => byId.has(h.wa_id))
      .map((h) => ({ ...byId.get(h.wa_id), hit: { message_id: h.id, text: snippet(h.body, query), at: h.at, direction: h.direction } }));
  } else if (view === 'needs_reply') {
    shown = chats.filter((c) => c.needs_reply);
  } else if (view === 'templates') {
    shown = chats.filter((c) => c.template_only && !c.needs_reply);
  } else {
    shown = chats.filter((c) => !c.template_only || c.needs_reply);
  }

  const from = Math.max(0, parseInt(offset, 10) || 0);
  const size = Math.min(MAX_PAGE, Math.max(1, parseInt(limit, 10) || PAGE));
  const page = shown.slice(from, from + size);
  return {
    conversations: page,
    members_available: Boolean(members),
    total: shown.length,
    next: from + size < shown.length ? from + size : null,
    counts,
    message_hits: hits,
    // The newest chats whatever the view or search, so the tab still chimes
    // for a new message while the agent is looking at something else.
    recent: chats.slice(0, RECENT),
  };
}

function __setForTesting({ templateOnly: t, messageSearch: s } = {}) {
  templateOnlyImpl = t || sqlTemplateOnly;
  messageSearchImpl = s || sqlMessageSearch;
  templateCache = { at: 0, set: null };
}

module.exports = { list, needsReply, matchesQuery, snippet, forgetTemplateOnly, PAGE, __setForTesting };
