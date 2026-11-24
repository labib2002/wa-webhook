/* =============================================================================
   Agent Inbox — frontend SPA (vanilla, no build step)
   Talks only to the signed-in /api/* routes. Stays live via smart polling
   (list every 4s, open thread every 2.5s incrementally), paused when the tab
   is hidden and refreshed on focus. Optimistic send for instant feedback.
   ============================================================================= */

const $ = (sel) => document.querySelector(sel);
const { toWaId, formatWaId, searchKeys } = window.WaPhone;
const WaTpl = window.WaTpl;

const els = {
  body: document.body,
  login: $('#login-screen'),
  loginForm: $('#login-form'),
  loginBtn: $('#login-btn'),
  loginError: $('#login-error'),
  loginEmail: $('#login-email'),
  loginPassword: $('#login-password'),
  app: $('#app'),
  logoutBtn: $('#logout-btn'),
  search: $('#search'),
  convList: $('#conv-list'),
  listFilters: $('#list-filters'),
  viewPill: $('#view-pill'),
  convEmpty: $('#conv-empty'),
  convLoading: $('#conv-loading'),
  placeholder: $('#thread-placeholder'),
  thread: $('#thread'),
  backBtn: $('#back-btn'),
  threadAvatar: $('#thread-avatar'),
  threadName: $('#thread-name-text'),
  threadNameBtn: $('#thread-name'),
  threadPeer: $('#thread-peer'),
  threadMember: $('#thread-member'),
  renameModal: $('#rename-modal'),
  renameForm: $('#rename-form'),
  renameInput: $('#rename-input'),
  renameError: $('#rename-error'),
  renameCancel: $('#rename-cancel'),
  renameSubmit: $('#rename-submit'),
  messages: $('#messages'),
  threadLoading: $('#thread-loading'),
  messagesEmpty: $('#messages-empty'),
  composerForm: $('#composer-form'),
  composer: $('.composer'),
  composerInput: $('#composer-input'),
  composerBanner: $('#composer-banner'),
  replyBar: $('#reply-bar'),
  replyName: $('#reply-name'),
  replyText: $('#reply-text'),
  replyCancel: $('#reply-cancel'),
  sendBtn: $('#send-btn'),
  attachBtn: $('#attach-btn'),
  fileInput: $('#file-input'),
  attachPreview: $('#attach-preview'),
  attachThumbImg: $('#attach-thumb-img'),
  attachThumbIco: $('#attach-thumb-ico'),
  attachName: $('#attach-name'),
  attachSize: $('#attach-size'),
  attachRemove: $('#attach-remove'),
  micBtn: $('#mic-btn'),
  recBar: $('#rec-bar'),
  recTime: $('#rec-time'),
  recCancel: $('#rec-cancel'),
  recSend: $('#rec-send'),
  recPause: $('#rec-pause'),
  recDot: $('#rec-dot'),
  recHint: $('#rec-hint'),
  newChatBtn: $('#new-chat-btn'),
  newChatModal: $('#new-chat-modal'),
  newChatForm: $('#new-chat-form'),
  newChatNumber: $('#new-chat-number'),
  newChatName: $('#new-chat-name'),
  newChatHint: $('#new-chat-hint'),
  newChatError: $('#new-chat-error'),
  newChatCancel: $('#new-chat-cancel'),
  followupBtn: $('#followup-btn'),
  followupModal: $('#followup-modal'),
  followupForm: $('#followup-form'),
  followupName: $('#followup-name'),
  followupProgram: $('#followup-program'),
  followupLangs: $('#followup-langs'),
  followupPreview: $('#followup-preview'),
  followupError: $('#followup-error'),
  followupCancel: $('#followup-cancel'),
  followupSubmit: $('#followup-submit'),
  forwardModal: $('#forward-modal'),
  forwardSearch: $('#forward-search'),
  forwardList: $('#forward-list'),
  forwardEmpty: $('#forward-empty'),
  forwardError: $('#forward-error'),
  forwardCancel: $('#forward-cancel'),
  forwardSubmit: $('#forward-submit'),
  toast: $('#toast'),
  meBtn: $('#me-btn'),
  meInitials: $('#me-initials'),
  meMenu: $('#me-menu'),
  meName: $('#me-name'),
  meEmail: $('#me-email'),
  meReplies: $('#me-replies'),
  meNotify: $('#me-notify'),
  doneBtn: $('#done-btn'),
  windowBar: $('#window-bar'),
  windowText: $('#window-text'),
  windowAction: $('#window-action'),
  repliesBtn: $('#replies-btn'),
  replyPicker: $('#reply-picker'),
  replyPickerList: $('#reply-picker-list'),
  replyPickerManage: $('#reply-picker-manage'),
  repliesModal: $('#replies-modal'),
  repliesList: $('#replies-list'),
  repliesForm: $('#replies-form'),
  repliesTitle: $('#replies-title-input'),
  repliesBody: $('#replies-body-input'),
  repliesError: $('#replies-error'),
  repliesDelete: $('#replies-delete'),
  repliesClose: $('#replies-close'),
  repliesSave: $('#replies-save'),
  sheet: $('#sheet'),
  sheetReactions: $('#sheet-reactions'),
  sheetActions: $('#sheet-actions'),
  peerSheet: $('#peer-sheet'),
  peerAvatar: $('#peer-avatar'),
  peerName: $('#peer-name'),
  peerRows: $('#peer-rows'),
};
const filtersBar = { tucked: false, frame: 0, shownAt: 0, pullFrom: null };

const state = {
  conversations: [],      // latest list snapshot
  membersAvailable: false, // false: the member lookup is off, so never say "Not a member"
  renameWaId: null,
  filter: '',             // what is typed in the search box
  view: 'chats',          // 'chats' | 'needs_reply'
  known: new Map(),       // wa_id -> the newest row seen for that chat, in or out of the list
  recent: [],             // the newest chats whatever the view or search shows
  list: { total: 0, next: null, counts: {}, hits: [], more: false },
  teamwork: false,        // the server keeps a chat unread until it is answered or marked done
  agentNames: false,      // the server stores who sent each message
  savedReplies: [],
  activeWaId: null,
  forward: null,          // { msgId, selected: Set(wa_id), search } while the picker is open
  replyTo: null,          // { waId, msg } the next send quotes, set by a bubble's Reply
  followupLang: 'ar',     // template language for the follow-up modal
  threads: {},            // wa_id -> { byId: Map(id->msg), order: [ids], lastMsgId, loaded }
  drafts: {},             // wa_id -> unsent composer text (preserved across chat switches)
  sending: false,
  listTimer: null,
  threadTimer: null,
  optimisticSeq: -1,      // negative ids for optimistic bubbles
  pendingFile: null,      // { name, mime, size, base64, dataUrl } staged to send
  templates: [],          // approved template copy from /api/templates
  rec: null,              // active voice recorder { mediaRecorder, stream, chunks, timer, startedAt }
};

// Get (or create) the cached thread for a wa_id.
function thread(waId) {
  if (!state.threads[waId]) {
    state.threads[waId] = { byId: new Map(), order: [], maxUpdatedAt: null, loaded: false };
  }
  return state.threads[waId];
}

// Ticks only move forward on screen. An answer that left the server before a
// newer one can arrive after it, and the automatic re-send of a refused voice
// note passes through failed and pending on its way to the next tick: in both
// cases the bubble keeps the ticks it already showed.
const TICK_RANK = { pending: 0, sent: 1, delivered: 2, read: 3, played: 4 };
const REFUSED_VOICE = /media upload error|131053/i;
function resendingVoice(m) {
  const mm = m.media_meta || {};
  if (mm.voice !== true && !mm.auto_resend) return false;
  if (m.status === 'pending') return Boolean(mm.auto_resend);
  if (m.status !== 'failed' || mm.auto_resend || !REFUSED_VOICE.test(m.error || '')) return false;
  return Date.now() - Date.parse(m.created_at || 0) < 15 * 60 * 1000;
}
function shownStatus(existing, m) {
  const was = TICK_RANK[existing.status];
  if (was === undefined || was === 0) return m.status;
  if (resendingVoice(m)) return existing.status;
  const now = TICK_RANK[m.status];
  if (now !== undefined && now < was) return existing.status;
  return m.status;
}

// Merge a batch of message rows into a thread, deduping by id. Returns true if
// anything visible changed (new message, or an existing one's status/reaction/
// body updated). Also advances the thread's updated_at high-water mark.
function mergeMessages(t, rows) {
  let changed = false;
  for (const m of rows) {
    const existing = t.byId.get(m.id);
    if (!existing) {
      // drop the client-side twin (same body+direction) the server now confirms.
      // Match on the negative id, not on _optimistic: a failed send clears that
      // flag but keeps its local id, and matching only the flag left the server
      // row to land beside it as a second bubble.
      for (let i = t.order.length - 1; i >= 0; i--) {
        const o = t.byId.get(t.order[i]);
        const local = o && (o._optimistic || (typeof o.id === 'number' && o.id < 0));
        if (!local) continue;
        const twin = o.client_key && m.client_key
          ? o.client_key === m.client_key
          : o.direction === m.direction && o.body === m.body && o.type === m.type;
        if (twin) {
          takeOver(o, m);
          t.byId.delete(o.id); t.order.splice(i, 1); break;
        }
      }
      t.byId.set(m.id, m);
      t.order.push(m.id);
      changed = true;
    } else {
      const status = shownStatus(existing, m);
      const error = status === m.status ? (m.error || '') : (existing.error || '');
      if (
        existing.status !== status || existing.reaction !== m.reaction || ourReaction(existing) !== ourReaction(m) ||
        existing.media_status !== m.media_status || existing.body !== m.body ||
        (existing.error || '') !== error
      ) {
        t.byId.set(m.id, { ...existing, ...m, status, error: error || null });
        changed = true;
      }
    }
    if (m.updated_at && (!t.maxUpdatedAt || m.updated_at > t.maxUpdatedAt)) {
      t.maxUpdatedAt = m.updated_at;
    }
  }
  // order by time, then id — so optimistic (negative-id) sends still land last.
  t.order.sort((a, b) => {
    const ma = t.byId.get(a), mb = t.byId.get(b);
    const ta = new Date(ma.wa_timestamp || ma.created_at || 0).getTime();
    const tb = new Date(mb.wa_timestamp || mb.created_at || 0).getTime();
    if (ta !== tb) return ta - tb;
    return a - b;
  });
  return changed;
}

// The saved row takes the place of the bubble drawn before the send answered:
// same spot on screen, same photo or recording, so nothing is drawn twice.
function takeOver(local, row) {
  row._key = local._key || String(local.id);
  if (local._localUrl && !row._localUrl) row._localUrl = local._localUrl;
}

// byId is the source of truth; order is just the ordering index. Render each id
// once even if order briefly holds it twice, so no race can double a bubble.
function threadMessages(t) {
  const seen = new Set();
  const out = [];
  for (const id of t.order) {
    if (seen.has(id)) continue;
    seen.add(id);
    const m = t.byId.get(id);
    if (m) out.push(m);
  }
  return out.filter((m) => !isAlbumWrapper(m, out));
}

// When a member sends several photos or videos at once, WhatsApp also delivers
// one "unsupported" message that stands for the album. The photos arrive as
// their own messages, so that one is left out of the thread.
function isAlbumWrapper(m, msgs) {
  if (m.type !== 'unsupported' || m.direction !== 'in') return false;
  const timeOf = (o) => Date.parse(o.wa_timestamp || o.created_at);
  const isMedia = (o) => o.type === 'image' || o.type === 'video';
  const at = timeOf(m);
  const theirs = msgs.filter((o) => o !== m && o.direction === 'in');
  if (theirs.some((o) => isMedia(o) && Math.abs(timeOf(o) - at) <= 2000)) return true;
  // A big album can take a minute or more to upload. The marker is stamped
  // when the member pressed send, so the photos are their next messages.
  let next = null;
  for (const o of theirs) if (timeOf(o) > at && (!next || timeOf(o) < timeOf(next))) next = o;
  return Boolean(next && isMedia(next) && timeOf(next) - at <= 180000);
}

// Updates are pushed over /api/events; these polls are only the fallback
// while that stream is down, plus a slow safety net while it is up.
const LIST_POLL_MS = 4000;
const HIDDEN_LIST_POLL_MS = 10000;
const SAFETY_POLL_MS = 60000;
// Thread poll is cheap now (it fetches only rows changed since the high-water
// mark — usually nothing), so we can poll faster for snappy reactions/ticks.
const THREAD_POLL_MS = 1500;

/* ----------------------------- utilities ----------------------------- */

async function api(path, opts = {}) {
  const { headers, ...rest } = opts;
  let res;
  try {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      credentials: 'same-origin',
      ...rest,
    });
  } catch (_) {
    // No connection. Callers get an ordinary failed answer; a throw here used
    // to leave the composer locked until the page was reloaded.
    return { status: 0, ok: false, data: { error: 'No connection. Check the internet and try again.' } };
  }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (res.status === 401 && data && data.ended) endedNote = data.error;
  return { status: res.status, ok: res.ok, data: data || {} };
}

// Who is signed in on this device: the name on their staff account, which the
// server stores on every message they send.
let agentName = '';
let agentEmail = '';
let agentImage = null;
// Set when the server ends a session because the account lost its access.
let endedNote = '';
function setAgent(agent) {
  agentName = (agent && agent.name) || '';
  agentEmail = (agent && agent.email) || '';
  agentImage = (agent && agent.image && agent.image.url) ? agent.image : null;
  renderAgent();
}
try { localStorage.removeItem('wa_agent'); } catch (_) {}

// One idempotency key per user send action, REUSED when that same action is
// retried, so the server dedupes instead of double-sending (x-idempotency-key).
function newSendKey() {
  return (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function initials(name, waId) {
  const base = (name || '').trim();
  if (base) {
    const parts = base.split(/\s+/);
    return ((parts[0][0] || '') + (parts[1]?.[0] || '')).toUpperCase();
  }
  return (waId || '?').slice(-2);
}

// The name saved in this inbox wins, then the member's name from the roster or
// the app, then the WhatsApp profile name (WhatsApp never shares the name the
// person is saved under on anyone's phone).
function knownName(c) {
  const clean = (v) => (v && String(v).trim()) || '';
  return clean(c.display_name) || clean(c.member && c.member.name) || clean(c.profile_name);
}

function displayName(c) {
  return knownName(c) || formatPhone(c.wa_id);
}

const MEMBER_ROLES = { hr: 'HR', coordinator: 'Coordinator' };

// Everyone in the inbox is a member, so only the other kinds are named.
function memberLabel(m) {
  const role = m.kind === 'member' && !m.active ? 'Former member' : (MEMBER_ROLES[m.kind] || '');
  const company = m.company ? `${m.company}${m.more ? ` +${m.more}` : ''}` : '';
  return [role, company].filter(Boolean).join(', ');
}

function memberTag(m) {
  if (!m || !m.company) return '';
  return m.kind === 'member' ? m.company : memberLabel(m);
}

// Does a conversation match a search query? Text matches the saved, member and
// WhatsApp names and the company. A query that looks like a phone number is
// matched digit-to-digit against the wa_id, typed any way: "+20 120-645 7557",
// "0120 645 7557" and "0020..." all find "201206457557".
const PHONE_QUERY = /^[\d\s+().\-\u0660-\u0669\u06f0-\u06f9\u200e\u200f\u202a-\u202e]+$/;
function matchesQuery(c, rawQuery) {
  const q = (rawQuery || '').trim();
  if (!q) return true;
  const ql = q.toLowerCase();
  const m = c.member || {};
  if ([displayName(c), c.profile_name, m.name, m.company].some((t) => t && String(t).toLowerCase().includes(ql))) return true;
  if (!PHONE_QUERY.test(q)) return false;
  const id = String(c.wa_id || '');
  return searchKeys(q).some((k) => id.includes(k));
}

function formatPhone(waId) {
  if (!waId) return 'Unknown';
  return formatWaId(waId);
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtListTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  const within7 = (now - d) < 7 * 864e5;
  if (within7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function dayLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function tickGlyph(status) {
  switch (status) {
    case 'played':
    case 'read':      return '<span class="tick read">✓✓</span>';
    case 'delivered': return '<span class="tick">✓✓</span>';
    case 'sent':      return '<span class="tick">✓</span>';
    case 'failed':    return '<span class="tick">⚠</span>';
    default:          return '<span class="tick">🕓</span>'; // pending/queued
  }
}

let toastTimer = null;
function toast(msg, danger = false, ms = 3200) {
  els.toast.textContent = msg;
  els.toast.classList.toggle('danger', danger);
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
    setTimeout(() => { els.toast.hidden = true; }, 220);
  }, ms);
}

/* ----------------------------- auth flow ----------------------------- */

async function boot() {
  const { data } = await api('/api/session');
  if (data.authed) {
    setAgent(data.agent);
    showApp();
  } else {
    showLogin(data.ended);
  }
  // reveal (drop the no-transition preload class)
  requestAnimationFrame(() => els.body.classList.remove('preload'));
}

function showLogin(note) {
  stopLive();
  alerts.seen = null;
  updateTabBadge();
  setAgent(null);
  els.app.hidden = true;
  els.login.hidden = false;
  els.loginPassword.value = '';
  els.loginError.textContent = note || '';
  els.loginError.hidden = !note;
  (els.loginEmail.value ? els.loginPassword : els.loginEmail).focus();
}

function showApp() {
  els.login.hidden = true;
  els.app.hidden = false;
  startLive();
  startListPolling();
  refreshConversations(true).then(openChatFromLink);
  loadSavedReplies();
  loadTemplates();
  initPush();
}

async function loadTemplates() {
  const { ok, data } = await api('/api/templates');
  if (!ok || !Array.isArray(data.templates) || !data.templates.length) return;
  state.templates = data.templates;
  renderConversations(true);
  if (state.activeWaId) renderMessages(true);
}

els.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.loginError.hidden = true;
  els.loginBtn.disabled = true;
  els.loginBtn.textContent = 'Signing in…';
  const { ok, data } = await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ email: els.loginEmail.value.trim(), password: els.loginPassword.value }),
  });
  els.loginBtn.disabled = false;
  els.loginBtn.textContent = 'Sign in';
  if (ok) {
    els.loginPassword.value = '';
    setAgent(data.agent);
    showApp();
  } else {
    els.loginError.textContent = data.error || 'Could not sign you in. Try again.';
    els.loginError.hidden = false;
    els.loginPassword.select();
  }
});

els.logoutBtn.addEventListener('click', async () => {
  await pushOff(); // a logged-out device must not keep showing member messages
  await api('/api/logout', { method: 'POST' });
  stopListPolling();
  stopThreadPolling();
  state.activeWaId = null;
  applyListPane();
  showLogin();
});

/* ----------------------- conversation list ----------------------- */

const LIST_PAGE = 60;
const LIST_MAX = 300;
let listSeq = 0;

// Any chat the inbox has been told about, whether or not the list shows it
// right now (a search or another view can leave the open chat out).
function convOf(waId) {
  return (state.known && state.known.get(waId)) || state.conversations.find((c) => c.wa_id === waId) || null;
}
function remember(rows) {
  for (const c of rows || []) state.known.set(c.wa_id, c);
}

function listUrl(offset, limit) {
  const params = new URLSearchParams({ view: state.view, offset: String(offset), limit: String(limit) });
  const q = state.filter.trim();
  if (q) params.set('q', q);
  return `/api/conversations?${params}`;
}

async function refreshConversations(initial = false) {
  const seq = ++listSeq;
  const want = Math.min(LIST_MAX, Math.max(LIST_PAGE, state.conversations.length));
  const { ok, status, data } = await api(listUrl(0, want));
  if (seq !== listSeq) return; // a newer search or view is already on its way
  if (!ok) {
    if (status === 401) return handleAuthLost();
    if (status === 503) {
      els.convLoading.hidden = true;
      els.convEmpty.hidden = false;
      els.convEmpty.querySelector('p').textContent = 'Database not connected';
      els.convEmpty.querySelector('span').textContent =
        'Check DATABASE_URL to start receiving messages.';
      return;
    }
    if (initial) { els.convLoading.hidden = true; }
    return;
  }
  const rows = data.conversations || [];
  // Rows the agent scrolled to beyond what one refresh carries stay as they are.
  const have = new Set(rows.map((c) => c.wa_id));
  const tail = state.conversations.slice(want).filter((c) => !have.has(c.wa_id));
  state.conversations = rows.concat(data.next == null ? [] : tail);
  state.list = {
    total: data.total ?? rows.length,
    next: data.next == null ? null : state.conversations.length,
    counts: data.counts || {},
    hits: data.message_hits || [],
    more: false,
  };
  state.recent = data.recent || [];
  remember(state.recent);
  remember(state.list.hits);
  remember(state.conversations);
  state.teamwork = Boolean(data.teamwork);
  state.agentNames = Boolean(data.agent_names);
  state.savedRepliesOn = Boolean(data.saved_replies);
  renderAgent();
  noteIncoming(data.recent || rows);
  state.membersAvailable = Boolean(data.members_available);
  els.convLoading.hidden = true;
  renderViews();
  renderConversations();
  renderThreadHeader();
}

async function loadMoreConversations() {
  if (state.list.next == null || state.list.more) return;
  state.list.more = true;
  const seq = listSeq;
  const { ok, data } = await api(listUrl(state.conversations.length, LIST_PAGE));
  state.list.more = false;
  if (!ok || seq !== listSeq) return;
  const have = new Set(state.conversations.map((c) => c.wa_id));
  const fresh = (data.conversations || []).filter((c) => !have.has(c.wa_id));
  state.conversations = state.conversations.concat(fresh);
  remember(fresh);
  state.list.next = data.next == null || !fresh.length ? null : state.conversations.length;
  renderConversations(true);
}

// What this device has already opened: a chat the agent has read here shows
// calmer than one with something new, while it still waits for a reply.
const SEEN_KEY = 'wa_seen';
const seenHere = (() => { try { return JSON.parse(localStorage.getItem(SEEN_KEY)) || {}; } catch (_) { return {}; } })();
function markSeenHere(c) {
  if (!c || !c.last_message_at || seenHere[c.wa_id] === c.last_message_at) return;
  seenHere[c.wa_id] = c.last_message_at;
  const ids = Object.keys(seenHere);
  if (ids.length > 800) for (const id of ids.slice(0, 200)) delete seenHere[id];
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seenHere)); } catch (_) {}
}
const waiting = (c) => (c.needs_reply != null ? Boolean(c.needs_reply) : c.unread_count > 0);
const newHere = (c) => c.unread_count > 0 && (!state.teamwork || seenHere[c.wa_id] !== c.last_message_at);

function renderViews() {
  const counts = state.list.counts || {};
  document.querySelectorAll('.list-filters .filter-chip').forEach((chip) => {
    const view = chip.dataset.view;
    const on = view === state.view;
    chip.classList.toggle('active', on);
    chip.setAttribute('aria-selected', on ? 'true' : 'false');
    const n = view === 'needs_reply' ? counts.needs_reply : 0;
    const count = chip.querySelector('.chip-count');
    count.textContent = n > 99 ? '99+' : n || '';
    count.hidden = !n;
  });
  renderViewPill();
}

function tuckFilters(on) {
  on = Boolean(on) && phoneLayout.matches;
  if (on) els.listFilters.parentElement.style.setProperty('--filters-h', `${els.listFilters.offsetHeight || 48}px`);
  filtersBar.tucked = on;
  if (!on) filtersBar.shownAt = Date.now();
  els.listFilters.parentElement.classList.toggle('filters-tucked', on);
  renderViewPill();
}
function renderViewPill() {
  const chip = document.querySelector(`.list-filters .filter-chip[data-view="${state.view}"]`);
  const show = filtersBar.tucked && state.view !== 'chats' && Boolean(chip);
  els.viewPill.hidden = !show;
  els.viewPill.parentElement.classList.toggle('has-pill', show);
  if (show) els.viewPill.textContent = chip.textContent.trim().replace(/(\D)(\d)/, '$1 $2');
}

// The member's picture from the Byte+ app when there is one, over the
// initials, which stay underneath for a picture that fails to load.
function avatarParts(c) {
  const m = c.member || {};
  const img = m.image
    ? `<img src="${escapeHtml(m.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"${m.image_bg ? ` style="background:${escapeHtml(m.image_bg)}"` : ''} />`
    : '';
  return { inner: `${escapeHtml(initials(knownName(c), c.wa_id))}${img}`, photo: Boolean(img) };
}
function avatarHtml(c) {
  const a = avatarParts(c);
  return `<span class="avatar${a.photo ? ' has-photo' : ''}" aria-hidden="true">${a.inner}</span>`;
}
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img && img.tagName === 'IMG' && img.parentElement && img.parentElement.classList.contains('has-photo')) {
    img.parentElement.classList.remove('has-photo');
    img.remove();
  }
}, true);

const ICO_DONE = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const ICO_FLAG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V4h13l-2 4 2 4H4"/></svg>';

function rowHtml(c, hit) {
  const name = escapeHtml(displayName(c));
  const tag = memberTag(c.member);
  const active = c.wa_id === state.activeWaId && !hit ? ' active' : '';
  const isWaiting = waiting(c);
  const isNew = newHere(c);
  const cls = `${active}${isNew ? ' has-unread' : ''}${isWaiting && !isNew ? ' is-waiting' : ''}`;
  const badge = c.unread_count > 99 ? '99+' : c.unread_count || '';
  const reacted = /Reacted to your message$/.test(c.last_message_text || '');
  const outTick = !hit && !reacted && c.last_message_direction === 'out' ? '<span class="tick">✓</span> ' : '';
  const preview = hit ? hit.text : String(WaTpl.previewText(c.last_message_text, state.templates) || '').replace(/^(\S+ [^·]+?) · /, '$1  ');
  const when = hit ? hit.at : c.last_message_at;
  const toggleTitle = isWaiting ? 'Mark as done' : 'Mark as needing a reply';
  const toggle = hit ? '' : `<span class="row-readtoggle" role="button" tabindex="0" data-read="${isWaiting ? 'read' : 'unread'}" title="${toggleTitle}" aria-label="${toggleTitle}">${isWaiting ? ICO_DONE : ICO_FLAG}</span>`;
  return `
    <button class="conv-row${cls}" role="listitem" data-wa="${escapeHtml(c.wa_id)}"${hit ? ` data-hit="${hit.message_id}"` : ''}>
      ${avatarHtml(c)}
      <span class="row-main">
        <span class="row-top"><span class="row-name-text" title="${name}"><bdi>${name}</bdi></span><span class="row-time">${escapeHtml(fmtListTime(when))}</span></span>
        <span class="row-bottom"><span class="row-preview">${outTick}<bdi>${escapeHtml(preview)}</bdi></span>${tag ? `<span class="row-co" title="${escapeHtml(memberLabel(c.member))}"><bdi>${escapeHtml(tag)}</bdi></span>` : ''}<span class="row-badge">${badge}</span></span>
      </span>
      ${toggle}
      <span class="row-swipe" aria-hidden="true">${isWaiting ? ICO_DONE : ICO_FLAG}<span>${isWaiting ? 'Done' : 'Needs reply'}</span></span>
    </button>`;
}

let _lastConvSig = '';
function renderConversations(forceRender = false) {
  const q = state.filter.trim();
  const list = state.conversations;
  const hits = q ? state.list.hits || [] : [];
  updateTabBadge();

  // Skip the DOM rebuild if nothing the list shows has changed: no flicker,
  // no lost hover, no wasted work on every poll.
  const sig = [state.activeWaId, state.view, q, state.list.next, state.teamwork].join('|') + '|' + list.map((c) =>
    `${c.wa_id}:${c.last_message_at}:${c.unread_count}:${c.last_message_text}:${displayName(c)}:${memberTag(c.member)}:${c.last_message_direction || ''}:${waiting(c) ? 1 : 0}:${newHere(c) ? 1 : 0}:${(c.member || {}).image || ''}`
  ).join(';') + '|' + hits.map((h) => `${h.wa_id}:${h.hit.message_id}`).join(';');
  if (!forceRender && sig === _lastConvSig) return;
  _lastConvSig = sig;

  if (!list.length && !hits.length) {
    els.convList.innerHTML = '';
    els.convEmpty.hidden = false;
    const [title, sub] = q ? ['No matches', 'Try another name, number or word.']
      : state.view === 'needs_reply' ? ['Nobody is waiting', 'Every chat has been answered or marked done.']
      : ['No conversations yet.', 'Incoming WhatsApp messages will appear here.'];
    els.convEmpty.querySelector('p').textContent = title;
    els.convEmpty.querySelector('span').textContent = sub;
    return;
  }
  els.convEmpty.hidden = true;

  const keepScroll = els.convList.scrollTop;
  const items = list.map((c) => ({ key: `c:${c.wa_id}`, html: rowHtml(c) }));
  if (hits.length) {
    items.push({ key: 'section', html: '<div class="list-section">In messages</div>' });
    for (const h of hits) items.push({ key: `h:${h.wa_id}:${h.hit.message_id}`, html: rowHtml(h, h.hit) });
  }
  if (state.list.next != null) items.push({ key: 'more', html: '<div class="list-more" id="list-more">Loading more…</div>' });
  patchList(els.convList, items);
  if (els.convList.scrollTop !== keepScroll) els.convList.scrollTop = keepScroll;
}

// Keeps every chat row whose content is unchanged (its photo is not loaded
// again), redraws only rows that changed, and moves rows into the new order.
function patchList(container, items) {
  const old = new Map();
  for (const n of [...container.children]) {
    if (n._key && !old.has(n._key)) old.set(n._key, n);
    else n.remove();
  }
  let anchor = null;
  for (const it of items) {
    let node = old.get(it.key);
    if (node && node._html !== it.html) {
      const fresh = htmlNode(it.html);
      node.replaceWith(fresh);
      node = fresh;
    } else if (!node) {
      node = htmlNode(it.html);
    }
    old.delete(it.key);
    node._key = it.key;
    node._html = it.html;
    const want = anchor ? anchor.nextSibling : container.firstChild;
    if (node !== want) container.insertBefore(node, want);
    anchor = node;
  }
  for (const [, n] of old) n.remove();
}

function htmlNode(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

els.convList.addEventListener('scroll', () => {
  const el = els.convList;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 600) loadMoreConversations();
}, { passive: true });

// On a phone the filters stay tucked away. A pull down while the list is at the
// very top brings them out, and scrolling down tucks them away again. Nothing
// here moves the list while a finger is on it.
els.convList.addEventListener('scroll', () => {
  if (filtersBar.tucked || filtersBar.frame) return;
  filtersBar.frame = requestAnimationFrame(() => {
    filtersBar.frame = 0;
    if (Date.now() - filtersBar.shownAt > 400 && els.convList.scrollTop > 24) tuckFilters(true);
  });
}, { passive: true });
els.convList.addEventListener('touchstart', (e) => {
  filtersBar.pullFrom = filtersBar.tucked && els.convList.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null;
}, { passive: true });
els.convList.addEventListener('touchmove', (e) => {
  if (filtersBar.pullFrom === null || filtersBar.pullFrom === undefined) return;
  const dy = e.touches[0].clientY - filtersBar.pullFrom;
  if (dy < -6) filtersBar.pullFrom = null;
  else if (dy > 36) { filtersBar.pullFrom = null; tuckFilters(false); }
}, { passive: true });
els.convList.addEventListener('wheel', (e) => {
  if (filtersBar.tucked && els.convList.scrollTop <= 0 && e.deltaY < -20) tuckFilters(false);
}, { passive: true });
els.viewPill.addEventListener('click', () => tuckFilters(false));

els.convList.addEventListener('click', (e) => {
  if (rowSwipe.justSwiped) { e.preventDefault(); return; }
  const toggle = e.target.closest('.row-readtoggle');
  if (toggle) {
    e.stopPropagation();
    const row = toggle.closest('.conv-row');
    if (row) setConversationRead(row.dataset.wa, toggle.dataset.read === 'read');
    return;
  }
  const row = e.target.closest('.conv-row');
  if (!row) return;
  openConversation(row.dataset.wa, row.dataset.hit ? Number(row.dataset.hit) : null);
});

// Keyboard activation for the read/unread toggle (it's a role="button" span so
// it can live inside the .conv-row button without invalid nested buttons).
els.convList.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const toggle = e.target.closest('.row-readtoggle');
  if (!toggle) return;
  e.preventDefault();
  e.stopPropagation();
  const row = toggle.closest('.conv-row');
  if (row) setConversationRead(row.dataset.wa, toggle.dataset.read === 'read');
});

// The search runs on the server, over every chat and the text of messages,
// a moment after the typing stops.
let searchTimer = null;
els.search.addEventListener('input', () => {
  state.filter = els.search.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.conversations = state.conversations.slice(0, LIST_PAGE);
    els.convList.scrollTop = 0;
    refreshConversations();
  }, 250);
});

// Views: Chats / Needs reply. A search looks through every chat.
document.querySelectorAll('.list-filters .filter-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    if (state.view === chip.dataset.view) return;
    state.view = chip.dataset.view;
    state.conversations = [];
    els.convList.innerHTML = '';
    els.convList.scrollTop = 0;
    els.convLoading.hidden = false;
    els.convEmpty.hidden = true;
    renderViews();
    tuckFilters(false);
    refreshConversations();
  });
});

// The inbox's own flag, shared by every agent. Done: the count clears and the
// chat leaves "Needs reply" until the member writes again. It never touches
// WhatsApp's blue ticks. Optimistic, then the list poll keeps it in step.
async function setConversationRead(waId, read) {
  const conv = convOf(waId);
  if (conv) {
    conv.unread_count = read ? 0 : 1;
    conv.needs_reply = !read;
    if (read) markSeenHere(conv);
    else delete seenHere[waId];
    renderConversations();
  }
  const { ok, status, data } = await api(`/api/conversations/${encodeURIComponent(waId)}/read`, {
    method: 'POST', body: JSON.stringify({ read }),
  });
  if (status === 401) return handleAuthLost();
  if (!ok) toast((data && data.error) || 'Could not update the chat.', true);
  refreshConversations(); // the counts on the views, and the view itself
}

// Swipe a chat to the left to mark it done, or to flag it as needing a reply.
// A short tap of the phone's motor, once per gesture. Android Chrome has it;
// Safari on iPhone has no vibration a page can use.
// On an iPhone, where there is no vibration a page can use, toggling a hidden
// switch inside the gesture plays the system tap (Safari 17.4 and later).
let hapticLabel = null;
function hapticSwitch() {
  if (hapticLabel) return hapticLabel;
  hapticLabel = document.createElement('label');
  hapticLabel.className = 'haptic-switch';
  hapticLabel.setAttribute('aria-hidden', 'true');
  hapticLabel.innerHTML = '<input type="checkbox" switch tabindex="-1">';
  hapticLabel.addEventListener('click', (e) => e.stopPropagation());
  document.body.appendChild(hapticLabel);
  return hapticLabel;
}
// From iOS 26.5 only a real finger landing on a switch ticks, so the buttons
// where a tick helps carry a see-through switch over them on an iPhone.
const tapTicks = !navigator.vibrate && /iP(hone|ad|od)/.test(navigator.userAgent);
function addTapTick(btn) {
  if (!tapTicks || !btn || (btn.parentElement && btn.parentElement.classList.contains('tick-wrap'))) return;
  const wrap = document.createElement('span');
  wrap.className = `tick-wrap ${btn.className.split(' ')[0]}-tick`;
  btn.replaceWith(wrap);
  wrap.appendChild(btn);
  const label = document.createElement('label');
  label.className = 'tick-switch';
  label.setAttribute('aria-hidden', 'true');
  label.innerHTML = '<input type="checkbox" switch tabindex="-1">';
  let keep = null;
  label.addEventListener('pointerdown', () => { keep = document.activeElement; });
  label.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.tagName !== 'INPUT') return;
    if (keep && keep !== document.activeElement && keep.focus && keep !== document.body) keep.focus({ preventScroll: true });
    keep = null;
    btn.click();
  });
  wrap.appendChild(label);
}
// Samsung phones hardly move for less than about 20ms. Chrome refuses to buzz
// until the page has had a tap, and a held finger is not one yet, so the
// first press after the app opens buzzes as the finger lifts.
const BUZZ_MS = 25;
let buzzOnLift = false;
document.addEventListener('touchend', () => {
  if (!buzzOnLift) return;
  buzzOnLift = false;
  try { navigator.vibrate(BUZZ_MS); } catch (_) {}
}, true);
function haptic(gesture) {
  if (!byTouch) return;
  if (gesture) { if (gesture.buzzed) return; gesture.buzzed = true; }
  if (navigator.vibrate) {
    let ok = false;
    try { ok = navigator.vibrate(BUZZ_MS); } catch (_) {}
    buzzOnLift = !ok && Boolean(navigator.userActivation) && !navigator.userActivation.hasBeenActive;
    return;
  }
  const active = document.activeElement;
  hapticSwitch().click();
  if (active && active !== document.activeElement && active.focus) active.focus({ preventScroll: true });
}
const rowSwipe = { row: null, x0: 0, y0: 0, dx: 0, on: false, justSwiped: false, buzzed: false };
const SWIPE_ROW_AT = 84;
els.convList.addEventListener('touchstart', (e) => {
  const row = e.target.closest('.conv-row');
  if (!row || e.touches.length !== 1 || row.dataset.hit) return;
  Object.assign(rowSwipe, { row, x0: e.touches[0].clientX, y0: e.touches[0].clientY, dx: 0, on: false, buzzed: false });
}, { passive: true });
els.convList.addEventListener('touchmove', (e) => {
  const s = rowSwipe;
  if (!s.row) return;
  const dx = e.touches[0].clientX - s.x0;
  const dy = e.touches[0].clientY - s.y0;
  if (!s.on) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { s.row = null; return; } // scrolling the list
    if (dx > -12) return;
    s.on = true;
    s.row.classList.add('swiping');
  }
  s.dx = Math.max(-140, Math.min(0, dx));
  s.row.style.setProperty('--swipe', `${s.dx}px`);
  const armed = s.dx <= -SWIPE_ROW_AT;
  if (armed && !s.row.classList.contains('swipe-armed')) haptic(s);
  s.row.classList.toggle('swipe-armed', armed);
}, { passive: true });
for (const type of ['touchend', 'touchcancel']) {
  els.convList.addEventListener(type, () => {
    const s = rowSwipe;
    if (!s.row) return;
    const { row } = s;
    const fire = type === 'touchend' && s.on && s.dx <= -SWIPE_ROW_AT;
    row.classList.remove('swiping', 'swipe-armed');
    row.style.removeProperty('--swipe');
    if (s.on) { s.justSwiped = true; setTimeout(() => { s.justSwiped = false; }, 350); }
    s.row = null;
    if (fire) {
      const toggle = row.querySelector('.row-readtoggle');
      setConversationRead(row.dataset.wa, toggle ? toggle.dataset.read === 'read' : true);
    }
  }, { passive: true });
}

/* --------------------------- open a thread --------------------------- */

// Re-run on every list poll too, so a rename by another agent or a member
// match that arrives later shows without reopening the chat.
function renderThreadHeader() {
  const waId = state.activeWaId;
  if (!waId) return;
  const conv = convOf(waId) || { wa_id: waId };
  const f = peerFacts(conv);
  els.threadName.textContent = f.title;
  const avatar = avatarParts(conv);
  if (els.threadAvatar.dataset.sig !== avatar.inner) {
    els.threadAvatar.dataset.sig = avatar.inner;
    els.threadAvatar.innerHTML = avatar.inner;
    els.threadAvatar.classList.toggle('has-photo', avatar.photo);
  }
  els.threadMember.hidden = !f.label;
  els.threadMember.textContent = f.label;
  // One line in the header; the rest shows on hover and in the sheet a tap opens.
  els.threadPeer.title = f.rows.map((r) => `${r.label}: ${r.value}`).join('\n');
  els.doneBtn.hidden = !(state.teamwork && waiting(conv));
  fitThreadHeader();
  if (!els.peerSheet.hidden) fillPeerSheet(conv);
}

// The name stays on one line where it can: the chip narrows, then goes (its
// text is in the sheet); only then does the name take a second line, and a
// name that still does not fit is set smaller on three lines.
function fitThreadHeader() {
  const sig = `${els.threadName.textContent}|${els.threadMember.textContent}|${els.doneBtn.hidden}|${els.threadPeer.offsetWidth}`;
  if (!els.threadPeer.offsetWidth || els.threadPeer.dataset.fit === sig) return;
  els.threadPeer.dataset.fit = sig;
  const lineHeight = parseFloat(getComputedStyle(els.threadName).lineHeight) || 20;
  const wraps = () => els.threadName.getBoundingClientRect().height > lineHeight * 1.5;
  const cut = () => els.threadName.scrollHeight > els.threadName.clientHeight + 1;
  els.threadPeer.classList.remove('tight', 'tighter', 'small');
  if (wraps()) els.threadPeer.classList.add('tight');
  if (wraps()) els.threadPeer.classList.add('tighter');
  if (cut()) els.threadPeer.classList.add('small');
}
window.addEventListener('resize', () => { if (state.activeWaId) { fitThreadHeader(); autoGrow(); } });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { els.threadPeer.dataset.fit = ''; fitThreadHeader(); });
if (window.ResizeObserver) new ResizeObserver(() => { if (state.activeWaId) { fitThreadHeader(); if (!els.composerInput.style.height) autoGrow(); } }).observe(els.threadPeer);

// What is known about the person in a chat. The header shows the best name
// and the company; the phone, the WhatsApp name and the roster name wait in
// the sheet.
function peerFacts(conv) {
  const name = knownName(conv);
  const phone = formatPhone(conv.wa_id);
  const waName = (conv.profile_name || '').trim();
  const rosterName = ((conv.member && conv.member.name) || '').trim();
  const label = conv.member ? memberLabel(conv.member) : '';
  const rows = [{ key: 'phone', label: 'Phone', value: phone }];
  if (waName && waName !== name) rows.push({ key: 'wa', label: 'On WhatsApp', value: waName });
  if (rosterName && rosterName !== name) rows.push({ key: 'roster', label: 'On the roster', value: rosterName });
  if (label) rows.push({ key: 'company', label: 'Company', value: label });
  else if (state.membersAvailable) rows.push({ key: 'company', label: 'Company', value: 'Not on a roster' });
  return { title: name || phone, label, rows };
}

function fillPeerSheet(conv) {
  const f = peerFacts(conv);
  const avatar = avatarParts(conv);
  els.peerAvatar.innerHTML = avatar.inner;
  els.peerAvatar.classList.toggle('has-photo', avatar.photo);
  els.peerName.textContent = f.title;
  els.peerRows.innerHTML = f.rows.map((r) => r.key === 'phone'
    ? `<button type="button" class="peer-row" data-peer="copy" title="Copy number"><span class="peer-label">${escapeHtml(r.label)}</span><bdi class="peer-value" dir="ltr">${escapeHtml(r.value)}</bdi></button>`
    : `<div class="peer-row"><span class="peer-label">${escapeHtml(r.label)}</span><bdi class="peer-value">${escapeHtml(r.value)}</bdi></div>`).join('');
}

function openPeerSheet() {
  const waId = state.activeWaId;
  if (!waId || !els.peerSheet.hidden) return;
  fillPeerSheet(convOf(waId) || { wa_id: waId });
  // On a computer the card hangs under the name instead of covering the chat.
  const at = els.threadPeer.getBoundingClientRect();
  const bar = els.threadPeer.closest('.thread-header').getBoundingClientRect();
  els.peerSheet.style.setProperty('--peer-x', `${Math.round(at.left)}px`);
  els.peerSheet.style.setProperty('--peer-y', `${Math.round(bar.bottom + 4)}px`);
  els.peerSheet.hidden = false;
}
function closePeerSheet() {
  els.peerSheet.hidden = true;
}

async function openConversation(waId, jumpTo = null) {
  if (!waId) return;
  const conv = convOf(waId);

  // Preserve the previous chat's unsent text as a per-chat draft before switching.
  saveDraft();
  if (state.replyTo && state.replyTo.waId !== waId) clearReply();

  state.activeWaId = waId;
  if (typeof applyListPane === 'function') applyListPane();
  const t = thread(waId);

  renderThreadHeader();

  // view swap
  els.placeholder.hidden = true;
  els.thread.hidden = false;
  els.app.dataset.view = 'thread';
  fitThreadHeader();
  // On a phone the chat is its own screen, so the back gesture returns to the list.
  if (phoneLayout.matches && !(history.state && history.state.chat)) history.pushState({ chat: true }, '');
  els.messagesEmpty.hidden = true;
  clearBanner();
  // Restore this chat's draft (don't blow away unsent text). Clears any staged
  // file from the prior chat but keeps the typed draft.
  clearPendingFile();
  els.composerInput.value = state.drafts[waId] || '';
  autoGrow();
  closeReplyPicker();
  renderWindow();
  refreshSendEnabled();

  // Render whatever we already have cached (instant — no flash, no reload),
  // then only show the spinner if we have nothing yet.
  els.messages.querySelectorAll('.bubble, .day-sep').forEach((n) => n.remove());
  renderMessages(true);
  scrollMessagesToBottom(true);
  els.threadLoading.hidden = t.loaded || t.order.length > 0;

  renderConversations(); // reflect active highlight
  if (state.rec) setRecPausedUI(state.rec.paused);

  await loadThread(true);
  if (state.activeWaId !== waId) return;
  els.threadLoading.hidden = true;
  startThreadPolling();
  // On a phone the keyboard would cover half the chat the agent came to read.
  if (!phoneLayout.matches) {
    els.composerInput.focus();
    // Place the caret at the END of a restored draft (focus alone leaves it at 0).
    const end = els.composerInput.value.length;
    els.composerInput.setSelectionRange(end, end);
  }
  if (jumpTo != null) {
    if (thread(waId).byId.has(jumpTo)) jumpToMessage(jumpTo);
    else toast('That message is older than what this chat shows.');
  }

  // Opening sends the blue ticks. With teamwork on, the chat keeps its count
  // for the other agents until someone replies or marks it done; this device
  // just remembers it has been seen here.
  if (conv) {
    if (state.teamwork) markSeenHere(conv);
    else conv.unread_count = 0;
    renderConversations();
  }
  api('/api/mark-read', { method: 'POST', body: JSON.stringify({ wa_id: waId }) }).catch(() => {});
}

async function loadThread(initial = false) {
  const waId = state.activeWaId;
  if (!waId) return;
  const t = thread(waId);
  // Poll by updated_at high-water mark so we catch edits to existing rows
  // (reactions, status ticks, deletes) — not just brand-new messages.
  const since = (!initial && t.maxUpdatedAt) ? `&since=${encodeURIComponent(t.maxUpdatedAt)}` : '';
  const { ok, status, data } = await api(
    `/api/messages?wa_id=${encodeURIComponent(waId)}${since}`
  );
  if (waId !== state.activeWaId) return; // user switched chats mid-request
  if (!ok) {
    if (status === 401) return handleAuthLost();
    if (initial && !t.order.length) toast(data.error || 'Could not load messages.', true);
    return;
  }
  t.loaded = true;
  if (data.last_inbound_at !== undefined) t.lastInboundAt = data.last_inbound_at;
  if (data.server_now) {
    const skew = Date.parse(data.server_now) - Date.now();
    if (Number.isFinite(skew)) state.clockSkew = skew;
  }
  const changed = mergeMessages(t, data.messages || []);
  renderWindow();
  if (changed || initial) {
    const atBottom = pin.stick || isNearBottom();
    renderMessages();
    if (initial) scrollMessagesToBottom(true);
    else if (atBottom) scrollMessagesToBottom();
  }
}

// Incremental render: reconcile DOM bubbles against the cached thread by id.
// Existing bubbles (and their <img>/<video>) are reused, so media never
// re-fetches and there's no flicker; only new/changed bubbles touch the DOM.
function renderMessages(force = false) {
  const t = thread(state.activeWaId);
  const msgs = threadMessages(t);
  els.messagesEmpty.hidden = msgs.length > 0;

  const container = els.messages;
  const keyOf = (m) => m._key || String(m.id);
  const existingNodes = new Map(
    [...container.querySelectorAll('.bubble')].map((n) => [n.dataset.key, n])
  );
  const existingSeps = new Map(
    [...container.querySelectorAll('.day-sep')].map((n) => [n.dataset.day, n])
  );

  let lastDay = '';
  let lastDir = '';
  let anchor = els.threadLoading;
  const place = (node) => {
    if (node.previousSibling !== anchor) container.insertBefore(node, anchor.nextSibling);
    anchor = node;
  };
  for (const m of msgs) {
    const iso = m.wa_timestamp || m.created_at;
    const day = iso ? new Date(iso).toDateString() : '';
    if (day && day !== lastDay) {
      let sep = existingSeps.get(day);
      const label = dayLabel(iso);
      if (sep) {
        existingSeps.delete(day);
        if (sep.textContent !== label) sep.textContent = label;
      } else {
        sep = document.createElement('div');
        sep.className = 'day-sep';
        sep.dataset.day = day;
        sep.textContent = label;
      }
      place(sep);
      lastDay = day;
      lastDir = '';
    }
    const continued = m.direction === lastDir;
    const key = keyOf(m);
    let node = existingNodes.get(key);
    if (node) {
      const sig = bubbleSig(m, continued);
      if (node.dataset.sig !== sig) {
        const fresh = renderBubble(m, continued);
        if (node.dataset.body === fresh.dataset.body
          && node.classList.contains('meta-side') === fresh.classList.contains('meta-side')) patchBubble(node, fresh);
        else { node.replaceWith(fresh); node = fresh; }
      }
      existingNodes.delete(key);
    } else {
      node = renderBubble(m, continued);
    }
    place(node);
    lastDir = m.direction;
  }
  for (const [, node] of existingNodes) node.remove();
  for (const [, sep] of existingSeps) sep.remove();
}

// Only the ticks, the time line and the buttons beside a bubble change while a
// message goes out; its text, photo or player stay the same elements.
function patchBubble(node, fresh) {
  node.className = fresh.className;
  node.dataset.mid = fresh.dataset.mid;
  node.dataset.sig = fresh.dataset.sig;
  const swap = (sel) => {
    const at = `:scope > ${sel}, :scope > .bline > ${sel}`;
    const was = node.querySelector(at);
    const now = fresh.querySelector(at);
    if (was && now) { if (was.outerHTML !== now.outerHTML) was.replaceWith(now); }
    else if (was) was.remove();
    else if (now) node.appendChild(now);
  };
  if (fresh.dataset.tail) node.dataset.tail = fresh.dataset.tail;
  else delete node.dataset.tail;
  swap('.meta-pad');
  swap('.meta');
  swap('.bubble-actions');
}

// Everything that changes a bubble's rendering, so it is redrawn only when
// something visible changed.
function bubbleSig(m, continued) {
  const quoted = quotedMessage(m);
  const meta = m.media_meta || {};
  return [m.id, m.status, m.error || '', m.reaction, ourReaction(m) || '', m.media_status, m.forwarded ? 1 : 0, m._optimistic ? 1 : 0, continued ? 1 : 0, m.body, replyToOf(m) || '', quoted ? quoted.id : '', state.templates.length, meta.sent_as_audio ? 1 : 0, meta.voice ? 1 : 0, m.agent || '', m.wa_message_id ? 1 : 0].join('|');
}

// The part of a bubble that is more than its ticks: when this is the same, the
// bubble is patched in place instead of drawn again.
function bodySig(m, continued) {
  const quoted = quotedMessage(m);
  const meta = m.media_meta || {};
  const failed = m.status === 'failed' ? `failed:${m.error || ''}` : '';
  const media = m._localUrl ? 'local' : m.media_status;
  return [failed, m.reaction, ourReaction(m) || '', media, m.forwarded ? 1 : 0, continued ? 1 : 0, m.body, replyToOf(m) || '', quoted ? quoted.id : '', state.templates.length, meta.sent_as_audio ? 1 : 0, meta.voice ? 1 : 0].join('|');
}

function replyToOf(m) {
  return (m.media_meta && m.media_meta.reply_to) || null;
}

// The message a reply quotes, when it is in the loaded thread.
function quotedMessage(m) {
  const wamid = replyToOf(m);
  if (!wamid) return null;
  for (const row of thread(m.wa_id || state.activeWaId).byId.values()) {
    if (row.wa_message_id === wamid) return row;
  }
  return null;
}

function senderName(m) {
  if (m.direction === 'out') return 'You';
  const waId = m.wa_id || state.activeWaId;
  const conv = convOf(waId);
  return conv ? displayName(conv) : formatPhone(waId);
}

// A tapped template button or list choice arrives as its own type, and reads
// as the text the person chose.
const TEXT_TYPES = new Set(['text', 'button', 'interactive']);
const isTextLike = (m) => !m.type || TEXT_TYPES.has(m.type);

// One line of text standing for a message, for quotes and the reply bar.
function snippetOf(m) {
  if (isTextLike(m)) return WaTpl.messageText(m, state.templates);
  const meta = m.media_meta || {};
  const label = m.type === 'unsupported' ? UNSUPPORTED_LABEL : stripCaption(m.body) || labelForType(m.type);
  return meta.caption ? `${label} ${meta.caption}` : label;
}

function quoteHtml(m) {
  if (!replyToOf(m)) return '';
  const q = quotedMessage(m);
  if (!q) return '<span class="bubble-quote is-missing"><span class="quote-text">Replying to an earlier message</span></span>';
  const who = q.direction === 'out' ? 'is-out' : 'is-in';
  return `<button type="button" class="bubble-quote ${who}" data-quote="${q.id}"><span class="quote-name">${escapeHtml(senderName(q))}</span><span class="quote-text">${escapeHtml(snippetOf(q))}</span></button>`;
}

// iPhone Safari can't play WhatsApp's OGG/Opus voice notes; the server then
// hands back an AAC copy (?compat=1).
const audioProbe = document.createElement('audio');
function canPlayAudio(mime) {
  return Boolean(mime) && audioProbe.canPlayType(mime) !== '';
}

// The space a photo, sticker or video takes in a bubble, known before its
// bytes arrive. Its own shape is kept; only something taller than a phone
// screenshot or wider than a panorama is cropped, and opens whole in the viewer.
const MEDIA_MAX_W = 340;
const MEDIA_MAX_H = 420;
const STICKER_MAX = 150;
function frameBox(w, h, sticker = false) {
  if (!(w > 0 && h > 0)) return null;
  const ratio = Math.min(3, Math.max(0.45, w / h));
  const widest = sticker ? STICKER_MAX : MEDIA_MAX_W;
  const tallest = sticker ? STICKER_MAX : MEDIA_MAX_H;
  return { width: Math.max(64, Math.round(Math.min(widest, tallest * ratio, w))), ratio };
}
function frameAttrs(m) {
  const meta = m.media_meta || {};
  const sticker = m.type === 'sticker';
  const box = frameBox(Number(meta.w), Number(meta.h), sticker);
  const cls = `media-frame${m.type === 'video' ? ' media-video' : ''}${sticker ? ' is-sticker' : ''}`;
  return box ? `class="${cls}" style="--w:${box.width}px;--ar:${box.ratio.toFixed(4)}"` : `class="${cls}"`;
}

function renderBubble(m, continued) {
  const div = document.createElement('div');
  const dir = m.direction === 'out' ? 'out' : 'in';
  div.className = `bubble ${dir}`;
  div.dataset.mid = String(m.id);
  div.dataset.key = m._key || String(m.id);
  div.dataset.sig = bubbleSig(m, continued);
  div.dataset.body = bodySig(m, continued);
  if (continued) div.classList.add(dir === 'out' ? 'cont-out' : 'cont-in');
  if (m.status === 'failed') div.classList.add('failed');
  if (m._optimistic) div.classList.add('pending');
  if (m.reaction || ourReaction(m)) div.classList.add('has-reaction');

  const iso = m.wa_timestamp || m.created_at;

  let inner = quoteHtml(m);

  // Dashboard-only "Forwarded" tag (the Cloud API can't set WhatsApp's native
  // forwarded label, so this shows only here).
  if (m.forwarded) {
    inner += `<span class="forwarded-tag"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>Forwarded</span>`;
  }

  if (m.type === 'contacts' && m.media_meta && Array.isArray(m.media_meta.contacts) && m.media_meta.contacts.length) {
    inner += m.media_meta.contacts.map(contactCardHtml).join('');
  } else if (!isTextLike(m)) {
    const meta = m.media_meta || {};
    // Prefer the local data-URL for an optimistic image so it shows instantly.
    const src = m._localUrl || `/api/media/${m.id}`;
    const stored = m.media_status === 'stored' || Boolean(m._localUrl);
    const isDownloadable = ['image', 'video', 'audio', 'voice', 'sticker', 'document'].includes(m.type);

    if (m.type === 'location' && meta.latitude != null) {
      const q = `${meta.latitude},${meta.longitude}`;
      inner += `<span class="media-label">📍 Location</span>`;
      if (meta.name) inner += `<span class="caption">${escapeHtml(meta.name)}</span>`;
      inner += `<a class="media-link" href="https://maps.google.com/?q=${q}" target="_blank" rel="noopener">${q}</a>`;
    } else if (stored && (m.type === 'image' || m.type === 'sticker')) {
      div.classList.add('has-media');
      inner += `<button type="button" ${frameAttrs(m)} data-view title="Open">
        <img src="${src}" alt="${escapeHtml(labelForType(m.type))}" loading="lazy" />
      </button>`;
    } else if (stored && m.type === 'video') {
      div.classList.add('has-media');
      const still = m._localUrl
        ? `<video preload="metadata" muted playsinline src="${src}"></video>`
        : `<img class="video-poster" src="${posterSrc(m)}" alt="Video" loading="lazy" draggable="false" onerror="this.remove()" />`;
      const length = Number(meta.duration) > 0 ? `<span class="video-length">${fmtClock(Number(meta.duration))}</span>` : '';
      inner += `<button type="button" ${frameAttrs(m)} data-view title="Play">
        ${still}
        <span class="play-badge" aria-hidden="true"><svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><polygon points="7 4 20 12 7 20 7 4"/></svg></span>
        ${length}
      </button>`;
    } else if (stored && (m.type === 'audio' || m.type === 'voice')) {
      const isVoice = m.type === 'voice' || meta.voice === true;
      div.classList.add(isVoice ? 'is-voice' : 'is-audio');
      const compat = m._localUrl ? '' : `/api/media/${m.id}?compat=1`;
      const audioSrc = compat && !canPlayAudio(meta.mime_type) ? compat : src;
      div.classList.add('is-player');
      inner += playerHtml(m, audioSrc, compat, isVoice);
      if (meta.sent_as_audio) inner += '<span class="send-note">Sent as an audio file. WhatsApp refused it as a voice note.</span>';
    } else if (stored && m.type === 'document') {
      const fname = escapeHtml(meta.filename || 'Document');
      inner += isPdf(m)
        ? `<div class="media-doc">
            <button type="button" class="doc-open" data-view title="Open">
              <span class="doc-ico">📄</span><span class="doc-name">${fname}</span>
            </button>
            <a class="doc-dl" href="${src}" download>Download</a>
          </div>`
        : `<a class="media-doc" href="${src}" download>
            <span class="doc-ico">📄</span><span class="doc-name">${fname}</span>
            <span class="doc-dl">Download</span>
          </a>`;
    } else {
      // pending / failed / unsupported / non-downloadable → labeled placeholder
      const isVoice = m.type === 'voice' || meta.voice === true;
      const label = escapeHtml(m.type === 'unsupported' ? UNSUPPORTED_LABEL
        : stripCaption(m.body) || (isVoice ? '🎤 Voice message' : labelForType(m.type)));
      const note =
        m.media_status === 'pending' && isDownloadable ? ' <span class="media-pending">loading…</span>'
        : m.media_status === 'failed' ? ' <span class="media-pending">unavailable</span>'
        : m.media_status === 'expired' ? ' <span class="media-pending">file deleted after 90 days</span>'
        : '';
      inner += `<span class="media-label">${label}${note}</span>`;
    }

    if (meta.caption) inner += `<span class="caption">${linkify(escapeHtml(meta.caption))}</span>`;
  } else {
    const sentTpl = WaTpl.render(WaTpl.sentTemplate(m), state.templates);
    if (m.media_meta && m.media_meta.tapped) inner += '<span class="tapped-tag">Tapped a button</span>';
    inner += sentTpl ? templateHtml(sentTpl) : linkify(escapeHtml(m.body || ''));
  }

  const metaClass = div.classList.contains('has-media') ? 'meta meta-block' : 'meta';
  const by = dir === 'out' && m.agent ? `<span class="meta-agent" title="${escapeHtml(m.agent)}"><bdi>${escapeHtml(String(m.agent).trim().split(/\s+/)[0])}</bdi></span>` : '';
  let metaInner = `${by}${escapeHtml(fmtTime(iso))}`;
  if (dir === 'out') metaInner += ' ' + tickGlyph(m._optimistic ? 'pending' : m.status);
  const metaHtml = `<span class="${metaClass}">${metaInner}</span>`;
  // Text bubbles end with an invisible copy of the time line, so the last line
  // always leaves room for it, whichever way that line reads.
  const tail = !div.classList.contains('has-media') && !div.classList.contains('is-player');

  div.innerHTML = inner + (tail ? `<span class="meta-pad" aria-hidden="true">${metaInner}</span>` : '') + metaHtml;
  setupPlayer(div);

  const view = div.querySelector('[data-view]');
  if (view) view.addEventListener('click', (e) => { e.stopPropagation(); openViewer(Number(div.dataset.mid)); });
  const quote = div.querySelector('.bubble-quote[data-quote]');
  if (quote) quote.addEventListener('click', (e) => { e.stopPropagation(); jumpToMessage(Number(quote.dataset.quote)); });

  // A resend that died half way leaves the row pending with nothing to press.
  const stuck = dir === 'out' && m.status === 'pending' && !m._optimistic && !m._retrying && typeof m.id === 'number' && m.id > 0
    && m.updated_at && Date.now() - Date.parse(m.updated_at) > 2 * 60 * 1000;
  if (m.status === 'failed' || stuck) {
    const why = stuck ? { text: 'This did not finish sending.', said: '' } : failureWords(m);
    const reason = document.createElement('span');
    reason.className = 'fail-reason';
    reason.textContent = '⚠ ' + why.text;
    if (why.said) {
      const said = document.createElement('span');
      said.className = 'fail-said';
      said.textContent = `WhatsApp said: ${why.said}`;
      reason.appendChild(said);
    }
    div.appendChild(reason);

    // Retry control — only on genuinely failed outgoing messages.
    if (dir === 'out' && !m._optimistic) {
      const retry = document.createElement('button');
      retry.className = 'bubble-retry';
      retry.title = 'Retry sending';
      retry.setAttribute('aria-label', 'Retry sending');
      const asAudio = (m.media_meta || {}).voice === true && !(m.media_meta || {}).auto_resend && REFUSED_MEDIA.test(m.error || '');
      retry.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg><span>${asAudio ? 'Send as an audio file' : 'Retry'}</span>`;
      retry.addEventListener('click', (e) => { e.stopPropagation(); retrySend(m); });
      div.appendChild(retry);
    }
    const metaEl = div.querySelector(':scope > .meta');
    if (metaEl) {
      const pad = div.querySelector(':scope > .meta-pad');
      if (pad) pad.remove();
      div.appendChild(metaEl);
      div.classList.add('meta-last');
    }
  }

  // Reaction emoji (customer reacted to one of our messages) — a small pill
  // pinned to the bubble's bottom edge, WhatsApp-style.
  const pill = m.direction === 'in' ? m.reaction : [m.reaction, ourReaction(m)].filter(Boolean).join('');
  if (pill) {
    const r = document.createElement('span');
    r.className = 'reaction-pill';
    r.textContent = pill;
    div.appendChild(r);
  }

  // Reply + Forward sit beside every persisted message. Optimistic bubbles
  // have no real id yet; only a message WhatsApp gave an id can be quoted.
  if (!m._optimistic && typeof m.id === 'number') {
    const actions = document.createElement('span');
    actions.className = 'bubble-actions';
    if (m.wa_message_id && m.status !== 'failed') {
      actions.appendChild(actionButton('Reply', '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>', () => startReply(m)));
    }
    actions.appendChild(actionButton('Forward', '<polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>', () => openForwardModal(m)));
    actions.appendChild(actionButton('More for this', '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>', (e) => { const r = e && e.currentTarget && e.currentTarget.getBoundingClientRect ? e.currentTarget.getBoundingClientRect() : null; openSheet(m, r ? { x: r.left, y: r.bottom + 4 } : null); }));
    div.appendChild(actions);
  }
  if (tail && !div.querySelector(':scope > .fail-reason, :scope > .bubble-retry')) {
    const lastDir = lastLineDir([...div.childNodes]
      .filter((n) => !(n.nodeType === 1 && n.matches('.meta, .meta-pad, .bubble-actions, .reaction-pill, .bubble-quote, .forwarded-tag')))
      .map((n) => n.textContent).join(''));
    if (lastDir === 'ltr') div.classList.add('meta-tail');
    else sideBySide(div);
  }
  return div;
}

// A message whose last paragraph reads right to left ends at the left edge, so
// an invisible tail cannot hold the time's place. The text and the time sit in
// one wrapping row instead: one line when they fit side by side, the time on
// its own line at the bottom right when they do not.
const BESIDE_LINE = '.meta, .meta-pad, .bubble-actions, .reaction-pill, .bubble-quote, .forwarded-tag, .tapped-tag';
function sideBySide(div) {
  const meta = div.querySelector(':scope > .meta');
  if (!meta) return;
  const line = document.createElement('div');
  line.className = 'bline';
  const text = document.createElement('span');
  text.className = 'btext';
  for (const n of [...div.childNodes]) {
    if (n.nodeType === 1 && n.matches(BESIDE_LINE)) continue;
    text.appendChild(n);
  }
  const pad = div.querySelector(':scope > .meta-pad');
  if (pad) pad.remove();
  line.append(text, meta);
  div.insertBefore(line, div.querySelector(':scope > .reaction-pill, :scope > .bubble-actions'));
  div.classList.add('meta-side');
}

// The direction of a text's last paragraph, the way the bubble lays it out
// (each paragraph reads in the direction of its first strong letter).
const STRONG_RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const STRONG_LTR = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;
function lastLineDir(text) {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  for (const ch of lines.length ? lines[lines.length - 1] : '') {
    if (STRONG_RTL.test(ch)) return 'rtl';
    if (STRONG_LTR.test(ch)) return 'ltr';
  }
  return 'ltr';
}

/* ----------------------- voice notes and audio files ----------------------- */

const SPEEDS = [0.5, 1, 1.5, 2];
const player = { speed: 1, current: null };
try { const saved = Number(sessionStorage.getItem('wa-speed')); if (SPEEDS.includes(saved)) player.speed = saved; } catch (_) {}
const speedLabel = (v) => `${v}x`;
function setSpeed(v) {
  player.speed = v;
  try { sessionStorage.setItem('wa-speed', String(v)); } catch (_) {}
  for (const b of document.querySelectorAll('.vp-speed')) b.textContent = speedLabel(v);
  for (const el of document.querySelectorAll('.vplayer audio, video.viewer-media')) el.playbackRate = v;
}
const nextSpeed = () => SPEEDS[(SPEEDS.indexOf(player.speed) + 1) % SPEEDS.length];
function fmtClock(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const t = Math.floor(sec);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
const BAR_COUNT = 30;
function waveBars(seed) {
  let x = Math.abs(Number(seed) || 7) % 233280;
  let out = '';
  for (let i = 0; i < BAR_COUNT; i++) {
    x = (x * 9301 + 49297) % 233280;
    out += `<i style="height:${24 + Math.round((x / 233280) * 76)}%"></i>`;
  }
  return out;
}
const ICO_PLAY = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
const ICO_PAUSE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>';
const ICO_AGAIN = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
const ICO_MIC = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12z"/></svg>';
const ICO_NOTE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M9 18V6l11-2v12a3 3 0 1 1-2-2.83V7.4l-7 1.27V18a3 3 0 1 1-2-2.83z"/></svg>';

// Built as one string with no gaps: the bubble keeps white space.
function playerHtml(m, src, compat, isVoice) {
  return `<div class="vplayer${isVoice ? ' is-voice' : ''}" dir="ltr" data-state="idle">`
    + `<button type="button" class="vp-play" aria-label="Play ${isVoice ? 'voice message' : 'audio'}">${ICO_PLAY}</button>`
    + '<div class="vp-body">'
    + `<div class="vp-track" role="slider" tabindex="0" aria-label="Position" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="vp-bars">${waveBars(m.id)}</span></div>`
    + `<div class="vp-row"><span class="vp-time">0:00</span><span class="vp-error" hidden>Could not play it. Tap to try again.</span><button type="button" class="vp-speed" aria-label="Playback speed">${speedLabel(player.speed)}</button></div>`
    + '</div>'
    + `<span class="vp-mark" aria-hidden="true">${isVoice ? ICO_MIC : ICO_NOTE}</span>`
    + `<audio preload="metadata" src="${src}" data-compat="${compat}"></audio>`
    + '</div>';
}

function setupPlayer(div) {
  const root = div.querySelector('.vplayer');
  if (!root) return;
  const audio = root.querySelector('audio');
  const btn = root.querySelector('.vp-play');
  const track = root.querySelector('.vp-track');
  const time = root.querySelector('.vp-time');
  const err = root.querySelector('.vp-error');
  const bars = [...root.querySelectorAll('.vp-bars i')];
  const setState = (st) => {
    root.dataset.state = st;
    btn.innerHTML = st === 'playing' || st === 'loading' ? ICO_PAUSE : st === 'error' ? ICO_AGAIN : ICO_PLAY;
    btn.setAttribute('aria-label', st === 'playing' || st === 'loading' ? 'Pause' : st === 'error' ? 'Try again' : 'Play');
    err.hidden = st !== 'error';
    time.hidden = st === 'error';
  };
  const length = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0);
  const paint = () => {
    const d = length();
    const part = d ? Math.min(1, audio.currentTime / d) : 0;
    const lit = Math.round(part * bars.length);
    bars.forEach((b, i) => b.classList.toggle('on', i < lit));
    track.setAttribute('aria-valuenow', String(Math.round(part * 100)));
    const running = root.dataset.state === 'playing' || root.dataset.state === 'loading' || audio.currentTime > 0;
    time.textContent = fmtClock(running ? audio.currentTime : d);
  };
  const start = () => {
    if (player.current && player.current !== audio) player.current.pause();
    player.current = audio;
    audio.playbackRate = player.speed;
    setState('loading');
    const p = audio.play();
    if (p && p.catch) p.catch((e) => { if (root.dataset.state !== 'error') setState(e && e.name === 'NotAllowedError' ? 'paused' : 'error'); });
  };
  audio.addEventListener('loadedmetadata', paint);
  audio.addEventListener('durationchange', paint);
  audio.addEventListener('timeupdate', () => { if (!audio.isConnected) { audio.pause(); return; } paint(); });
  audio.addEventListener('playing', () => { audio.playbackRate = player.speed; setState('playing'); });
  audio.addEventListener('waiting', () => { if (!audio.paused) setState('loading'); });
  audio.addEventListener('pause', () => { if (root.dataset.state !== 'error') setState('paused'); });
  audio.addEventListener('ended', () => { audio.currentTime = 0; setState('idle'); paint(); });
  audio.addEventListener('error', () => {
    // A browser can claim it plays a format and still fail on it; the AAC copy is the fallback.
    const compat = audio.dataset.compat;
    if (compat && !audio.src.endsWith(compat)) {
      const wanted = root.dataset.state === 'loading' || root.dataset.state === 'playing';
      audio.src = compat;
      audio.load();
      if (wanted) start();
      return;
    }
    setState('error');
  });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (root.dataset.state === 'error') { setState('idle'); audio.load(); start(); return; }
    if (audio.paused) start(); else audio.pause();
  });
  root.querySelector('.vp-speed').addEventListener('click', (e) => { e.stopPropagation(); setSpeed(nextSpeed()); });
  const seekTo = (x) => {
    const d = length();
    if (!d) return;
    const r = track.getBoundingClientRect();
    audio.currentTime = Math.max(0, Math.min(1, (x - r.left) / r.width)) * d;
    paint();
  };
  track.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    try { track.setPointerCapture(e.pointerId); } catch (_) {}
    root.classList.add('seeking');
    seekTo(e.clientX);
  });
  track.addEventListener('pointermove', (e) => { if (root.classList.contains('seeking')) seekTo(e.clientX); });
  for (const type of ['pointerup', 'pointercancel']) track.addEventListener(type, () => root.classList.remove('seeking'));
  track.addEventListener('keydown', (e) => {
    const d = length();
    if (!d || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
    e.preventDefault();
    audio.currentTime = Math.max(0, Math.min(d, audio.currentTime + (e.key === 'ArrowRight' ? 5 : -5)));
    paint();
  });
  root.addEventListener('click', (e) => e.stopPropagation());
  root.addEventListener('dblclick', (e) => e.stopPropagation());
}

function contactCardHtml(c) {
  const phones = (c.phones || []).map((ph) => {
    const shown = ph.phone || (ph.wa_id ? `+${ph.wa_id}` : '');
    return `<a class="contact-phone" href="tel:${escapeHtml(shown.replace(/[^\d+]/g, ''))}">${escapeHtml(shown)}</a>`;
  }).join('');
  return `<span class="contact-card"><span class="contact-name"><span aria-hidden="true">👤</span> <bdi>${escapeHtml(c.name || 'Contact')}</bdi></span>${phones}</span>`;
}

// What WhatsApp answers when it refuses a message, in words an agent can act
// on. The code sits in brackets in the stored reason (lib/ingest.js); older
// rows carry the title only.
const REFUSED_MEDIA = /media upload error|\b131053\b/i;
const FAILURE_WORDS = [
  [/\b131047\b|re-engagement|24-hour reply window/i, 'More than 24 hours since their last message. Only a follow-up template can be sent now.'],
  [/\b131053\b|media upload error/i, 'WhatsApp could not process this file.'],
  [/\b131052\b|media download error/i, 'WhatsApp could not fetch this file. Send it again.'],
  [/\b131026\b|undeliverable/i, 'WhatsApp could not deliver this. The number may not be on WhatsApp, may have blocked this number, or runs a very old WhatsApp.'],
  [/\b131049\b|healthy ecosystem/i, 'WhatsApp chose not to deliver this template to this person right now. Try again tomorrow.'],
  [/\b130472\b|part of an experiment/i, 'WhatsApp held this template back for this person. A normal message works once they write in.'],
  [/\b131048\b|\b131056\b|\b130429\b|rate limit/i, 'Too many messages in a short time. Wait a minute and send again.'],
  [/\b131031\b|account has been locked/i, 'The business WhatsApp account is locked. Report it to the tech team.'],
  [/\b131042\b|payment/i, 'WhatsApp refused this over the payment method on the business account. Report it to the tech team.'],
  [/\b132\d{3}\b|template/i, 'WhatsApp refused this template. Report it to the tech team.'],
  [/\b133010\b|not registered/i, 'The business number is not registered with WhatsApp right now. Report it to the tech team.'],
  [/No connection/i, 'No connection. Check the internet and try again.'],
];
function failureWords(m) {
  const raw = String(m.error || '').trim();
  if (!raw) return { text: 'Failed to send.', said: '' };
  const hit = FAILURE_WORDS.find(([re]) => re.test(raw));
  if (!hit) return { text: raw, said: '' };
  const meta = m.media_meta || {};
  const text = !REFUSED_MEDIA.test(raw) || meta.voice !== true ? hit[1]
    : meta.auto_resend ? 'WhatsApp refused this voice note, and the audio file sent in its place did not go out either. Try again, or type the message.'
    : `${hit[1]} Send it as an audio file instead, or type the message.`;
  return { text, said: raw === text ? '' : raw };
}

// Web addresses in a message open in a new tab. Works on text that is
// already escaped, so nothing a member types can become markup.
function linkify(escaped) {
  return escaped.replace(/\bhttps?:\/\/[^\s<]+/g, (url) => {
    const m = /(?:&quot;|&#39;|&gt;|[.,;:!?)\]])+$/.exec(url);
    const tail = m ? m[0] : '';
    const href = tail ? url.slice(0, -tail.length) : url;
    return `<a class="msg-link" href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>${tail}`;
  });
}

function actionButton(label, paths, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'bubble-action';
  b.title = label;
  b.setAttribute('aria-label', `${label} message`);
  b.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function jumpToMessage(id) {
  const node = els.messages.querySelector(`.bubble[data-mid="${id}"]`);
  if (!node) return;
  pin.stick = false;
  notePerson(1500);
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  node.classList.remove('flash');
  void node.offsetWidth;
  node.classList.add('flash');
}

/* ----------------------------- reply ----------------------------- */

function startReply(m) {
  state.replyTo = { waId: m.wa_id || state.activeWaId, msg: m };
  els.replyName.textContent = senderName(m);
  els.replyText.textContent = snippetOf(m);
  els.replyBar.hidden = false;
  els.composerInput.focus();
}

function clearReply() {
  state.replyTo = null;
  els.replyBar.hidden = true;
}

// The quote for a send to waId, consumed by that send.
function takeReply(waId) {
  const r = state.replyTo;
  if (!r || r.waId !== waId) return null;
  clearReply();
  return r.msg.wa_message_id || null;
}

els.replyCancel.addEventListener('click', () => { clearReply(); els.composerInput.focus(); });

function stripCaption(body) {
  // body may be "📷 Image · caption"; show only the label part in the bubble
  if (!body) return '';
  const idx = body.indexOf(' · ');
  return idx > -1 ? body.slice(0, idx) : body;
}

function templateHtml(t) {
  let html = '<span class="tpl-tag">📋 Template</span><span class="tpl" dir="auto">';
  if (t.header) html += `<strong class="tpl-header">${escapeHtml(t.header)}</strong>`;
  html += escapeHtml(t.body);
  if (t.footer) html += `<span class="tpl-footer">${escapeHtml(t.footer)}</span>`;
  html += '</span>';
  if (t.buttons.length) html += `<span class="tpl-buttons">${t.buttons.map((b) => `<span class="tpl-button">${escapeHtml(b)}</span>`).join('')}</span>`;
  return html;
}

// WhatsApp could not hand this message over (a poll, a view-once photo and the like).
const UNSUPPORTED_LABEL = "⚠️ This message can't be shown here. Ask the member to send it again.";

function labelForType(type) {
  const map = {
    image: '📷 Image', audio: '🎵 Audio', voice: '🎤 Voice message',
    video: '🎬 Video', document: '📄 Document', sticker: '💟 Sticker',
    location: '📍 Location', contacts: '👤 Contact',
  };
  return map[type] || '💬 Message';
}

// `stick` is true while the agent is reading the newest messages, and only
// the agent can turn it off: by wheel, touch, keys, dragging the scrollbar or
// jumping to a quoted message. A chat that grows (a photo arriving, the
// keyboard opening) is pulled back to its end instead.
const pin = { stick: true, size: '', held: false, moved: false, personUntil: 0, glideUntil: 0 };

const sizeOfMessages = () => `${els.messages.scrollHeight}:${els.messages.clientHeight}`;
const personScrolling = () => pin.held || performance.now() < pin.personUntil;
function notePerson(ms = 1000) { pin.personUntil = performance.now() + ms; }

function scrollMessagesToBottom(instant = false) {
  const el = els.messages;
  pin.stick = true;
  pin.size = sizeOfMessages();
  if (instant) {
    // The smooth glide from the top of a long chat was cut short by the next
    // render and left the chat part-way down.
    el.style.scrollBehavior = 'auto';
    el.scrollTop = el.scrollHeight;
    el.style.scrollBehavior = '';
    return;
  }
  pin.glideUntil = performance.now() + 900;
  el.scrollTop = el.scrollHeight;
}

// Re-attempt a failed outgoing message. Two cases:
//  - client-drop (negative id + _retry payload): re-POST the original request.
//  - server/WhatsApp failure (real id): POST /api/retry/:id (resend from stored).
// On success the SAME bubble flips to sent — no duplicate.
async function retrySend(m) {
  const waId = m.wa_id || state.activeWaId;
  const t = thread(waId);
  const cur = t.byId.get(m.id);
  if (!cur || cur._retrying) return;

  // optimistic: show "sending" on the same bubble, hide retry/error
  t.byId.set(m.id, { ...cur, _retrying: true, status: 'pending', error: null });
  renderMessages();

  let resp;
  if (cur._retry) {
    // client-drop: re-POST the exact original request, reusing the original
    // idempotency key so the server dedupes if the first POST actually landed
    resp = await api(cur._retry.endpoint, {
      method: 'POST',
      headers: cur._retry.key ? { 'x-idempotency-key': cur._retry.key } : {},
      body: JSON.stringify(cur._retry.payload),
    });
  } else if (typeof m.id === 'number') {
    // server row: ask the server to resend from the stored copy
    resp = await api(`/api/retry/${m.id}`, { method: 'POST' });
  } else {
    resp = { ok: false, status: 0, data: { error: 'Nothing to retry.' } };
  }

  const { ok, status, data } = resp;
  if (status === 401) return handleAuthLost();

  const t2 = thread(waId);
  const stillThere = t2.byId.get(m.id);
  if (!stillThere) return; // bubble vanished (chat switched / replaced) — nothing to do

  if (ok && data.message) {
    // replace the failed bubble with the now-sent persisted row (no dup)
    t2.byId.delete(m.id);
    const idx = t2.order.indexOf(m.id);
    if (idx > -1) t2.order.splice(idx, 1);
    t2.byId.set(data.message.id, data.message);
    if (!t2.order.includes(data.message.id)) t2.order.push(data.message.id);
    mergeMessages(t2, []); // re-sort + advance maxUpdatedAt
    renderMessages();
    bumpConversationPreview(waId, data.message.body || stripCaption(stillThere.body) || '', 'out');
    toast('Message sent.');
  } else {
    // still failing — restore the failed state (and keep _retry for another go)
    t2.byId.set(m.id, { ...stillThere, _retrying: false, status: 'failed', error: (data && data.error) || 'Failed to send.' });
    renderMessages();
    if (data && data.code === 'WINDOW_CLOSED') {
      t2.lastInboundAt = data.last_inbound_at || null;
      renderWindow();
      toast(data.error, true);
      return;
    }
    setBanner((data && data.error) || 'Still couldn’t send. Check the connection or the 24-hour window.');
  }
}

/* ----------------------------- composer ----------------------------- */

function autoGrow() {
  const ta = els.composerInput;
  if (!ta.offsetWidth) { ta.style.height = ''; ta.classList.remove('is-scrolling'); return; }
  ta.style.height = 'auto';
  const full = ta.scrollHeight;
  ta.style.height = Math.min(full, 140) + 'px';
  // only show a scrollbar once we've hit the max height
  ta.classList.toggle('is-scrolling', full > 140);
}

// The phrase lib/whatsapp.js maps Meta's 131047 to. A send that hit it can only
// be recovered with a template, so the banner offers that fix inline.
const WINDOW_CLOSED = 'Outside the 24-hour reply window';

function setBanner(msg) {
  els.composerBanner.textContent = msg;
  els.composerBanner.hidden = false;
  if (!String(msg).includes(WINDOW_CLOSED)) return;
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'banner-action';
  action.textContent = 'Reopen with a follow-up template';
  action.addEventListener('click', openFollowupModal);
  els.composerBanner.appendChild(action);
}
function clearBanner() {
  els.composerBanner.hidden = true;
}

function refreshSendEnabled() {
  const something = Boolean(els.composerInput.value.trim() || state.pendingFile);
  els.sendBtn.disabled = state.sending || !something;
  // On a phone the microphone and the send button share one place.
  els.composerForm.classList.toggle('has-text', something);
}

function resetComposer() {
  clearPendingFile();
  els.composerInput.value = '';
  if (state.activeWaId) { delete state.drafts[state.activeWaId]; storeDrafts(); } // content was sent
  autoGrow();
  refreshSendEnabled();
}

// Persist the active chat's unsent composer text so it survives switching chats
// (and the mobile back button), WhatsApp-style.
function saveDraft() {
  if (!state.activeWaId) return;
  const text = els.composerInput.value;
  if (text && text.trim()) state.drafts[state.activeWaId] = text;
  else delete state.drafts[state.activeWaId];
  storeDrafts();
}

// Kept on this device, so a reload or a closed tab does not lose a half
// written answer.
const DRAFTS_KEY = 'wa_drafts';
let draftsTimer = null;
function storeDrafts() {
  clearTimeout(draftsTimer);
  draftsTimer = setTimeout(() => {
    try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(state.drafts)); } catch (_) {}
  }, 300);
}
try { Object.assign(state.drafts, JSON.parse(localStorage.getItem(DRAFTS_KEY)) || {}); } catch (_) {}

els.composerInput.addEventListener('input', () => {
  autoGrow();
  refreshSendEnabled();
  saveDraft(); // keep the per-chat draft current as the user types
  slashPicker();
});

els.composerInput.addEventListener('keydown', (e) => {
  if (replyPickerKey(e)) return;
  if (e.key === 'Escape' && state.replyTo) {
    e.preventDefault();
    clearReply();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    els.composerForm.requestSubmit();
  }
});

/* ----------------------------- attachments ----------------------------- */

// Meta takes images only as JPEG or PNG, up to 5 MB.
const IMAGE_MAX_BYTES = 5 * 1000 * 1000;

els.attachBtn.addEventListener('click', () => els.fileInput.click());

els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files && els.fileInput.files[0];
  els.fileInput.value = ''; // allow re-selecting the same file later
  if (file) stageFile(file);
});

function canStageFileFrom(target) {
  if (els.app.hidden || !state.activeWaId || state.rec) return false;
  if (document.querySelector('.modal-overlay:not([hidden]), .viewer:not([hidden])')) return false;
  const el = target instanceof Element ? target : null;
  return el === els.composerInput || !(el && el.closest('input, textarea, select, [contenteditable]'));
}

const canDropOn = (target) => els.thread.contains(target) && canStageFileFrom(target);
const draggingFiles = (e) => Boolean(e.dataTransfer && e.dataTransfer.types.includes('Files'));

function stageFirstFile(files) {
  if (files.length > 1) toast('One file at a time: attached the first.');
  stageFile(files[0]);
}

document.addEventListener('paste', (e) => {
  const data = e.clipboardData;
  if (!data || !data.files.length || !canStageFileFrom(e.target) || !canWriteFreely()) return;
  // Office copies put a picture of the selection next to its text; keep the text.
  if (data.types.includes('text/rtf') && data.getData('text/plain').trim()) return;
  e.preventDefault();
  stageFirstFile(data.files);
});

// Unhandled, a dropped file makes the browser navigate away to open it.
document.addEventListener('dragover', (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = canDropOn(e.target) ? 'copy' : 'none';
});
document.addEventListener('drop', (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  if (e.dataTransfer.files.length && canDropOn(e.target) && canWriteFreely()) stageFirstFile(e.dataTransfer.files);
});

async function stageFile(file) {
  const waId = state.activeWaId;
  file = await fitImageForWhatsApp(file);
  if (state.activeWaId !== waId) return;
  if (file.size > 25 * 1024 * 1024) {
    setBanner('File too large (max 25 MB).');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    if (state.activeWaId !== waId) return;
    const dataUrl = reader.result; // data:<mime>;base64,XXXX
    const base64 = String(dataUrl).split(',')[1] || '';
    state.pendingFile = { name: file.name, mime: file.type || 'application/octet-stream', size: file.size, base64, dataUrl };
    showPendingFile();
    refreshSendEnabled();
    els.composerInput.focus();
  };
  reader.readAsDataURL(file);
}

// Pasted screenshots and photos are often PNGs well over the cap: re-encode as
// a JPEG that fits. Anything the browser cannot decode is left as it was.
async function fitImageForWhatsApp(file) {
  if (!file.type.startsWith('image/')) return file;
  if (/^image\/(jpeg|png)$/.test(file.type) && file.size <= IMAGE_MAX_BYTES) return file;
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch (_) { return file; }
  let scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
  let jpeg = null;
  for (let i = 0; i < 6 && !jpeg; i++, scale *= 0.75) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // JPEG has no alpha, so transparent pixels would turn black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (blob && blob.size <= IMAGE_MAX_BYTES) jpeg = blob;
  }
  bitmap.close();
  if (!jpeg) return file;
  return new File([jpeg], `${(file.name || 'image').replace(/\.[^.]*$/, '')}.jpg`, { type: 'image/jpeg' });
}

els.attachRemove.addEventListener('click', clearPendingFile);

function showPendingFile() {
  const f = state.pendingFile;
  if (!f) return;
  els.attachName.textContent = f.name;
  els.attachSize.textContent = humanSize(f.size);
  const isImg = f.mime.startsWith('image/');
  els.attachThumbImg.hidden = !isImg;
  els.attachThumbIco.hidden = isImg;
  if (isImg) els.attachThumbImg.src = f.dataUrl;
  else els.attachThumbIco.textContent = f.mime.startsWith('video/') ? '🎬' : f.mime.startsWith('audio/') ? '🎵' : '📄';
  els.attachPreview.hidden = false;
}

function clearPendingFile() {
  state.pendingFile = null;
  els.attachPreview.hidden = true;
  els.attachThumbImg.removeAttribute('src');
  refreshSendEnabled();
}

function humanSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function sendPendingFile() {
  const waId = state.activeWaId;
  const f = state.pendingFile;
  if (!f || !waId) return null;
  const caption = els.composerInput.value.trim();
  resetComposer();
  return sendFile(waId, f, caption);
}

// A voice note goes to the chat it was recorded in, and leaves whatever is
// typed in the composer alone.
async function sendFile(waId, f, caption = '') {
  const isVoice = Boolean(f.voice);
  const kind = f.mime.startsWith('image/') ? 'image'
    : f.mime.startsWith('video/') ? 'video'
    : f.mime.startsWith('audio/') ? 'audio' : 'document';
  const label = isVoice ? '🎤 Voice message'
    : { image: '📷 Image', video: '🎬 Video', audio: '🎵 Audio', document: '📄 Document' }[kind];

  // optimistic bubble — show the local preview immediately for images + voice
  const localPlayable = kind === 'image' || kind === 'audio';
  const replyTo = takeReply(waId);
  const opt = addOptimistic(waId, {
    type: kind,
    body: caption ? `${label} · ${caption}` : label,
    media_status: localPlayable ? 'stored' : null,
    media_meta: { filename: f.name, mime_type: f.mime, caption: caption || null, voice: isVoice || null, reply_to: replyTo },
    _localUrl: localPlayable ? f.dataUrl : null,
  });

  const payload = { wa_id: waId, file_base64: f.base64, mime: f.mime, filename: f.name, caption, voice: isVoice, reply_to: replyTo };
  state.sending = true;
  els.sendBtn.disabled = true;
  clearBanner();

  const sendKey = newSendKey();
  opt.client_key = sendKey;
  const { ok, status, data } = await api('/api/send-media', {
    method: 'POST',
    headers: { 'x-idempotency-key': sendKey },
    body: JSON.stringify(payload),
  });
  state.sending = false;
  refreshSendEnabled();
  if (status === 401) return handleAuthLost();

  if (ok && data.message) {
    settleOptimistic(waId, opt, null, data.message);
    if (waId === state.activeWaId) scrollMessagesToBottom();
    bumpConversationPreview(waId, opt.body, 'out');
  } else if (status === 207) {
    settleOptimistic(waId, opt, { _optimistic: false, status: 'sent' });
    toast(data.warning || 'Sent, but not saved.');
  } else if (windowRefused(waId, opt, data)) {
    state.pendingFile = null;
  } else {
    // keep the failed bubble retryable: re-POST the same media (base64
    // retained) with the SAME idempotency key so the server can dedupe
    settleOptimistic(waId, opt, {
      _optimistic: false, status: 'failed', error: data.error || 'Failed to send.',
      _retry: { endpoint: '/api/send-media', payload, key: sendKey },
    });
    if (waId === state.activeWaId) setBanner(data.error || 'Failed to send attachment.');
    else toast(data.error || 'Failed to send attachment.', true);
  }
}

/* --------------------- voice note recording --------------------- */
// Record audio in the browser via MediaRecorder, then send it through the
// existing media path. Heads-up: WhatsApp renders uploaded audio as a regular
// audio message on the customer's phone (not its native push-to-talk bubble) —
// a Cloud API limitation. In our dashboard it shows with the voice player.

// Pick whatever the browser records best. The SERVER transcodes voice notes to
// OGG/Opus before sending to WhatsApp, so the client format no longer has to be
// WhatsApp-valid — we just need something MediaRecorder can produce. Prefer
// opus-in-ogg/webm (small, good for speech), then mp4, else the browser default.
function pickRecorderMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = [
    'audio/ogg;codecs=opus',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ];
  for (const m of candidates) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
  }
  return ''; // empty -> let MediaRecorder choose its own default
}

function fmtRecTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function showRecBar(on) {
  els.recBar.hidden = !on;
  els.composerForm.style.display = on ? 'none' : '';
}

async function startRecording() {
  if (state.rec || !state.activeWaId || !canWriteFreely()) return;
  const waId = state.activeWaId;
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    setBanner('Voice recording is not supported in this browser.');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    setBanner(e && e.name === 'NotAllowedError'
      ? 'Microphone permission denied. Allow mic access to record.'
      : 'Could not access the microphone.');
    return;
  }
  clearBanner();
  const mime = pickRecorderMime(); // '' = use browser default; null = unsupported
  if (mime === null) {
    stream.getTracks().forEach((t) => t.stop());
    setBanner('Voice recording is not supported in this browser.');
    return;
  }
  let mediaRecorder;
  try {
    mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  } catch (_) {
    try { mediaRecorder = new MediaRecorder(stream); }
    catch (e2) {
      stream.getTracks().forEach((t) => t.stop());
      setBanner('Could not start recording.');
      return;
    }
  }
  const chunks = [];
  mediaRecorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) chunks.push(e.data); });

  // Timing fields support pause/resume: elapsed = (now - startedAt) - pausedMs,
  // and while paused we freeze using pauseStartedAt.
  const startedAt = performance.now();
  if (state.activeWaId !== waId) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  const rec = {
    waId,
    mediaRecorder, stream, chunks, startedAt, timer: null, canceled: false,
    requestedMime: mime, paused: false, pausedMs: 0, pauseStartedAt: 0,
  };
  state.rec = rec;

  mediaRecorder.addEventListener('stop', () => finishRecording(rec));

  // live timer; auto-stop at 5 min of ACTUAL recorded time
  setRecPausedUI(false);
  els.recTime.textContent = '0:00';
  rec.timer = setInterval(() => {
    if (rec.paused) return; // freeze the displayed time while paused
    const elapsed = recElapsedMs(rec);
    els.recTime.textContent = fmtRecTime(elapsed);
    if (elapsed > 5 * 60 * 1000) stopRecording();
  }, 200);

  showRecBar(true);
  mediaRecorder.start();
}

// True recorded time, excluding any paused spans.
function recElapsedMs(rec) {
  const raw = performance.now() - rec.startedAt;
  const pausedSoFar = rec.pausedMs + (rec.paused ? (performance.now() - rec.pauseStartedAt) : 0);
  return Math.max(0, raw - pausedSoFar);
}

// While a voice note is being recorded for another chat, the bar says whose.
function recHintText(paused) {
  const rec = state.rec;
  if (rec && rec.waId !== state.activeWaId) {
    const conv = convOf(rec.waId) || { wa_id: rec.waId };
    return `${paused ? 'Paused' : 'Recording'} for ${displayName(conv)}. Send or cancel it first.`;
  }
  return paused ? 'Paused. Tap ▶ to resume' : 'Recording… tap send to finish';
}

function setRecPausedUI(paused) {
  els.recBar.classList.toggle('paused', paused);
  els.recHint.textContent = recHintText(paused);
  els.recPause.title = paused ? 'Resume' : 'Pause';
  els.recPause.setAttribute('aria-label', paused ? 'Resume recording' : 'Pause recording');
  // NB: SVGElement doesn't reliably reflect the `.hidden` IDL property to the
  // `hidden` attribute, so toggle the attribute explicitly (which the global
  // `[hidden]{display:none!important}` rule matches).
  const pauseIco = els.recPause.querySelector('.ico-pause');
  const resumeIco = els.recPause.querySelector('.ico-resume');
  if (pauseIco) pauseIco.toggleAttribute('hidden', paused);
  if (resumeIco) resumeIco.toggleAttribute('hidden', !paused);
}

function togglePause() {
  const rec = state.rec;
  if (!rec || rec.mediaRecorder.state === 'inactive') return;
  if (!rec.paused) {
    // pause: MediaRecorder.pause() stops emitting data but KEEPS the session,
    // so chunks resume accumulating into the same recording on resume.
    if (rec.mediaRecorder.state === 'recording') rec.mediaRecorder.pause();
    rec.paused = true;
    rec.pauseStartedAt = performance.now();
    setRecPausedUI(true);
  } else {
    if (rec.mediaRecorder.state === 'paused') rec.mediaRecorder.resume();
    rec.pausedMs += performance.now() - rec.pauseStartedAt;
    rec.paused = false;
    rec.pauseStartedAt = 0;
    setRecPausedUI(false);
  }
}

function stopRecording() {
  const rec = state.rec;
  if (!rec) return;
  if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
  if (rec.mediaRecorder.state !== 'inactive') rec.mediaRecorder.stop(); // triggers 'stop' -> finishRecording
}

function cancelRecording() {
  const rec = state.rec;
  if (!rec) return;
  rec.canceled = true;
  if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
  if (rec.mediaRecorder.state !== 'inactive') rec.mediaRecorder.stop();
}

function finishRecording(rec) {
  // release the mic
  rec.stream.getTracks().forEach((t) => t.stop());
  showRecBar(false);
  state.rec = null;
  if (rec.canceled) return;

  // Whatever the browser recorded — the server transcodes it to OGG/Opus before
  // sending to WhatsApp, so the client format doesn't need to be WhatsApp-valid.
  const fullMime = rec.mediaRecorder.mimeType || rec.requestedMime || 'audio/webm';
  const bareMime = fullMime.split(';')[0].trim().toLowerCase();
  const blob = new Blob(rec.chunks, { type: fullMime });
  if (!blob.size) { setBanner('Nothing was recorded.'); return; }
  if (blob.size > 25 * 1024 * 1024) { setBanner('Recording too large (max 25 MB).'); return; }

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const base64 = String(dataUrl).split(',')[1] || '';
    const ext = bareMime.includes('ogg') ? 'ogg' : bareMime.includes('webm') ? 'webm'
      : bareMime.includes('mp4') ? 'm4a' : bareMime.includes('aac') ? 'aac' : 'webm';
    // Voice notes send immediately on stop (WhatsApp-style), with no staging preview.
    sendFile(rec.waId, { name: `voice-note.${ext}`, mime: bareMime, size: blob.size, base64, dataUrl, voice: true });
    if (rec.waId !== state.activeWaId) {
      const conv = convOf(rec.waId) || { wa_id: rec.waId };
      toast(`Sending the voice note to ${displayName(conv)}.`);
    }
  };
  reader.readAsDataURL(blob);
}

els.micBtn.addEventListener('click', startRecording);
els.recSend.addEventListener('click', stopRecording);
els.recCancel.addEventListener('click', cancelRecording);
els.recPause.addEventListener('click', togglePause);

// Add an optimistic outgoing bubble to the active thread and render it.
function addOptimistic(waId, fields) {
  const t = thread(waId);
  const localId = state.optimisticSeq--;
  const opt = {
    id: localId,
    _key: `k${localId}`,
    _optimistic: true,
    wa_id: waId,
    direction: 'out',
    status: 'pending',
    agent: state.agentNames && agentName ? agentName : undefined,
    created_at: new Date().toISOString(),
    wa_timestamp: new Date().toISOString(),
    ...fields,
  };
  t.byId.set(opt.id, opt);
  t.order.push(opt.id);
  if (waId === state.activeWaId) {
    renderMessages();
    scrollMessagesToBottom();
  }
  return opt;
}

// The server refused a send because the 24 hours are over: nothing reached
// WhatsApp, so the bubble goes, the text stays as a draft, and the chat locks.
function windowRefused(waId, opt, data, draftText) {
  if (!data || data.code !== 'WINDOW_CLOSED') return false;
  const t = thread(waId);
  t.byId.delete(opt.id);
  const idx = t.order.indexOf(opt.id);
  if (idx > -1) t.order.splice(idx, 1);
  t.lastInboundAt = data.last_inbound_at || null;
  for (const m of t.byId.values()) {
    if (m.direction === 'in' && Date.parse(m.wa_timestamp || m.created_at) > Date.parse(data.last_inbound_at || 0)) {
      t.lastInboundAt = m.wa_timestamp || m.created_at;
    }
  }
  if (draftText) { state.drafts[waId] = draftText; storeDrafts(); }
  if (waId === state.activeWaId) { renderMessages(); renderWindow(); }
  return true;
}

// Replace an optimistic bubble with the server's persisted row (or mutate it).
function settleOptimistic(waId, opt, patch, persisted) {
  const t = thread(waId);
  t.byId.delete(opt.id);
  const idx = t.order.indexOf(opt.id);
  if (idx > -1) t.order.splice(idx, 1);
  let row = persisted || { ...opt, ...patch };
  const seen = persisted ? t.byId.get(row.id) : null;
  if (seen) {
    const status = shownStatus(seen, row);
    row = { ...seen, ...row, status, error: status === row.status ? row.error : seen.error };
  }
  if (persisted) takeOver(seen && seen._key ? seen : opt, row);
  t.byId.set(row.id, row);
  // The 1500ms poll usually beats the ~3.5s send, so this row may already be in
  // order (the twin-drop having removed the optimistic id). Pushing regardless
  // listed it twice and drew the message twice until the thread was rebuilt.
  if (!t.order.includes(row.id)) t.order.push(row.id);
  if (typeof row.id === 'number' && row.id > t.lastMsgId) t.lastMsgId = row.id;
  mergeMessages(t, []); // re-sort
  if (waId === state.activeWaId) renderMessages();
}

addTapTick(els.sendBtn);
['pointerdown', 'mousedown'].forEach((type) => els.sendBtn.addEventListener(type, (e) => {
  if (document.activeElement === els.composerInput) e.preventDefault();
}));

els.composerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.sending || !state.activeWaId) return;
  const waId = state.activeWaId;
  if (!canWriteFreely(waId)) { renderWindow(); return; }

  // If a file is staged, send media; otherwise send text.
  if (state.pendingFile) return sendPendingFile();

  const text = els.composerInput.value.trim();
  if (!text) return;

  const replyTo = takeReply(waId);
  const opt = addOptimistic(waId, { type: 'text', body: text, media_meta: replyTo ? { reply_to: replyTo } : null });
  els.composerInput.value = '';
  delete state.drafts[waId]; // sent → no lingering draft
  storeDrafts();
  autoGrow();
  state.sending = true;
  refreshSendEnabled();
  clearBanner();

  const sendKey = newSendKey();
  opt.client_key = sendKey;
  const { ok, status, data } = await api('/api/send', {
    method: 'POST',
    headers: { 'x-idempotency-key': sendKey },
    body: JSON.stringify({ wa_id: waId, text, reply_to: replyTo }),
  });

  state.sending = false;
  refreshSendEnabled();
  if (status === 401) return handleAuthLost();

  if (ok && data.message) {
    settleOptimistic(waId, opt, null, data.message);
    scrollMessagesToBottom();
    bumpConversationPreview(waId, text, 'out');
  } else if (status === 207) {
    settleOptimistic(waId, opt, { _optimistic: false, status: 'sent' });
    toast(data.warning || 'Sent, but not saved.');
  } else if (windowRefused(waId, opt, data, text)) {
    // locked; the text waits as a draft for the member's reply
  } else {
    // keep the failed bubble retryable: re-POST the same text on retry,
    // carrying the SAME idempotency key so the server can dedupe
    settleOptimistic(waId, opt, {
      _optimistic: false, status: 'failed', error: data.error || 'Failed to send.',
      _retry: { endpoint: '/api/send', payload: { wa_id: waId, text, reply_to: replyTo }, key: sendKey },
    });
    setBanner(data.error || 'Failed to send. Check the connection and try again.');
  }
});

function bumpConversationPreview(waId, text, direction) {
  const conv = convOf(waId);
  if (conv) {
    conv.last_message_text = text;
    conv.last_message_at = new Date().toISOString();
    conv.last_message_direction = direction || 'out';
    if (state.teamwork && conv.last_message_direction === 'out') { conv.unread_count = 0; conv.needs_reply = false; }
    // re-sort: most recent first
    state.conversations.sort((a, b) =>
      new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0)
    );
    renderConversations();
  }
}

function isNearBottom() {
  const el = els.messages;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

// Scrolling up to read lets go of the end of the chat; coming back takes it
// again. A scroll event also fires when the chat merely grew, and reading
// that as the agent scrolling away is what used to leave a chat part-way up.
els.messages.addEventListener('scroll', () => {
  const size = sizeOfMessages();
  const grew = size !== pin.size;
  pin.size = size;
  if (personScrolling()) { pin.stick = isNearBottom(); return; }
  if (performance.now() < pin.glideUntil) return;
  if (!grew) { pin.stick = isNearBottom(); return; }
  if (pin.stick) scrollMessagesToBottom(true);
}, { passive: true });

els.messages.addEventListener('wheel', () => notePerson(), { passive: true });
els.messages.addEventListener('touchstart', () => { pin.held = true; pin.moved = false; }, { passive: true });
els.messages.addEventListener('touchmove', () => { pin.moved = true; }, { passive: true });
for (const type of ['touchend', 'touchcancel']) {
  els.messages.addEventListener(type, () => {
    pin.held = false;
    if (pin.moved) notePerson(2500); // the flick keeps rolling after the finger lifts
  }, { passive: true });
}
els.messages.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.target === els.messages) pin.held = true; // the scrollbar
});
window.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'mouse' && pin.held) { pin.held = false; notePerson(300); }
});
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']);
els.messages.addEventListener('keydown', (e) => { if (SCROLL_KEYS.has(e.key)) notePerson(); });

// A photo or video whose size was not known beforehand takes its real shape
// once the browser has read it.
function sizeFrameFrom(el) {
  const frame = el.closest('.media-frame');
  if (!frame || frame.style.getPropertyValue('--ar')) return;
  const w = el.naturalWidth || el.videoWidth;
  const h = el.naturalHeight || el.videoHeight;
  const box = frameBox(w, h, frame.classList.contains('is-sticker'));
  if (!box) return;
  frame.style.setProperty('--w', `${box.width}px`);
  frame.style.setProperty('--ar', box.ratio.toFixed(4));
  const bubble = frame.closest('.bubble');
  const m = bubble && state.activeWaId && thread(state.activeWaId).byId.get(Number(bubble.dataset.mid));
  if (m) m.media_meta = { ...(m.media_meta || {}), w, h };
}

for (const type of ['load', 'loadedmetadata', 'error']) {
  // These events do not bubble, so they are caught on the way down.
  els.messages.addEventListener(type, (e) => {
    if (e.target === els.messages) return;
    if (type !== 'error') sizeFrameFrom(e.target);
    if (pin.stick) scrollMessagesToBottom(true);
  }, true);
}
window.addEventListener('resize', () => { if (pin.stick && !els.thread.hidden) scrollMessagesToBottom(true); });
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => { if (pin.stick && !els.thread.hidden) scrollMessagesToBottom(true); });
}

/* --------------------------- back (mobile) --------------------------- */

const phoneLayout = window.matchMedia('(max-width: 720px)');
phoneLayout.addEventListener('change', () => tuckFilters(phoneLayout.matches));
tuckFilters(phoneLayout.matches);

/* ----------------------- the chat list on a wide screen ----------------------- */
const LIST_W_KEY = 'wa_list_w';
const LIST_HIDDEN_KEY = 'wa_list_hidden';
const listPane = {
  handle: $('#list-handle'),
  toggle: $('#list-toggle'),
  width: null,
  hidden: false,
  frame: 0,
  drag: null,
};
try {
  const w = Number(localStorage.getItem(LIST_W_KEY));
  if (Number.isFinite(w) && w > 0) listPane.width = w;
  listPane.hidden = localStorage.getItem(LIST_HIDDEN_KEY) === '1';
} catch (_) {}

function listBounds() {
  return { min: 260, max: Math.max(260, Math.min(560, Math.round(window.innerWidth * 0.45))) };
}
function clampListWidth(w) {
  const { min, max } = listBounds();
  return Math.round(Math.min(max, Math.max(min, w)));
}
function currentListWidth() {
  if (listPane.width !== null) return listPane.width;
  return parseFloat(getComputedStyle(els.app).getPropertyValue('--list-w')) || 372;
}
function setListWidth(w, remember = true) {
  if (w === null) {
    listPane.width = null;
    els.app.style.removeProperty('--list-w');
    try { localStorage.removeItem(LIST_W_KEY); } catch (_) {}
  } else {
    listPane.width = clampListWidth(w);
    els.app.style.setProperty('--list-w', `${listPane.width}px`);
    if (remember) { try { localStorage.setItem(LIST_W_KEY, String(listPane.width)); } catch (_) {} }
  }
  listPane.handle.setAttribute('aria-valuenow', String(Math.round(listPane.width || currentListWidth())));
  if (state.activeWaId) fitThreadHeader();
}
function applyListPane() {
  const wide = !phoneLayout.matches;
  if (wide && listPane.width !== null) els.app.style.setProperty('--list-w', `${clampListWidth(listPane.width)}px`);
  else els.app.style.removeProperty('--list-w');
  const hide = wide && listPane.hidden && Boolean(state.activeWaId);
  els.app.classList.toggle('list-hidden', hide);
  listPane.toggle.setAttribute('aria-pressed', String(hide));
  const words = hide ? 'Show the chat list' : 'Hide the chat list';
  listPane.toggle.setAttribute('aria-label', words);
  listPane.toggle.title = `${words} (Ctrl+B)`;
  const { min, max } = listBounds();
  listPane.handle.setAttribute('aria-valuemin', String(min));
  listPane.handle.setAttribute('aria-valuemax', String(max));
}
function toggleListPane(force) {
  if (phoneLayout.matches) return;
  const next = typeof force === 'boolean' ? force : !els.app.classList.contains('list-hidden');
  if (next && !state.activeWaId) return;
  listPane.hidden = next;
  try { localStorage.setItem(LIST_HIDDEN_KEY, next ? '1' : '0'); } catch (_) {}
  applyListPane();
  setTimeout(() => { if (state.activeWaId) fitThreadHeader(); }, 220);
}

listPane.toggle.addEventListener('click', () => toggleListPane());
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || String(e.key).toLowerCase() !== 'b') return;
  if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (phoneLayout.matches || !state.activeWaId) return;
  e.preventDefault();
  toggleListPane();
});

const rtl = () => getComputedStyle(els.app).direction === 'rtl';
listPane.handle.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || phoneLayout.matches) return;
  e.preventDefault();
  listPane.handle.setPointerCapture(e.pointerId);
  listPane.drag = { x: e.clientX, w: currentListWidth(), next: null };
  els.app.classList.add('list-dragging');
});
listPane.handle.addEventListener('pointermove', (e) => {
  const d = listPane.drag;
  if (!d) return;
  const dx = (e.clientX - d.x) * (rtl() ? -1 : 1);
  d.next = d.w + dx;
  if (listPane.frame) return;
  listPane.frame = requestAnimationFrame(() => {
    listPane.frame = 0;
    if (listPane.drag && listPane.drag.next !== null) setListWidth(listPane.drag.next, false);
  });
});
const endListDrag = (e) => {
  if (!listPane.drag) return;
  const d = listPane.drag;
  listPane.drag = null;
  els.app.classList.remove('list-dragging');
  try { listPane.handle.releasePointerCapture(e.pointerId); } catch (_) {}
  if (d.next !== null) setListWidth(d.next);
};
listPane.handle.addEventListener('pointerup', endListDrag);
listPane.handle.addEventListener('pointercancel', endListDrag);
listPane.handle.addEventListener('dblclick', () => setListWidth(null));
listPane.handle.addEventListener('keydown', (e) => {
  const step = { ArrowLeft: -16, ArrowRight: 16 }[e.key];
  if (e.key === 'Home') { e.preventDefault(); setListWidth(listBounds().min); return; }
  if (e.key === 'End') { e.preventDefault(); setListWidth(listBounds().max); return; }
  if (e.key === 'Enter') { e.preventDefault(); setListWidth(null); return; }
  if (!step) return;
  e.preventDefault();
  setListWidth(currentListWidth() + step * (rtl() ? -1 : 1));
});
window.addEventListener('resize', () => {
  if (listPane.width !== null && !phoneLayout.matches) els.app.style.setProperty('--list-w', `${clampListWidth(listPane.width)}px`);
});
phoneLayout.addEventListener('change', applyListPane);
applyListPane();

function closeThread() {
  saveDraft(); // keep the unsent text for when this chat is reopened
  clearReply();
  closePeerSheet();
  els.app.dataset.view = 'list';
  state.activeWaId = null;
  applyListPane();
  stopThreadPolling();
  els.thread.hidden = true;
  els.placeholder.hidden = false;
  renderConversations();
}

els.backBtn.addEventListener('click', () => {
  if (history.state && history.state.chat) history.back();
  else closeThread();
});

window.addEventListener('popstate', () => {
  if (!phoneLayout.matches) return;
  const viewer = document.getElementById('viewer');
  if (viewer && !viewer.hidden) {
    closeViewer();
    history.pushState({ chat: true }, '');
    return;
  }
  // The back gesture closes what is on top first, then the chat.
  if (!els.peerSheet.hidden || !els.sheet.hidden) {
    closePeerSheet();
    closeSheet();
    history.pushState({ chat: true }, '');
    return;
  }
  if (els.app.dataset.view === 'thread') closeThread();
});

// The on-screen keyboard covers the bottom of the page without resizing it.
// Size the app to what is really visible, so the composer sits on top of the
// keyboard and the chat header stays on screen.
if (window.visualViewport && (navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches)) {
  const vv = window.visualViewport;
  const root = document.documentElement;
  let lastH = 0;
  let fullH = 0;
  let fullW = 0;
  const fit = () => {
    if (vv.scale > 1.01) return; // pinch zoom, not the keyboard
    const h = Math.round(vv.height);
    // The tallest the screen has been at this width is the screen without the
    // keyboard. While the keyboard is up it covers the home bar, so the
    // composer needs no room for it.
    const w = Math.round(vv.width);
    if (w !== fullW) { fullW = w; fullH = h; }
    fullH = Math.max(fullH, h);
    root.classList.toggle('kb-open', fullH - h > 120);
    root.style.setProperty('--app-h', `${h}px`);
    if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
    root.style.setProperty('--app-top', `${Math.round(vv.offsetTop)}px`);
    if (lastH && h < lastH && !els.thread.hidden) els.messages.scrollTop += lastH - h;
    lastH = h;
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}

/* ----------------------------- polling ----------------------------- */

// Server push: every write on the server sends a "change" and the tab fetches
// only what changed. EventSource reconnects by itself; each (re)connect sends
// "ready", which catches up on anything missed while the stream was down.
function startLive() {
  stopLive();
  if (!window.EventSource) return;
  const es = new EventSource('/api/events');
  state.events = es;
  es.addEventListener('ready', () => { state.live = true; liveRefresh(); });
  es.addEventListener('change', liveRefresh);
  es.onerror = () => {
    state.live = false;
    if (es.readyState === EventSource.CLOSED && state.events === es) {
      state.events = null;
      setTimeout(() => { if (!state.events && !els.app.hidden) startLive(); }, 15000);
    }
  };
}
function stopLive() {
  if (state.events) state.events.close();
  state.events = null;
  state.live = false;
}

let liveBusy = false;
let liveAgain = false;
async function liveRefresh() {
  if (liveBusy) { liveAgain = true; return; }
  liveBusy = true;
  try {
    await Promise.all([refreshConversations(), state.activeWaId ? loadThread(false) : null]);
  } finally {
    liveBusy = false;
    if (liveAgain) { liveAgain = false; liveRefresh(); }
  }
}

// Fallback polling, and a once-a-minute safety net while the stream is up. It
// keeps running in a background tab so new messages can still alert; a worker
// drives it because browsers throttle page timers in hidden tabs.
function startListPolling() {
  stopListPolling();
  state.listPolling = true;
  state.lastListPoll = Date.now();
  const tick = () => {
    if (!state.listPolling) return;
    const gap = state.live ? SAFETY_POLL_MS : document.hidden ? HIDDEN_LIST_POLL_MS : LIST_POLL_MS;
    if (Date.now() - state.lastListPoll < gap - 500) return;
    state.lastListPoll = Date.now();
    if (state.live) liveRefresh();
    else refreshConversations();
  };
  try {
    const src = `setInterval(() => postMessage(0), ${LIST_POLL_MS})`;
    state.listTimer = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    state.listTimer.onmessage = tick;
  } catch (_) {
    state.listTimer = setInterval(tick, LIST_POLL_MS);
  }
}
function stopListPolling() {
  state.listPolling = false;
  if (state.listTimer instanceof Worker) state.listTimer.terminate();
  else if (state.listTimer) clearInterval(state.listTimer);
  state.listTimer = null;
}
function startThreadPolling() {
  stopThreadPolling();
  state.threadTimer = setInterval(() => {
    if (document.hidden || !state.activeWaId || state.live) return;
    loadThread(false);
  }, THREAD_POLL_MS);
}
function stopThreadPolling() {
  if (state.threadTimer) clearInterval(state.threadTimer);
  state.threadTimer = null;
}

// Refresh on tab visibility so returning to the tab pulls fresh data instantly.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !els.app.hidden) {
    refreshConversations();
    if (state.activeWaId) loadThread(false);
    readActiveIfMissed();
  }
});
window.addEventListener('focus', readActiveIfMissed);

/* ----------------------------- tab alerts ----------------------------- */

// New inbound messages show as "(3) Inbox" in the tab title, a red dot on the
// favicon, a short chime, and a desktop notification when the tab isn't in
// front. The chat that is open and in front is read on arrival instead.
const BASE_TITLE = document.title;
const iconLink = document.querySelector('link[rel="icon"]');
const BASE_ICON = iconLink.getAttribute('href');
const DOT_ICON = BASE_ICON.replace(/%3C\/svg%3E$/,
  "%3Ccircle cx='78' cy='22' r='20' fill='%23e5484d' stroke='%23fff' stroke-width='6'/%3E%3C/svg%3E");
const alerts = { seen: null, audio: null, missedActive: false };

function inboxInFront() {
  return !document.hidden && document.hasFocus();
}

// With teamwork on, a chat keeps its count until it is answered, so the tab
// counts the chats with something this device has not seen yet. Without it,
// the tab counts unread messages as it always did.
function updateTabBadge() {
  const counted = (state.list.counts || {}).unread;
  const total = els.app.hidden ? 0
    : state.teamwork ? new Set(state.recent.concat(state.conversations).filter(newHere).map((c) => c.wa_id)).size
    : counted != null ? counted
    : state.conversations.reduce((n, c) => n + (c.unread_count || 0), 0);
  const title = total ? `(${total > 99 ? '99+' : total}) ${BASE_TITLE}` : BASE_TITLE;
  if (document.title !== title) document.title = title;
  const icon = total ? DOT_ICON : BASE_ICON;
  if (iconLink.getAttribute('href') !== icon) iconLink.setAttribute('href', icon);
  if (navigator.setAppBadge) {
    try { (total ? navigator.setAppBadge(total) : navigator.clearAppBadge()).catch(() => {}); } catch (_) {}
  }
}

function noteIncoming(conversations) {
  // A chat counts as fresh when its last message changed since the last look,
  // or when it is one this tab has never seen and newer than everything it had.
  const prev = alerts.seen;
  const newestBefore = alerts.newest || '';
  alerts.seen = new Map(prev || []);
  for (const c of conversations) {
    alerts.seen.set(c.wa_id, c.last_message_at);
    if (c.last_message_at && c.last_message_at > (alerts.newest || '')) alerts.newest = c.last_message_at;
  }
  if (!prev) return;
  const fresh = conversations.filter((c) => c.last_message_direction === 'in' && c.last_message_at
    && (prev.has(c.wa_id) ? c.last_message_at !== prev.get(c.wa_id) : c.last_message_at > newestBefore));
  if (!fresh.length) return;

  const front = inboxInFront();
  const others = [];
  for (const c of fresh) {
    if (c.wa_id === state.activeWaId && front) {
      if (state.teamwork) markSeenHere(c);
      else c.unread_count = 0;
      api('/api/mark-read', { method: 'POST', body: JSON.stringify({ wa_id: c.wa_id }) }).catch(() => {});
    } else {
      if (c.wa_id === state.activeWaId) alerts.missedActive = true;
      others.push(c);
    }
  }
  if (!others.length) return;
  chime();
  if (!front) others.forEach(notify);
}

function readActiveIfMissed() {
  if (!alerts.missedActive || !state.activeWaId || !inboxInFront()) return;
  alerts.missedActive = false;
  const conv = convOf(state.activeWaId);
  if (conv) {
    if (state.teamwork) markSeenHere(conv);
    else conv.unread_count = 0;
    renderConversations();
  }
  api('/api/mark-read', { method: 'POST', body: JSON.stringify({ wa_id: state.activeWaId }) }).catch(() => {});
}

function notify(c) {
  if (pushCtl.on) return; // this device gets it from the server instead
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const body = c.last_message_text || 'New message';
  if (pushCtl.reg) {
    // Chrome on Android refuses a notification made by the page itself; the
    // worker's works there and on desktop, and web/sw.js opens the chat on tap.
    pushCtl.reg.showNotification(displayName(c), {
      body, tag: `wa-${c.wa_id}`, icon: '/static/icon-192.png', data: { wa_id: c.wa_id },
    }).catch(() => {});
    return;
  }
  try {
    const n = new Notification(displayName(c), {
      body,
      tag: `wa-${c.wa_id}`,
      icon: DOT_ICON,
    });
    n.onclick = () => {
      window.focus();
      n.close();
      if (els.app.hidden) return;
      openConversation(c.wa_id);
      alerts.missedActive = false;
    };
  } catch (_) {}
}

function chime() {
  const ctx = alerts.audio;
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    [[880, 0], [1320, 0.13]].forEach(([freq, delay]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.2, t + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t + delay);
      osc.stop(t + delay + 0.4);
    });
  } catch (_) {}
}

// Browsers only allow sound and the notification prompt after the user has
// interacted with the page, so both are set up on the first click or key.
function unlockAlerts() {
  document.removeEventListener('pointerdown', unlockAlerts, true);
  document.removeEventListener('keydown', unlockAlerts, true);
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx && !alerts.audio) alerts.audio = new Ctx();
  } catch (_) {}
  // A Home Screen app on an iPhone asks from a full tap instead (askOnTap).
  if ('Notification' in window && Notification.permission === 'default' && !(IS_IOS && IS_HOME_SCREEN_APP)) {
    Notification.requestPermission().then((perm) => { if (perm === 'granted') autoSubscribe(); renderNotifyNote(); }).catch(() => {});
  }
}
document.addEventListener('pointerdown', unlockAlerts, true);
document.addEventListener('keydown', unlockAlerts, true);

/* ---------------- notifications on a phone or a closed tab ---------------- */

// The alerts above need the inbox open in a tab. A phone freezes the page as
// soon as it leaves the screen, so there the server sends the notification
// (lib/push.js) and web/sw.js shows it. Every signed-in device is signed up
// by itself: the browser is asked on the first tap, nothing to press.
const pushCtl = { reg: null, key: null, on: false };
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_HOME_SCREEN_APP = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const PUSH_OK = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

try { localStorage.removeItem('wa_bell_off'); localStorage.removeItem('wa_bell_hint'); } catch (_) {}

function setBell(on) {
  pushCtl.on = on;
  renderNotifyNote();
}

// One quiet line in the menu, only when something needs the person.
function notifyWords() {
  if (pushCtl.on) return 'Notifications are on for this device.';
  if (IS_IOS && !IS_HOME_SCREEN_APP) return 'On iPhone, notifications need the Home Screen app: tap Share, then Add to Home Screen, and open the inbox from there.';
  if (!('Notification' in window)) return '';
  if (Notification.permission === 'denied') return 'Notifications are blocked in this browser. Allow them in the site settings (the icon left of the address), then reload.';
  return '';
}
function renderNotifyNote() {
  if (!els.meNotify) return;
  const words = notifyWords();
  els.meNotify.textContent = words;
  els.meNotify.hidden = !words;
}

function keyBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

function sameKey(sub, key) {
  const k = sub.options && sub.options.applicationServerKey;
  if (!k) return true;
  const have = btoa(String.fromCharCode(...new Uint8Array(k))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return have === key.replace(/=+$/, '');
}

function saveSub(sub) {
  return api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
}

async function initPush() {
  setBell(false);
  if (!PUSH_OK) return;
  try {
    const { ok, data } = await api('/api/push/key');
    if (!ok || !data.on) return;
    pushCtl.key = data.key;
    pushCtl.reg = await navigator.serviceWorker.register('/static/sw.js', { scope: '/' });
    const sub = await pushCtl.reg.pushManager.getSubscription();
    if (sub && Notification.permission === 'granted') {
      if (sameKey(sub, data.key)) setBell((await saveSub(sub)).ok);
      else await sub.unsubscribe();
    }
    await autoSubscribe();
    if (!pushCtl.on && Notification.permission === 'default') askOnTap();
  } catch (_) {}
  renderNotifyNote();
}

// The browser asks once, on the first tap after sign-in. An iPhone Home Screen
// app only lets a full tap (not a touch down) ask and sign up.
let tapAsk = null;
function askOnTap() {
  if (tapAsk) return;
  tapAsk = async () => {
    els.app.removeEventListener('click', tapAsk, true);
    tapAsk = null;
    if (!pushCtl.reg || pushCtl.on || Notification.permission !== 'default') return;
    try {
      if (await Notification.requestPermission() === 'granted') await subscribeDevice();
    } catch (_) {}
    renderNotifyNote();
  };
  els.app.addEventListener('click', tapAsk, true);
}

// One sign-up at a time: a tap on the bell while the automatic one is still
// running would otherwise make a second subscription and kill the first.
let subscribing = null;
function subscribeDevice() {
  if (!subscribing) {
    subscribing = (async () => {
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription())
        || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(pushCtl.key) });
      const saved = await saveSub(sub);
      if (!saved.ok) {
        await sub.unsubscribe().catch(() => {});
        throw new Error('not saved');
      }
      setBell(true);
    })().finally(() => { subscribing = null; });
  }
  return subscribing;
}

// Once notifications are allowed, the device is signed up without a tap on
// the bell, unless the agent turned the bell off here. So a phone or a closed
// tab gets them the same way an open desktop tab always did.
async function autoSubscribe() {
  if (!pushCtl.reg || !pushCtl.key || pushCtl.on) return;
  if (Notification.permission !== 'granted') return;
  try { await subscribeDevice(); } catch (_) {}
}

async function pushOff() {
  if (!pushCtl.reg) return;
  try {
    const sub = await pushCtl.reg.pushManager.getSubscription();
    if (sub) {
      await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
    }
  } catch (_) {}
  setBell(false);
}


// A tapped notification opens its chat: by message when the inbox is already
// open, by #chat= in the address when it had to be opened.
async function openChatIfKnown(waId) {
  if (!convOf(waId)) await refreshConversations();
  if (convOf(waId)) openConversation(waId);
}

function openChatFromLink() {
  const m = /^#chat=(\d{6,20})$/.exec(location.hash);
  if (!m) return;
  history.replaceState(history.state, '', location.pathname);
  openChatIfKnown(m[1]);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type === 'open-chat' && d.wa_id && !els.app.hidden) openChatIfKnown(String(d.wa_id));
  });
}

function handleAuthLost() {
  stopListPolling();
  stopThreadPolling();
  const note = endedNote;
  endedNote = '';
  if (!note) toast('You were signed out. Sign in again.', true);
  showLogin(note);
}

/* ----------------------- new conversation ----------------------- */

function openNewChatModal() {
  els.newChatError.hidden = true;
  els.newChatNumber.value = '';
  els.newChatName.value = '';
  renderNewChatHint();
  els.newChatModal.hidden = false;
  setTimeout(() => els.newChatNumber.focus(), 50);
}
function closeNewChatModal() { els.newChatModal.hidden = true; }

// Shows which number the typed text becomes, and whether that chat exists.
function renderNewChatHint() {
  const id = toWaId(els.newChatNumber.value);
  const known = id && convOf(id);
  els.newChatHint.textContent = !id ? ''
    : known ? `Opens your chat with ${displayName(known)} (${formatPhone(id)})`
    : `Opens ${formatPhone(id)}`;
}

els.newChatBtn.addEventListener('click', openNewChatModal);
els.newChatCancel.addEventListener('click', closeNewChatModal);
els.newChatNumber.addEventListener('input', renderNewChatHint);
els.newChatModal.addEventListener('click', (e) => {
  if (e.target === els.newChatModal) closeNewChatModal();
});

els.newChatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.newChatError.hidden = true;
  const raw = els.newChatNumber.value;
  const name = els.newChatName.value.trim();
  if (!toWaId(raw)) {
    els.newChatError.textContent = 'Enter a valid number: 010 1234 5678 for Egypt, or + and the country code for other countries.';
    els.newChatError.hidden = false;
    return;
  }
  const { ok, status, data } = await api('/api/start-conversation', {
    method: 'POST',
    body: JSON.stringify({ wa_id: raw, name }),
  });
  if (status === 401) return handleAuthLost();
  if (!ok) {
    els.newChatError.textContent = data.error || 'Could not start the conversation.';
    els.newChatError.hidden = false;
    return;
  }
  closeNewChatModal();
  // make sure it's in our list, then open it
  await refreshConversations();
  if (!convOf(data.wa_id)) {
    const row = {
      wa_id: data.wa_id,
      display_name: data.display_name || null,
      profile_name: null,
      member: null,
      last_message_text: '', last_message_at: new Date().toISOString(),
      last_message_direction: 'out', unread_count: 0,
    };
    state.conversations.unshift(row);
    remember([row]);
    renderConversations(true);
  }
  openConversation(data.wa_id);
  if (name && !data.display_name) toast('Chat opened, but the name was not saved.', true);
});

// Escape closes the modal.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.newChatModal.hidden) closeNewChatModal();
});

/* ----------------------- contact name ----------------------- */

function openRenameModal() {
  const waId = state.activeWaId;
  if (!waId) return;
  const conv = convOf(waId) || {};
  state.renameWaId = waId;
  els.renameError.hidden = true;
  els.renameInput.value = conv.display_name || '';
  els.renameInput.placeholder = (conv.member && conv.member.name) || conv.profile_name || 'Contact name';
  els.renameModal.hidden = false;
  setTimeout(() => { els.renameInput.focus(); els.renameInput.select(); }, 50);
}
function closeRenameModal() {
  els.renameModal.hidden = true;
  state.renameWaId = null;
}

els.threadPeer.addEventListener('click', openPeerSheet);
els.threadAvatar.addEventListener('click', openPeerSheet);
els.peerSheet.addEventListener('click', (e) => {
  const act = e.target.closest('[data-peer]');
  if (act && act.dataset.peer === 'copy') { copyText(`+${String(state.activeWaId || '').replace(/\D/g, '')}`); return; }
  if (act && act.dataset.peer === 'rename') { closePeerSheet(); openRenameModal(); return; }
  if (e.target === els.peerSheet) closePeerSheet();
});
els.renameCancel.addEventListener('click', closeRenameModal);
els.renameModal.addEventListener('click', (e) => {
  if (e.target === els.renameModal) closeRenameModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.renameModal.hidden) closeRenameModal();
});

els.renameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const waId = state.renameWaId;
  if (!waId) return;
  els.renameError.hidden = true;
  els.renameSubmit.disabled = true;
  const { ok, status, data } = await api(`/api/conversations/${encodeURIComponent(waId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: els.renameInput.value }),
  });
  els.renameSubmit.disabled = false;
  if (status === 401) return handleAuthLost();
  if (!ok) {
    els.renameError.textContent = data.error || 'Could not save the name.';
    els.renameError.hidden = false;
    return;
  }
  const conv = convOf(waId);
  if (conv) conv.display_name = data.display_name || null;
  closeRenameModal();
  renderConversations(true);
  renderThreadHeader();
  toast(data.display_name ? 'Name saved.' : 'Saved name removed.');
});

/* ----------------------- forward message ----------------------- */

// Open the destination picker for a message. Media must be stored to forward;
// if it isn't, say why. The thread API never sends media_path, so media_status
// is the signal here and /api/forward re-checks the stored path.
const NOT_FORWARDABLE = {
  pending: 'This media is still downloading. Try again in a moment.',
  failed: 'This media couldn’t be downloaded from WhatsApp, so it can’t be forwarded.',
  expired: 'This media is past the storage window and was deleted, so it can’t be forwarded.',
};
function openForwardModal(m) {
  if (!isTextLike(m) && m.media_status !== 'stored') {
    toast(NOT_FORWARDABLE[m.media_status] || (m.type === 'contacts' ? 'A contact card can’t be forwarded from here.' : 'This message has no stored media to forward.'), true);
    return;
  }
  state.forward = { msgId: m.id, srcWaId: m.wa_id || state.activeWaId, selected: new Set(), search: '' };
  els.forwardError.hidden = true;
  els.forwardSearch.value = '';
  els.forwardModal.hidden = false;
  renderForwardList();
  loadForwardRows();
  updateForwardSubmit();
  setTimeout(() => els.forwardSearch.focus(), 50);
}
function closeForwardModal() {
  els.forwardModal.hidden = true;
  state.forward = null;
}

function renderForwardList() {
  const f = state.forward;
  if (!f) return;
  // All existing conversations except the source chat (forwarding to itself is
  // pointless). New numbers are handled by the existing New-conversation flow.
  const list = (f.rows || state.conversations).filter((c) => c.wa_id !== f.srcWaId);
  els.forwardEmpty.hidden = list.length > 0;
  els.forwardList.innerHTML = list.map((c) => {
    const sel = f.selected.has(c.wa_id) ? ' selected' : '';
    const sub = [knownName(c) ? formatPhone(c.wa_id) : '', memberTag(c.member)].filter(Boolean).join(', ');
    return `
      <button type="button" class="forward-opt${sel}" data-wa="${escapeHtml(c.wa_id)}">
        ${avatarHtml(c)}
        <span class="fo-who"><span class="fo-name"><bdi>${escapeHtml(displayName(c))}</bdi></span>${sub ? `<span class="fo-sub">${escapeHtml(sub)}</span>` : ''}</span>
        <span class="fo-check">${f.selected.has(c.wa_id) ? '✓' : ''}</span>
      </button>`;
  }).join('');
}

// The picker searches the server too, so a chat far down the list is found.
let forwardTimer = null;
async function loadForwardRows() {
  const f = state.forward;
  if (!f) return;
  const params = new URLSearchParams({ view: 'chats', limit: '80' });
  if ((f.search || '').trim()) params.set('q', f.search.trim());
  const { ok, data } = await api(`/api/conversations?${params}`);
  if (!ok || state.forward !== f) return;
  f.rows = data.conversations || [];
  remember(f.rows);
  renderForwardList();
}

function updateForwardSubmit() {
  const f = state.forward;
  const n = f ? f.selected.size : 0;
  els.forwardSubmit.disabled = n === 0;
  els.forwardSubmit.textContent = n > 1 ? `Forward (${n})` : 'Forward';
}

els.forwardList.addEventListener('click', (e) => {
  const opt = e.target.closest('.forward-opt');
  if (!opt || !state.forward) return;
  const wa = opt.dataset.wa;
  if (state.forward.selected.has(wa)) state.forward.selected.delete(wa);
  else state.forward.selected.add(wa);
  renderForwardList();
  updateForwardSubmit();
});

els.forwardSearch.addEventListener('input', () => {
  if (!state.forward) return;
  state.forward.search = els.forwardSearch.value;
  clearTimeout(forwardTimer);
  forwardTimer = setTimeout(loadForwardRows, 250);
});

els.forwardCancel.addEventListener('click', closeForwardModal);
els.forwardModal.addEventListener('click', (e) => {
  if (e.target === els.forwardModal) closeForwardModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.forwardModal.hidden) { e.stopImmediatePropagation(); closeForwardModal(); }
});

els.forwardSubmit.addEventListener('click', async () => {
  const f = state.forward;
  if (!f || !f.selected.size) return;
  const dests = [...f.selected];
  els.forwardError.hidden = true;
  els.forwardSubmit.disabled = true;
  els.forwardSubmit.textContent = 'Forwarding…';

  const { ok, status, data } = await api('/api/forward', {
    method: 'POST', body: JSON.stringify({ message_id: f.msgId, wa_ids: dests }),
  });
  if (status === 401) return handleAuthLost();

  if (!ok) {
    els.forwardError.textContent = (data && data.error) || 'Could not forward the message.';
    els.forwardError.hidden = false;
    updateForwardSubmit();
    return;
  }

  // Add an optimistic forwarded bubble to each destination thread (so a chat the
  // agent later opens shows it instantly; the ?since= poll reconciles with the
  // persisted row). Bump each destination's list preview so it rises.
  const results = (data && data.results) || [];
  for (const r of results) {
    if (!r.ok || !r.message) continue;
    const t = thread(r.wa_id);
    // Seed the persisted row directly into the cached thread.
    if (!t.byId.has(r.message.id)) {
      t.byId.set(r.message.id, r.message);
      t.order.push(r.message.id);
      mergeMessages(t, []);
    }
    bumpConversationPreview(r.wa_id, r.message.body || '', 'out');
  }

  const sent = (data && data.sent) || 0;
  const total = (data && data.total) || dests.length;
  closeForwardModal();
  if (sent === total) {
    toast(`Forwarded to ${sent} chat${sent === 1 ? '' : 's'}.`);
  } else if (sent > 0) {
    toast(`Forwarded to ${sent} of ${total} chats — some couldn’t be sent.`, true);
  } else {
    toast('Could not forward — likely outside the 24-hour window.', true);
  }
  // If the agent is currently viewing one of the destinations, refresh it.
  if (state.activeWaId && dests.includes(state.activeWaId)) renderMessages();
});

/* ----------------------- follow-up template ----------------------- */
// The one template an agent can send (the server enforces the same list). Its
// only job is to earn a reply, which reopens the 24-hour window. Bodies mirror
// the copy Meta approved, so the preview is what the customer actually gets.
const FOLLOWUP_TEMPLATE = 'ops_support_followup';
const FOLLOWUP_BODY = {
  en: (name, program) =>
    `Hi ${name}, this is the Byte+ support team following up on your ${program} program.\n` +
    `If you have an open question, or something isn't working for you, reply to this message and we'll pick it up from here.`,
  ar: (name, program) =>
    `أهلاً ${name}، فريق دعم Byte+ بيتابع معاك بخصوص برنامج ${program}.\n` +
    `لو عندك أي سؤال، أو في حاجة مش شغالة معاك، رد على الرسالة دي وهنكمل معاك من هنا.`,
};

// The same agent works the same few companies all day, so the program sticks.
const PROGRAM_KEY = 'wa_followup_program';
function loadProgram() { try { return localStorage.getItem(PROGRAM_KEY) || ''; } catch (_) { return ''; } }
function saveProgram(v) { try { localStorage.setItem(PROGRAM_KEY, v); } catch (_) {} }

function openFollowupModal() {
  if (!state.activeWaId) return;
  const conv = convOf(state.activeWaId);
  const first = (conv ? knownName(conv) : '').split(/\s+/)[0] || '';
  els.followupName.value = first;
  els.followupProgram.value = (conv && conv.member && conv.member.company) || loadProgram();
  els.followupError.hidden = true;
  state.followupLang = 'ar';
  renderFollowupLang();
  els.followupModal.hidden = false;
  setTimeout(() => (first ? els.followupProgram : els.followupName).focus(), 50);
}
function closeFollowupModal() { els.followupModal.hidden = true; }

function renderFollowupLang() {
  els.followupLangs.querySelectorAll('.filter-chip').forEach((chip) => {
    const on = chip.dataset.lang === state.followupLang;
    chip.classList.toggle('active', on);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  renderFollowupPreview();
}

function renderFollowupPreview() {
  const name = els.followupName.value.trim() || '…';
  const program = els.followupProgram.value.trim() || '…';
  els.followupPreview.textContent = FOLLOWUP_BODY[state.followupLang](name, program);
  els.followupPreview.dir = state.followupLang === 'ar' ? 'rtl' : 'ltr';
}

els.followupBtn.addEventListener('click', openFollowupModal);
els.followupCancel.addEventListener('click', closeFollowupModal);
els.followupModal.addEventListener('click', (e) => {
  if (e.target === els.followupModal) closeFollowupModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.followupModal.hidden) closeFollowupModal();
});
els.followupLangs.addEventListener('click', (e) => {
  const chip = e.target.closest('.filter-chip');
  if (!chip) return;
  state.followupLang = chip.dataset.lang;
  renderFollowupLang();
});
els.followupName.addEventListener('input', renderFollowupPreview);
els.followupProgram.addEventListener('input', renderFollowupPreview);

els.followupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const waId = state.activeWaId;
  const name = els.followupName.value.trim();
  const program = els.followupProgram.value.trim();
  if (!waId || !name || !program) {
    els.followupError.textContent = 'Fill in the name and the program.';
    els.followupError.hidden = false;
    return;
  }
  els.followupError.hidden = true;
  els.followupSubmit.disabled = true;
  els.followupSubmit.textContent = 'Sending…';

  const { ok, status, data } = await api('/api/send-template', {
    method: 'POST',
    headers: { 'x-idempotency-key': newSendKey() },
    body: JSON.stringify({
      wa_id: waId, template: FOLLOWUP_TEMPLATE, language: state.followupLang, params: [name, program],
    }),
  });
  els.followupSubmit.disabled = false;
  els.followupSubmit.textContent = 'Send';
  if (status === 401) return handleAuthLost();
  if (!ok) {
    els.followupError.textContent = data.error || 'Could not send the template.';
    els.followupError.hidden = false;
    return;
  }

  saveProgram(program);
  closeFollowupModal();
  clearBanner();
  toast('Follow-up template sent.');
  loadThread(false); // pull the persisted row now instead of waiting for the poll
});

/* ----------------------------- start ----------------------------- */
boot();

/* ----------------------- media viewer ----------------------- */

function isPdf(m) {
  const meta = m.media_meta || {};
  return meta.mime_type === 'application/pdf' || /\.pdf$/i.test(meta.filename || '');
}

function isViewable(m) {
  const stored = m.media_status === 'stored' || Boolean(m._localUrl);
  if (!stored) return false;
  return ['image', 'sticker', 'video'].includes(m.type) || (m.type === 'document' && isPdf(m));
}

const viewer = {
  el: $('#viewer'), stage: $('#viewer-stage'), strip: $('#viewer-strip'),
  name: $('#viewer-name'), when: $('#viewer-when'), count: $('#viewer-count'),
  caption: $('#viewer-caption'), download: $('#viewer-download'),
  share: $('#viewer-share'), full: $('#viewer-full'),
  prev: $('#viewer-prev'), next: $('#viewer-next'),
  items: [], index: 0, returnFocus: null, touchX: null,
};

function mediaSrc(m) {
  return m._localUrl || `/api/media/${m.id}`;
}
function posterSrc(m) {
  return `/api/media/${m.id}?poster=1`;
}

// The phone's status bar takes the colour of what sits under it.
const APP_COLOR = '#fbf8f2';
const VIEWER_COLOR = '#0e1412';
const themeMeta = document.querySelector('meta[name="theme-color"]');
function setThemeColor(color) {
  if (themeMeta) themeMeta.setAttribute('content', color);
}

function openViewer(msgId) {
  if (!state.activeWaId) return;
  const t = thread(state.activeWaId);
  viewer.items = t.order.map((id) => t.byId.get(id)).filter((m) => m && isViewable(m));
  const index = viewer.items.findIndex((m) => m.id === msgId);
  if (index < 0) return;
  viewer.returnFocus = document.activeElement;
  viewer.strip.innerHTML = viewer.items.map((m, i) => {
    const thumb = m.type === 'image' || m.type === 'sticker'
      ? `<img src="${mediaSrc(m)}" alt="" loading="lazy" draggable="false" />`
      : m.type === 'video' && !m._localUrl
        ? `<img src="${posterSrc(m)}" alt="" loading="lazy" draggable="false" onerror="this.replaceWith(Object.assign(document.createElement('span'), { className: 'thumb-ico', textContent: '🎬' }))" /><span class="thumb-play" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="7 4 20 12 7 20 7 4"/></svg></span>`
        : `<span class="thumb-ico">${m.type === 'video' ? '🎬' : '📄'}</span>`;
    return `<button type="button" class="viewer-thumb" data-i="${i}" aria-label="Item ${i + 1}">${thumb}</button>`;
  }).join('');
  viewer.strip.hidden = viewer.items.length < 2;
  viewer.el.hidden = false;
  document.body.classList.add('viewer-open');
  setThemeColor(VIEWER_COLOR);
  showViewerItem(index);
  $('#viewer-close').focus();
}

function closeViewer() {
  if (viewer.el.hidden) return;
  stopViewerVideo();
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  viewer.el.hidden = true;
  endViewerDrag();
  viewer.stage.innerHTML = '';
  viewer.strip.innerHTML = '';
  document.body.classList.remove('viewer-open');
  setThemeColor(APP_COLOR);
  if (viewer.returnFocus && viewer.returnFocus.focus) viewer.returnFocus.focus();
}

function showViewerItem(index) {
  const items = viewer.items;
  if (index < 0 || index >= items.length) return;
  viewer.index = index;
  const m = items[index];
  const src = mediaSrc(m);
  const meta = m.media_meta || {};
  const conv = convOf(state.activeWaId) || { wa_id: state.activeWaId };
  const iso = m.wa_timestamp || m.created_at;
  const d = iso ? new Date(iso) : null;

  viewer.name.textContent = m.direction === 'out' ? 'You' : displayName(conv);
  viewer.when.textContent = d && !isNaN(d)
    ? `${d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })} at ${fmtTime(iso)}`
    : '';
  viewer.count.textContent = items.length > 1 ? `${index + 1} / ${items.length}` : '';
  viewer.download.href = src;
  viewer.download.setAttribute('download', saveName(m));

  stopViewerVideo();
  viewer.share.hidden = !canShareFiles();
  if (!viewer.share.hidden) prepareShare(m);
  viewer.full.hidden = !(m.type === 'video' && fullScreenWorks());
  if (m.type === 'video') {
    const play = m._localUrl || `/api/media/${m.id}?inline=1`;
    viewer.stage.innerHTML = videoViewerHtml(m, play);
    setupVideoViewer(viewer.stage.querySelector('.vv'));
  } else if (m.type === 'document') {
    const inline = m._localUrl || `/api/media/${m.id}?inline=1`;
    viewer.stage.innerHTML = `<iframe class="viewer-pdf" src="${inline}" title="${escapeHtml(meta.filename || 'Document')}"></iframe>`;
  } else {
    viewer.stage.innerHTML = `<img class="viewer-media viewer-img" src="${src}" alt="${escapeHtml(labelForType(m.type))}" draggable="false" />`;
  }
  viewer.stage.classList.remove('zoomed');
  resetPinch();

  const caption = meta.caption || (m.type === 'document' ? meta.filename : '');
  viewer.caption.textContent = caption || '';
  viewer.caption.hidden = !caption;

  viewer.prev.hidden = index === 0;
  viewer.next.hidden = index === items.length - 1;
  viewer.strip.querySelectorAll('.viewer-thumb').forEach((b, i) => {
    b.classList.toggle('active', i === index);
    if (i === index) b.scrollIntoView({ block: 'nearest', inline: 'center' });
  });

  // Warm the neighbours so arrowing through photos feels instant.
  [items[index - 1], items[index + 1]].forEach((n) => {
    if (n && (n.type === 'image' || n.type === 'sticker')) new Image().src = mediaSrc(n);
  });
}

viewer.stage.addEventListener('click', (e) => {
  if (e.target === viewer.stage) closeViewer();
});
viewer.el.querySelector('.viewer-main').addEventListener('click', (e) => {
  if (e.target.classList.contains('viewer-main')) closeViewer();
});
viewer.prev.addEventListener('click', () => showViewerItem(viewer.index - 1));
viewer.next.addEventListener('click', () => showViewerItem(viewer.index + 1));
$('#viewer-close').addEventListener('click', closeViewer);
$('#viewer-forward').addEventListener('click', (e) => {
  e.stopPropagation();
  const m = viewer.items[viewer.index];
  if (!m) return;
  const v = viewer.stage.querySelector('video');
  if (v && !v.paused) v.pause();
  openForwardModal(m);
});
viewer.strip.addEventListener('click', (e) => {
  const b = e.target.closest('.viewer-thumb');
  if (b) showViewerItem(Number(b.dataset.i));
});
// A photo or video follows the finger down and closes when let go far enough
// or flicked; sideways still moves to the next one.
const viewerDrag = { on: false, axis: null, x0: 0, y0: 0, dy: 0, t0: 0 };
const DISMISS_AT = 110;
function endViewerDrag() {
  viewerDrag.on = false;
  viewerDrag.axis = null;
  viewer.el.classList.remove('dragging');
  viewer.el.style.removeProperty('--drag');
  viewer.el.style.removeProperty('--fade');
}
viewer.stage.addEventListener('touchstart', (e) => {
  const one = e.touches.length === 1 && !viewer.stage.classList.contains('zoomed') && pinch.scale <= 1.01
    && !e.target.closest('.vv-bar, .vv-error');
  viewer.touchX = one ? e.touches[0].clientX : null;
  endViewerDrag();
  if (!one || !viewer.stage.querySelector('.viewer-media')) return;
  Object.assign(viewerDrag, { on: true, x0: e.touches[0].clientX, y0: e.touches[0].clientY, dy: 0, t0: performance.now() });
}, { passive: true });
viewer.stage.addEventListener('touchmove', (e) => {
  const d = viewerDrag;
  if (!d.on) return;
  if (e.touches.length !== 1) { endViewerDrag(); viewer.touchX = null; return; }
  const dx = e.touches[0].clientX - d.x0;
  const dy = e.touches[0].clientY - d.y0;
  if (!d.axis) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
    d.axis = dy > 0 && Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
    if (d.axis === 'y') viewer.el.classList.add('dragging');
  }
  if (d.axis !== 'y') return;
  if (e.cancelable) e.preventDefault();
  d.dy = Math.max(0, dy);
  viewer.el.style.setProperty('--drag', `${d.dy}px`);
  viewer.el.style.setProperty('--fade', String(Math.max(0.2, 1 - d.dy / 380)));
}, { passive: false });
for (const type of ['touchend', 'touchcancel']) {
  viewer.stage.addEventListener(type, (e) => {
    const d = viewerDrag;
    if (d.on && d.axis === 'y') {
      const flick = d.dy > 36 && d.dy / Math.max(1, performance.now() - d.t0) > 0.55;
      const close = type === 'touchend' && (d.dy >= DISMISS_AT || flick);
      viewer.touchX = null;
      endViewerDrag();
      if (e.cancelable) e.preventDefault();
      if (close) closeViewer();
      return;
    }
    endViewerDrag();
    if (type !== 'touchend' || viewer.touchX == null) { viewer.touchX = null; return; }
    const dx = e.changedTouches[0].clientX - viewer.touchX;
    viewer.touchX = null;
    if (Math.abs(dx) > 50) showViewerItem(viewer.index + (dx < 0 ? 1 : -1));
  });
}
/* ----------------------- the viewer: video, photo, save, share ----------------------- */

const ICO_SOUND = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg>';
const ICO_MUTED = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>';

function saveName(m) {
  const meta = m.media_meta || {};
  if (meta.filename) return meta.filename;
  const ext = { image: 'jpg', sticker: 'webp', video: 'mp4', document: 'pdf' }[m.type] || 'bin';
  const iso = m.wa_timestamp || m.created_at || '';
  const day = iso ? String(iso).slice(0, 10) : 'file';
  return `whatsapp-${m.type}-${day}-${m.id}.${ext}`;
}

function canShareFiles() {
  try {
    return Boolean(navigator.canShare && navigator.share && navigator.canShare({ files: [new File([''], 'a.jpg', { type: 'image/jpeg' })] }));
  } catch (_) { return false; }
}
function fullScreenWorks() {
  return Boolean(document.fullscreenEnabled && Element.prototype.requestFullscreen);
}

// The share sheet only opens inside the tap itself, so the file is fetched as
// soon as the item shows and the tap shares it at once.
const shareFiles = new Map();
const SHARE_MAX_BYTES = 30 * 1024 * 1024;
function shareType(m, blob) {
  const meta = m.media_meta || {};
  const given = String(meta.mime_type || '').split(';')[0].trim();
  if (given && given !== 'application/octet-stream') return given;
  const fromBlob = String(blob.type || '').split(';')[0].trim();
  if (fromBlob && !/octet-stream/.test(fromBlob)) return fromBlob;
  return { image: 'image/jpeg', sticker: 'image/webp', video: 'video/mp4', document: 'application/pdf' }[m.type] || 'application/octet-stream';
}
function prepareShare(m) {
  if (!m || !canShareFiles() || shareFiles.has(m.id)) return shareFiles.get(m && m.id);
  const own = m._localUrl ? m._localUrl : `/api/media/${m.id}?bytes=1`;
  const job = fetch(own, { credentials: 'same-origin' })
    .then((resp) => (resp.ok ? resp.blob() : null))
    .then((blob) => {
      if (!blob || blob.size > SHARE_MAX_BYTES) return null;
      const file = new File([blob], saveName(m), { type: shareType(m, blob) });
      job.file = file;
      return file;
    })
    .catch(() => null);
  shareFiles.set(m.id, job);
  if (shareFiles.size > 6) shareFiles.delete(shareFiles.keys().next().value);
  return job;
}
function shareCurrent() {
  const m = viewer.items[viewer.index];
  if (!m) return;
  const job = prepareShare(m);
  const file = job && job.file;
  if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file] }).catch((e) => {
      if (!e || e.name !== 'AbortError') toast('Could not open the share sheet. Use Save instead.', true);
    });
    return;
  }
  if (job && !file) {
    toast('Getting the file ready, tap Share again in a moment.');
    job.then((f) => { if (!f) toast('This file cannot be shared from here. Use Save instead.', true); });
    return;
  }
  toast('This file cannot be shared from here. Use Save instead.', true);
}
viewer.share.addEventListener('click', (e) => { e.stopPropagation(); shareCurrent(); });
viewer.full.addEventListener('click', (e) => {
  e.stopPropagation();
  if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
  const box = viewer.stage.querySelector('.vv') || viewer.el;
  box.requestFullscreen().catch(() => {});
});
viewer.el.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('input, textarea')) e.preventDefault();
});

function videoViewerHtml(m, src) {
  const meta = m.media_meta || {};
  const poster = m._localUrl ? '' : ` poster="${posterSrc(m)}"`;
  const total = Number(meta.duration) > 0 ? fmtClock(Number(meta.duration)) : '0:00';
  return `<div class="vv" data-state="idle" data-ui="on">`
    + `<video class="viewer-media vv-video" playsinline webkit-playsinline preload="metadata"${poster} src="${src}"`
    + ` disablepictureinpicture disableremoteplayback x-webkit-airplay="deny" controlslist="nodownload noplaybackrate noremoteplayback nofullscreen"></video>`
    + `<button type="button" class="vv-big" aria-label="Play">${ICO_PLAY}</button>`
    + '<div class="vv-bar" dir="ltr">'
    + `<button type="button" class="vv-play" aria-label="Play">${ICO_PLAY}</button>`
    + '<span class="vv-time vv-now">0:00</span>'
    + '<input class="vv-seek" type="range" min="0" max="1000" step="1" value="0" aria-label="Position" />'
    + `<span class="vv-time vv-total">${total}</span>`
    + `<button type="button" class="vp-speed vv-speed" aria-label="Playback speed">${speedLabel(player.speed)}</button>`
    + `<button type="button" class="vv-mute" aria-label="Mute">${ICO_SOUND}</button>`
    + '</div>'
    + `<div class="vv-error" hidden><span>Could not play it here.</span><a class="vv-open" href="${src}" target="_blank" rel="noopener">Open with the phone's player</a></div>`
    + '</div>';
}

let viewerVideo = null;
function stopViewerVideo() {
  if (!viewerVideo) return;
  const v = viewerVideo;
  viewerVideo = null;
  clearTimeout(v._hide);
  try { v.pause(); } catch (_) {}
}

function setupVideoViewer(root) {
  if (!root) return;
  const video = root.querySelector('video');
  const big = root.querySelector('.vv-big');
  const btn = root.querySelector('.vv-play');
  const seek = root.querySelector('.vv-seek');
  const now = root.querySelector('.vv-now');
  const total = root.querySelector('.vv-total');
  const mute = root.querySelector('.vv-mute');
  const err = root.querySelector('.vv-error');
  let seeking = false;
  viewerVideo = video;
  video.playbackRate = player.speed;

  const length = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0);
  const showUi = (on) => {
    root.dataset.ui = on ? 'on' : 'off';
    clearTimeout(video._hide);
    if (on && !video.paused) video._hide = setTimeout(() => { if (!video.paused && !seeking) root.dataset.ui = 'off'; }, 2600);
  };
  const paint = () => {
    const d = length();
    if (d) total.textContent = fmtClock(d);
    now.textContent = fmtClock(video.currentTime || 0);
    if (!seeking && d) seek.value = String(Math.round((video.currentTime / d) * 1000));
    seek.style.setProperty('--done', `${d ? (video.currentTime / d) * 100 : 0}%`);
  };
  const setState = (st) => {
    root.dataset.state = st;
    const playing = st === 'playing' || st === 'loading';
    btn.innerHTML = playing ? ICO_PAUSE : ICO_PLAY;
    btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    big.hidden = playing || st === 'error';
    err.hidden = st !== 'error';
  };
  const toggle = () => {
    if (root.dataset.state === 'error') return;
    if (video.paused) {
      video.playbackRate = player.speed;
      const p = video.play();
      if (p && p.catch) p.catch((e) => { if (!e || e.name !== 'AbortError') setState('error'); });
    } else {
      video.pause();
    }
  };

  video.addEventListener('loadedmetadata', () => { video.playbackRate = player.speed; paint(); });
  video.addEventListener('timeupdate', paint);
  video.addEventListener('durationchange', paint);
  video.addEventListener('waiting', () => setState('loading'));
  video.addEventListener('playing', () => { setState('playing'); showUi(true); });
  video.addEventListener('play', () => { setState('playing'); showUi(true); });
  video.addEventListener('pause', () => { setState('paused'); showUi(true); });
  video.addEventListener('ended', () => { setState('paused'); showUi(true); });
  video.addEventListener('volumechange', () => {
    mute.innerHTML = video.muted ? ICO_MUTED : ICO_SOUND;
    mute.setAttribute('aria-label', video.muted ? 'Sound on' : 'Mute');
  });
  video.addEventListener('error', () => setState('error'));
  video.addEventListener('contextmenu', (e) => e.preventDefault());

  big.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); showUi(true); });
  mute.addEventListener('click', (e) => { e.stopPropagation(); video.muted = !video.muted; showUi(true); });
  root.querySelector('.vv-speed').addEventListener('click', (e) => { e.stopPropagation(); setSpeed(nextSpeed()); showUi(true); });
  video.addEventListener('click', (e) => {
    e.stopPropagation();
    showUi(root.dataset.ui !== 'on');
  });
  seek.addEventListener('pointerdown', () => { seeking = true; showUi(true); });
  seek.addEventListener('input', () => {
    seeking = true;
    const d = length();
    if (!d) return;
    const at = (Number(seek.value) / 1000) * d;
    now.textContent = fmtClock(at);
    seek.style.setProperty('--done', `${(at / d) * 100}%`);
    if (typeof video.fastSeek === 'function') video.fastSeek(at); else video.currentTime = at;
  });
  seek.addEventListener('change', () => { seeking = false; showUi(true); });
  for (const t of ['pointerup', 'pointercancel', 'touchend']) seek.addEventListener(t, () => { seeking = false; });
  root.querySelector('.vv-bar').addEventListener('click', (e) => e.stopPropagation());

  setState('idle');
  const first = video.play();
  if (first && first.catch) first.catch((e) => { if (e && e.name === 'NotAllowedError') setState('paused'); else if (!e || e.name !== 'AbortError') setState('error'); });
}

// A photo pinches and pans inside the viewer; the page itself never zooms.
const pinch = { scale: 1, x: 0, y: 0, d0: 0, s0: 1, cx: 0, cy: 0, px: 0, py: 0, panning: false, lastTap: 0 };
function applyPinch() {
  const img = viewer.stage.querySelector('.viewer-img');
  if (!img) return;
  img.style.transform = pinch.scale > 1.01 ? `translate(${pinch.x}px, ${pinch.y}px) scale(${pinch.scale})` : '';
  viewer.stage.classList.toggle('pinched', pinch.scale > 1.01);
}
function resetPinch() {
  Object.assign(pinch, { scale: 1, x: 0, y: 0, d0: 0, panning: false });
  applyPinch();
}
const touchGap = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
viewer.stage.addEventListener('touchstart', (e) => {
  if (!e.target.classList || !e.target.classList.contains('viewer-img')) return;
  if (e.touches.length === 2) {
    pinch.d0 = touchGap(e.touches);
    pinch.s0 = pinch.scale;
    pinch.panning = false;
  } else if (e.touches.length === 1 && pinch.scale > 1.01) {
    pinch.panning = true;
    pinch.px = e.touches[0].clientX - pinch.x;
    pinch.py = e.touches[0].clientY - pinch.y;
  }
}, { passive: true });
viewer.stage.addEventListener('touchmove', (e) => {
  if (!e.target.classList || !e.target.classList.contains('viewer-img')) return;
  if (e.touches.length === 2 && pinch.d0) {
    if (e.cancelable) e.preventDefault();
    pinch.scale = Math.min(4, Math.max(1, pinch.s0 * (touchGap(e.touches) / pinch.d0)));
    if (pinch.scale <= 1.01) { pinch.x = 0; pinch.y = 0; }
    applyPinch();
  } else if (e.touches.length === 1 && pinch.panning) {
    if (e.cancelable) e.preventDefault();
    pinch.x = e.touches[0].clientX - pinch.px;
    pinch.y = e.touches[0].clientY - pinch.py;
    applyPinch();
  }
}, { passive: false });
viewer.stage.addEventListener('touchend', (e) => {
  if (!e.target.classList || !e.target.classList.contains('viewer-img')) return;
  if (e.touches.length < 2) pinch.d0 = 0;
  if (!e.touches.length) pinch.panning = false;
  if (e.touches.length || e.changedTouches.length !== 1) return;
  const t = Date.now();
  if (t - pinch.lastTap < 300) {
    pinch.lastTap = 0;
    if (pinch.scale > 1.01) resetPinch();
    else {
      const r = e.target.getBoundingClientRect();
      const c = e.changedTouches[0];
      pinch.scale = 2.5;
      pinch.x = (r.left + r.width / 2 - c.clientX) * 1.5;
      pinch.y = (r.top + r.height / 2 - c.clientY) * 1.5;
      applyPinch();
    }
  } else {
    pinch.lastTap = t;
  }
}, { passive: true });
viewer.stage.addEventListener('dblclick', (e) => {
  if (!e.target.classList || !e.target.classList.contains('viewer-img')) return;
  if (pinch.scale > 1.01) { resetPinch(); return; }
  const r = e.target.getBoundingClientRect();
  pinch.scale = 2.5;
  pinch.x = (r.left + r.width / 2 - e.clientX) * 1.5;
  pinch.y = (r.top + r.height / 2 - e.clientY) * 1.5;
  applyPinch();
});
viewer.stage.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !e.target.classList || !e.target.classList.contains('viewer-img')) return;
  e.preventDefault();
  pinch.scale = Math.min(4, Math.max(1, pinch.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
  if (pinch.scale <= 1.01) { pinch.x = 0; pinch.y = 0; }
  applyPinch();
}, { passive: false });

// The page never zooms: no pinch, no double tap, nothing on iPhone either.
document.addEventListener('gesturestart', (e) => { e.preventDefault(); }, { passive: false });
document.addEventListener('gesturechange', (e) => { e.preventDefault(); }, { passive: false });
// While the message menu is open nothing behind it moves, including the chat
// under a finger still down from the long press. Only a menu too tall for the
// screen scrolls, under a finger that started on it.
document.addEventListener('touchmove', (e) => {
  if (!e.cancelable) return;
  if (e.touches.length > 1 && !(e.target.classList && e.target.classList.contains('viewer-img'))) { e.preventDefault(); return; }
  if (!els.sheet.hidden && !(els.sheet.classList.contains('menu-scroll') && els.sheet.contains(e.target))) e.preventDefault();
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if (viewer.el.hidden || !els.forwardModal.hidden) return;
  if (e.key === 'Escape') closeViewer();
  else if (e.key === 'ArrowLeft') showViewerItem(viewer.index - 1);
  else if (e.key === 'ArrowRight') showViewerItem(viewer.index + 1);
});

/* ----------------------- who is signed in ----------------------- */

function renderAgent() {
  if (!els.meBtn) return;
  const img = agentImage
    ? `<img src="${escapeHtml(agentImage.url)}" alt="" decoding="async" referrerpolicy="no-referrer"${agentImage.backgroundColor ? ` style="background:${escapeHtml(agentImage.backgroundColor)}"` : ''} />`
    : '';
  els.meInitials.innerHTML = `${escapeHtml(initials(agentName, ''))}${img}`;
  els.meBtn.classList.toggle('has-photo', Boolean(img));
  els.meBtn.title = agentName ? `${agentName}: menu` : 'Menu';
  els.meName.textContent = agentName || 'Signed in';
  els.meEmail.textContent = agentEmail || '';
  els.meEmail.hidden = !agentEmail;
}

function openMeMenu() {
  renderNotifyNote();
  els.meMenu.hidden = false;
  els.meBtn.setAttribute('aria-expanded', 'true');
}
function closeMeMenu() {
  if (els.meMenu.hidden) return;
  els.meMenu.hidden = true;
  els.meBtn.setAttribute('aria-expanded', 'false');
}
els.meBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (els.meMenu.hidden) openMeMenu(); else closeMeMenu();
});
document.addEventListener('click', (e) => {
  if (!els.meMenu.hidden && !els.meMenu.contains(e.target) && e.target !== els.meBtn) closeMeMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMeMenu(); });
els.meMenu.addEventListener('click', (e) => { if (e.target.closest('.me-item')) closeMeMenu(); });
els.meReplies.addEventListener('click', () => openRepliesModal());

/* ----------------------- the 24-hour window ----------------------- */

// WhatsApp lets a free message through only within 24 hours of the member's
// last one, judged on the server's clock. Once it is over the composer gives
// way to one row that sends a template; the member's reply brings it back.
const WINDOW_MS = 24 * 60 * 60 * 1000;
const WINDOW_SOON_MS = 2 * 60 * 60 * 1000;

function windowState(waId) {
  const t = thread(waId);
  if (!t.loaded) return null;
  let last = t.lastInboundAt ? Date.parse(t.lastInboundAt) : 0;
  for (const m of t.byId.values()) {
    if (m.direction === 'in') last = Math.max(last, Date.parse(m.wa_timestamp || m.created_at) || 0);
  }
  if (!last) return { open: false, never: true };
  const left = last + WINDOW_MS - (Date.now() + (state.clockSkew || 0));
  return { open: left > 0, left, until: last + WINDOW_MS };
}

function windowWords(w) {
  if (!w) return '';
  if (w.never) return 'They have not written to this number yet. Only a template can be sent.';
  if (!w.open) return 'The 24 hours are over. Only a template can be sent.';
  if (w.left > WINDOW_SOON_MS) return '';
  const mins = Math.max(1, Math.round(w.left / 60000));
  const left = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
  return `You can write freely until ${fmtTime(new Date(w.until).toISOString())} (${left} left). After that only a template goes through.`;
}

// False only when the chat is known to be outside the window.
function canWriteFreely(waId = state.activeWaId) {
  const w = waId ? windowState(waId) : null;
  return !(w && !w.open);
}

function renderWindow() {
  if (!state.activeWaId) return;
  const w = windowState(state.activeWaId);
  const closed = Boolean(w && !w.open);
  const words = windowWords(w);
  els.windowBar.hidden = !words;
  els.windowText.textContent = words;
  els.windowBar.classList.toggle('is-closed', closed);
  els.windowAction.hidden = !closed;
  if (closed === els.composer.classList.contains('is-locked')) return;
  els.composer.classList.toggle('is-locked', closed);
  els.composerForm.hidden = closed;
  if (closed) {
    if (typeof closeReplyPicker === 'function') closeReplyPicker();
    clearBanner();
    if (document.activeElement === els.composerInput) els.composerInput.blur();
  } else {
    autoGrow();
  }
}
els.windowAction.addEventListener('click', () => openFollowupModal());
setInterval(() => { if (!els.thread.hidden) renderWindow(); }, 15000);

els.doneBtn.addEventListener('click', () => {
  if (!state.activeWaId) return;
  setConversationRead(state.activeWaId, true);
  els.doneBtn.hidden = true;
  toast('Marked done. It comes back when they write again.');
});

/* ----------------------- saved replies ----------------------- */

const picker = { open: false, slash: false, index: 0, shown: [] };
const repliesEdit = { id: null };

async function loadSavedReplies() {
  const { ok, data } = await api('/api/saved-replies');
  if (!ok) return;
  state.savedRepliesOn = Boolean(data.on);
  state.savedReplies = data.replies || [];
  els.repliesBtn.hidden = !state.savedRepliesOn;
  if (picker.open) renderReplyPicker();
  if (!els.repliesModal.hidden) renderRepliesList();
}

function renderReplyPicker() {
  const q = picker.slash ? els.composerInput.value.slice(1).trim().toLowerCase() : '';
  picker.shown = state.savedReplies.filter((r) => !q || r.title.toLowerCase().includes(q) || r.body.toLowerCase().includes(q));
  picker.index = Math.min(picker.index, Math.max(0, picker.shown.length - 1));
  els.replyPickerList.innerHTML = picker.shown.length
    ? picker.shown.map((r, i) => `
      <button type="button" class="reply-opt${i === picker.index ? ' active' : ''}" role="option" data-i="${i}">
        <span class="reply-opt-title"><bdi>${escapeHtml(r.title)}</bdi></span>
        <span class="reply-opt-body"><bdi>${escapeHtml(r.body)}</bdi></span>
      </button>`).join('')
    : `<p class="reply-picker-empty">${state.savedReplies.length ? 'No saved reply matches.' : 'No saved replies yet.'}</p>`;
}

function openReplyPicker(slash = false) {
  if (!state.savedRepliesOn) return;
  picker.open = true;
  picker.slash = slash;
  picker.index = 0;
  els.replyPicker.hidden = false;
  renderReplyPicker();
}
function closeReplyPicker() {
  picker.open = false;
  els.replyPicker.hidden = true;
}

// "/" as the first thing typed opens the picker, and what follows narrows it.
function slashPicker() {
  const v = els.composerInput.value;
  if (v.startsWith('/') && !v.includes('\n')) {
    if (picker.open && picker.slash) renderReplyPicker();
    else openReplyPicker(true);
  } else if (picker.open && picker.slash) {
    closeReplyPicker();
  }
}

function useSavedReply(r) {
  if (!r) return;
  const input = els.composerInput;
  if (picker.slash || !input.value.trim()) {
    input.value = r.body;
  } else {
    const at = input.selectionStart ?? input.value.length;
    input.value = `${input.value.slice(0, at)}${r.body}${input.value.slice(at)}`;
  }
  closeReplyPicker();
  autoGrow();
  refreshSendEnabled();
  saveDraft();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

// True when the picker used the key, so the composer leaves it alone.
function replyPickerKey(e) {
  if (!picker.open) return false;
  if (e.key === 'Escape') { e.preventDefault(); closeReplyPicker(); return true; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!picker.shown.length) return false;
    e.preventDefault();
    picker.index = (picker.index + (e.key === 'ArrowDown' ? 1 : picker.shown.length - 1)) % picker.shown.length;
    renderReplyPicker();
    const on = els.replyPickerList.querySelector('.reply-opt.active');
    if (on) on.scrollIntoView({ block: 'nearest' });
    return true;
  }
  if (e.key === 'Enter' && !e.shiftKey && picker.shown.length) {
    e.preventDefault();
    useSavedReply(picker.shown[picker.index]);
    return true;
  }
  return false;
}

els.repliesBtn.addEventListener('click', () => {
  if (picker.open) closeReplyPicker();
  else openReplyPicker(false);
});
els.replyPickerList.addEventListener('click', (e) => {
  const opt = e.target.closest('.reply-opt');
  if (opt) useSavedReply(picker.shown[Number(opt.dataset.i)]);
});
els.replyPickerManage.addEventListener('click', () => { closeReplyPicker(); openRepliesModal(); });
document.addEventListener('click', (e) => {
  if (picker.open && !picker.slash && !e.target.closest('#reply-picker, #replies-btn')) closeReplyPicker();
});

function renderRepliesList() {
  els.repliesList.innerHTML = state.savedReplies.length
    ? state.savedReplies.map((r) => `
      <button type="button" class="reply-opt${r.id === repliesEdit.id ? ' active' : ''}" data-id="${r.id}">
        <span class="reply-opt-title"><bdi>${escapeHtml(r.title)}</bdi></span>
        <span class="reply-opt-body"><bdi>${escapeHtml(r.body)}</bdi></span>
      </button>`).join('')
    : '<p class="reply-picker-empty">None yet. Add the first one below.</p>';
}

function editReply(r) {
  repliesEdit.id = r ? r.id : null;
  els.repliesTitle.value = r ? r.title : '';
  els.repliesBody.value = r ? r.body : '';
  els.repliesSave.textContent = r ? 'Save' : 'Add';
  els.repliesDelete.hidden = !r;
  els.repliesError.hidden = true;
  renderRepliesList();
}

function openRepliesModal() {
  els.repliesModal.hidden = false;
  editReply(null);
  loadSavedReplies();
}
function closeRepliesModal() { els.repliesModal.hidden = true; }

els.repliesClose.addEventListener('click', closeRepliesModal);
els.repliesModal.addEventListener('click', (e) => { if (e.target === els.repliesModal) closeRepliesModal(); });
els.repliesList.addEventListener('click', (e) => {
  const opt = e.target.closest('.reply-opt');
  if (!opt) return;
  const r = state.savedReplies.find((x) => x.id === Number(opt.dataset.id));
  editReply(r && r.id === repliesEdit.id ? null : r);
});
els.repliesForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = JSON.stringify({ title: els.repliesTitle.value, body: els.repliesBody.value });
  const { ok, status, data } = repliesEdit.id
    ? await api(`/api/saved-replies/${repliesEdit.id}`, { method: 'PATCH', body })
    : await api('/api/saved-replies', { method: 'POST', body });
  if (status === 401) return handleAuthLost();
  if (!ok) {
    els.repliesError.textContent = data.error || 'Could not save it.';
    els.repliesError.hidden = false;
    return;
  }
  editReply(null);
  await loadSavedReplies();
});
els.repliesDelete.addEventListener('click', async () => {
  if (!repliesEdit.id) return;
  const { ok, status, data } = await api(`/api/saved-replies/${repliesEdit.id}`, { method: 'DELETE' });
  if (status === 401) return handleAuthLost();
  if (!ok) {
    els.repliesError.textContent = data.error || 'Could not delete it.';
    els.repliesError.hidden = false;
    return;
  }
  editReply(null);
  await loadSavedReplies();
});

/* ----------------------- message actions ----------------------- */

// One menu for everything a message can take: a long press on a phone, a
// right click or the three dots on a computer.
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const sheet = { msg: null };

function copyText(text) {
  const done = () => toast('Copied.');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => toast('Could not copy.', true));
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (_) { toast('Could not copy.', true); }
  ta.remove();
}

function textOf(m) {
  if (isTextLike(m)) return WaTpl.messageText(m, state.templates);
  return (m.media_meta && m.media_meta.caption) || '';
}

function sheetActionsFor(m) {
  const out = [];
  const real = !m._optimistic && typeof m.id === 'number' && m.id > 0;
  if (real && m.wa_message_id && m.status !== 'failed') out.push({ label: 'Reply', run: () => startReply(m) });
  const text = textOf(m);
  if (text) out.push({ label: 'Copy', run: () => copyText(text) });
  if (real) out.push({ label: 'Forward', run: () => openForwardModal(m) });
  if (real && isViewable(m)) out.push({ label: 'Open', run: () => openViewer(m.id) });
  if (real && m.media_status === 'stored' && !isTextLike(m) && m.type !== 'contacts' && m.type !== 'location') {
    out.push({ label: 'Download', run: () => { const a = document.createElement('a'); a.href = mediaSrc(m); a.download = ''; a.click(); } });
  }
  if (m.status === 'failed' && m.direction === 'out' && !m._optimistic) out.push({ label: 'Send again', run: () => retrySend(m) });
  return out;
}

const MENU_ICONS = {
  Reply: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v3"/>',
  Copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  Forward: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0-6 6v3"/>',
  Open: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/>',
  Download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  'Send again': '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
};
function menuIcon(label) {
  const d = MENU_ICONS[label];
  return d ? `<svg class="menu-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>` : '';
}

// The part of the screen the keyboard leaves free.
function screenBox() {
  const v = window.visualViewport;
  return v ? { top: v.offsetTop, h: v.height, w: v.width } : { top: 0, h: window.innerHeight, w: window.innerWidth };
}

// Held on a phone: the message lifts in place over a soft blur, reactions just
// above it and the actions just below, moved as one block to stay on screen.
// The whole message and its reaction always show: a message too tall for the
// screen is laid out from the top and the menu scrolls, as in WhatsApp.
function layoutFocus(m, bubble) {
  const ov = els.sheet;
  const r = bubble.getBoundingClientRect();
  const pill = bubble.querySelector(':scope > .reaction-pill');
  const hang = pill ? Math.max(0, Math.ceil(pill.getBoundingClientRect().bottom - r.bottom)) : 0;
  const lift = bubble.cloneNode(true);
  lift.classList.add('menu-lift');
  lift.classList.remove('swiping', 'swipe-armed');
  lift.setAttribute('aria-hidden', 'true');
  lift.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  lift.removeAttribute('id');
  lift.style.width = `${r.width}px`;
  ov.appendChild(lift);
  bubble.classList.add('is-lifted');
  sheet.lifted = bubble;
  const bar = els.sheetReactions;
  const list = els.sheetActions;
  const box = screenBox();
  const pad = 10;
  const gap = 8;
  const bh = bar.hidden ? 0 : bar.offsetHeight;
  const lh = list.offsetHeight;
  const h = r.height;
  // the lifted copy grows 2% about its centre: room for that above and below
  const grow = Math.ceil(h * 0.01);
  const above = (bh ? bh + gap : 0) + grow;
  const below = hang + gap + grow;
  const total = above + h + below + lh;
  const fits = total <= box.h - 2 * pad;
  ov.classList.toggle('menu-scroll', !fits);
  ov.scrollTop = 0;
  const top = fits
    ? Math.max(box.top + pad, Math.min(r.top - above, box.top + box.h - total - pad))
    : box.top + pad;
  const bubbleTop = top + above;
  lift.style.top = `${bubbleTop}px`;
  lift.style.left = `${r.left}px`;
  lift.style.setProperty('--lift-from', `${Math.round(r.top - bubbleTop)}px`);
  const side = (w) => {
    const x = m.direction === 'out' ? r.right - w : r.left;
    return Math.max(pad, Math.min(x, box.w - w - pad));
  };
  if (bh) { bar.style.left = `${side(bar.offsetWidth)}px`; bar.style.top = `${top}px`; }
  list.style.left = `${side(list.offsetWidth)}px`;
  list.style.top = `${bubbleTop + h + below}px`;
  if (!fits) {
    const end = document.createElement('div');
    end.className = 'menu-end';
    end.style.top = `${bubbleTop + h + below + lh}px`;
    end.style.height = `${pad}px`;
    ov.appendChild(end);
  }
}

// Right click on a computer: a small card at the pointer, kept inside the window.
function layoutCard(at) {
  const card = els.sheet.querySelector('.sheet-card');
  const pad = 8;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const x = at.x + cw + pad > window.innerWidth ? at.x - cw : at.x;
  const y = at.y + ch + pad > window.innerHeight ? at.y - ch : at.y;
  card.style.left = `${Math.max(pad, Math.min(x, window.innerWidth - cw - pad))}px`;
  card.style.top = `${Math.max(pad, Math.min(y, window.innerHeight - ch - pad))}px`;
}

function openSheet(m, at) {
  if (!m || !els.sheet.hidden) return;
  const actions = sheetActionsFor(m);
  const canReact = Boolean(m.wa_message_id) && typeof m.id === 'number' && m.status !== 'failed';
  if (!actions.length && !canReact) return;
  if (byTouch && window.getSelection) window.getSelection().removeAllRanges();
  const bubble = els.messages.querySelector(`.bubble[data-mid="${m.id}"]`);
  const asCard = Boolean(at) && !byTouch;
  sheet.msg = m;
  sheet.actions = actions;
  sheet.returnFocus = document.activeElement;
  els.sheetReactions.hidden = !canReact;
  els.sheetReactions.innerHTML = canReact
    ? QUICK_REACTIONS.map((e) => `<button type="button" class="sheet-react${ourReaction(m) === e ? ' active' : ''}" data-emoji="${e}" role="menuitem" aria-label="React ${e}${ourReaction(m) === e ? ', chosen' : ''}">${e}</button>`).join('')
    : '';
  els.sheetActions.innerHTML = actions.map((a, i) => `<button type="button" class="sheet-action" role="menuitem" data-i="${i}">${menuIcon(a.label)}<span>${escapeHtml(a.label)}</span></button>`).join('');
  const card = els.sheet.querySelector('.sheet-card');
  [card, els.sheetReactions, els.sheetActions].forEach((n) => { n.style.left = ''; n.style.top = ''; });
  els.sheet.className = `sheet-overlay ${asCard ? 'menu-card' : bubble ? 'menu-focus' : 'menu-card menu-plain'}`;
  if (tapTicks) els.sheet.querySelectorAll('.sheet-react, .sheet-action').forEach(addTapTick);
  els.sheet.hidden = false;
  if (asCard) layoutCard(at);
  else if (bubble) layoutFocus(m, bubble);
  else {
    const box = screenBox();
    layoutCard({ x: (box.w - card.offsetWidth) / 2, y: box.top + (box.h - card.offsetHeight) / 2 });
  }
  sheet.openedAt = performance.now();
  haptic();
  if (!byTouch) {
    const first = els.sheet.querySelector('.sheet-react:not([hidden]), .sheet-action');
    if (first) first.focus({ preventScroll: true, focusVisible: false });
  }
}
function closeSheet() {
  els.sheet.hidden = true;
  els.sheet.querySelectorAll('.menu-lift, .menu-end').forEach((n) => n.remove());
  if (sheet.lifted) { sheet.lifted.classList.remove('is-lifted'); sheet.lifted = null; }
  sheet.msg = null;
  const back = sheet.returnFocus;
  sheet.returnFocus = null;
  if (!byTouch && back && back.focus && document.contains(back) && back !== document.body) back.focus({ preventScroll: true });
}

// Our own reaction: on a member's message it is the message's reaction; on
// one of ours it rides in media_meta, beside the member's reaction to it.
function ourReaction(m) {
  if (!m) return null;
  return m.direction === 'in' ? (m.reaction || null) : ((m.media_meta && m.media_meta.our_reaction) || null);
}
function withOurReaction(m, emoji) {
  return m.direction === 'in'
    ? { ...m, reaction: emoji || null }
    : { ...m, media_meta: { ...(m.media_meta || {}), our_reaction: emoji || null } };
}

async function reactTo(m, emoji) {
  const waId = m.wa_id || state.activeWaId;
  const next = ourReaction(m) === emoji ? '' : emoji;
  const t = thread(waId);
  const before = t.byId.get(m.id);
  t.byId.set(m.id, withOurReaction(before || m, next));
  if (waId === state.activeWaId) renderMessages();
  const { ok, status, data } = await api('/api/react', { method: 'POST', body: JSON.stringify({ message_id: m.id, emoji: next }) });
  if (status === 401) return handleAuthLost();
  if (ok) return;
  if (t.byId.has(m.id) && before) t.byId.set(m.id, before);
  if (waId === state.activeWaId) renderMessages();
  toast(failureWords({ error: data.error }).text || 'Could not react.', true);
}

els.sheet.addEventListener('click', (e) => {
  const react = e.target.closest('.sheet-react');
  const action = e.target.closest('.sheet-action');
  const m = sheet.msg;
  const actions = sheet.actions || [];
  if (react && m) { if (!tapTicks) haptic(); closeSheet(); reactTo(m, react.dataset.emoji); return; }
  if (action && m) { const a = actions[Number(action.dataset.i)]; closeSheet(); if (a) a.run(); return; }
  // The finger that opened it by a long press lifts over the backdrop a moment
  // later; that must not close it again.
  if (e.target === els.sheet && performance.now() - sheet.openedAt > 400) closeSheet();
});
els.sheet.addEventListener('keydown', (e) => {
  const items = [...els.sheet.querySelectorAll('.sheet-react, .sheet-action')].filter((n) => !n.closest('[hidden]'));
  if (!items.length) return;
  const at = items.indexOf(document.activeElement);
  const reacts = items.filter((n) => n.classList.contains('sheet-react'));
  const r = reacts.indexOf(document.activeElement);
  let next = null;
  if (e.key === 'ArrowDown') next = r >= 0 ? items[reacts.length] || items[0] : items[(at + 1) % items.length];
  else if (e.key === 'ArrowUp') next = r >= 0 ? items[items.length - 1] : items[(at - 1 + items.length) % items.length];
  else if (e.key === 'ArrowRight' && r >= 0) next = reacts[(r + 1) % reacts.length];
  else if (e.key === 'ArrowLeft' && r >= 0) next = reacts[(r - 1 + reacts.length) % reacts.length];
  else if (e.key === 'Home') next = items[0];
  else if (e.key === 'End') next = items[items.length - 1];
  else if (e.key === 'Tab') next = items[(at + (e.shiftKey ? -1 : 1) + items.length) % items.length];
  if (next) { e.preventDefault(); next.focus(); }
});
window.addEventListener('resize', () => { if (!els.sheet.hidden && !byTouch) closeSheet(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!els.sheet.hidden) closeSheet();
  else if (!els.peerSheet.hidden) closePeerSheet();
  else if (!els.repliesModal.hidden) closeRepliesModal();
});

function messageOfBubble(node) {
  const bubble = node && node.closest ? node.closest('.bubble') : null;
  if (!bubble || !state.activeWaId) return null;
  return thread(state.activeWaId).byId.get(Number(bubble.dataset.mid)) || null;
}

els.messages.addEventListener('contextmenu', (e) => {
  const m = messageOfBubble(e.target);
  // A finger held down: the phone's own menu and text selection stay away,
  // and whichever of this and the timer comes first opens ours.
  if (byTouch) {
    if (e.target.closest('audio, input, textarea')) return;
    e.preventDefault();
    if (m && !press.swiping && !press.fired) { clearTimeout(press.timer); press.fired = true; openSheet(m); }
    return;
  }
  if (!m || e.target.closest('a, audio, video')) return;
  // Someone who selected a few words wants the browser's own menu to copy them.
  if (String(window.getSelection ? window.getSelection() : '')) return;
  e.preventDefault();
  openSheet(m, { x: e.clientX, y: e.clientY });
});

/* ----------------------- touch: long press and swipe to reply ----------------------- */

// Whether a finger is in use. Asked of each press, because a Samsung phone
// with a pen tells the page it has a mouse. Under a finger, text is not
// selectable (the menu has Copy) and the phone's own menus stay closed.
const coarsePointer = window.matchMedia('(pointer: coarse)');
let byTouch = false;
function setByTouch(on) {
  byTouch = on || coarsePointer.matches;
  document.documentElement.classList.toggle('by-touch', byTouch);
}
setByTouch(navigator.maxTouchPoints > 0 && phoneLayout.matches);
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType) setByTouch(e.pointerType === 'touch');
}, true);
document.addEventListener('selectstart', (e) => {
  if (!byTouch) return;
  const el = e.target.nodeType === 1 ? e.target : e.target.parentElement;
  if (el && el.closest('.bubble, .conv-row, .day-sep, .sheet-overlay, .messages, .me-menu')) e.preventDefault();
});
els.convList.addEventListener('contextmenu', (e) => { if (byTouch) e.preventDefault(); });
document.addEventListener('contextmenu', (e) => {
  if (byTouch && !e.target.closest('input, textarea, [contenteditable="true"]')) e.preventDefault();
});
document.addEventListener('selectionchange', () => {
  if (!byTouch || !window.getSelection) return;
  const typing = document.activeElement && document.activeElement.closest('input, textarea, [contenteditable="true"]');
  if (typing) return;
  const sel = window.getSelection();
  const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
  if (sel.rangeCount && node && !node.closest('input, textarea, [contenteditable="true"]')) sel.removeAllRanges();
});

const press = { timer: null, bubble: null, x0: 0, y0: 0, swiping: false, dx: 0, fired: false, tapOk: false };
const lastTap = { bubble: null, at: 0, x: 0, y: 0 };
const DOUBLE_TAP_MS = 320;

// A double click on a message, or beside it in its row, answers it, as in WhatsApp.
function canReplyTo(m) {
  return Boolean(m && !m._optimistic && m.wa_message_id && m.status !== 'failed');
}
function bubbleAtY(y) {
  for (const b of els.messages.querySelectorAll(':scope > .bubble')) {
    const r = b.getBoundingClientRect();
    if (y >= r.top && y <= r.bottom) return b;
  }
  return null;
}
const LONG_PRESS_MS = 450;
const SWIPE_REPLY_AT = 56;

function endPress() {
  clearTimeout(press.timer);
  if (press.bubble) {
    press.bubble.classList.remove('swiping', 'swipe-armed');
    press.bubble.style.removeProperty('--swipe');
  }
  press.bubble = null;
  press.swiping = false;
  press.fired = false;
}

els.messages.addEventListener('touchstart', (e) => {
  endPress();
  if (e.touches.length !== 1) return;
  const bubble = e.target.closest('.bubble') || (e.target === els.messages ? bubbleAtY(e.touches[0].clientY) : null);
  if (!bubble || e.target.closest('audio, .bubble-retry, .vplayer')) return;
  Object.assign(press, { bubble, buzzed: false, x0: e.touches[0].clientX, y0: e.touches[0].clientY, dx: 0, fired: false, tapOk: !e.target.closest('a, button, .media-frame, video, .contact-card') });
  press.timer = setTimeout(() => {
    if (!press.bubble || press.swiping) return;
    press.fired = true;
    openSheet(messageOfBubble(press.bubble));
  }, LONG_PRESS_MS);
}, { passive: true });

els.messages.addEventListener('touchmove', (e) => {
  if (!press.bubble || press.fired) return;
  const dx = e.touches[0].clientX - press.x0;
  const dy = e.touches[0].clientY - press.y0;
  if (!press.swiping) {
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearTimeout(press.timer);
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { endPress(); return; } // reading up or down
    const m = messageOfBubble(press.bubble);
    if (dx < 14 || !m || !m.wa_message_id || m.status === 'failed') return;
    press.swiping = true;
    press.bubble.classList.add('swiping');
  }
  press.dx = Math.max(0, Math.min(96, dx));
  press.bubble.style.setProperty('--swipe', `${press.dx}px`);
  if (press.dx >= SWIPE_REPLY_AT && !press.bubble.classList.contains('swipe-armed')) haptic(press);
  press.bubble.classList.toggle('swipe-armed', press.dx >= SWIPE_REPLY_AT);
}, { passive: true });

for (const type of ['touchend', 'touchcancel']) {
  els.messages.addEventListener(type, (e) => {
    const { bubble, swiping, dx, fired } = press;
    const m = bubble ? messageOfBubble(bubble) : null;
    endPress();
    // The finger lifting after a long press must not also open the photo under it.
    if (fired && e.cancelable) e.preventDefault();
    if (type === 'touchend' && swiping && dx >= SWIPE_REPLY_AT && m) {
      startReply(m);
      return;
    }
    // Two quick taps on the same message answer it.
    if (type !== 'touchend' || swiping || fired || !bubble || !press.tapOk || !e.changedTouches.length) { lastTap.bubble = null; return; }
    const t = e.changedTouches[0];
    if (Math.abs(t.clientX - press.x0) > 10 || Math.abs(t.clientY - press.y0) > 10) { lastTap.bubble = null; return; }
    const now = Date.now();
    if (lastTap.bubble === bubble && now - lastTap.at < DOUBLE_TAP_MS && Math.abs(t.clientX - lastTap.x) < 30 && Math.abs(t.clientY - lastTap.y) < 30) {
      lastTap.bubble = null;
      if (canReplyTo(m)) {
        if (e.cancelable) e.preventDefault();
        startReply(m);
      }
      return;
    }
    Object.assign(lastTap, { bubble, at: now, x: t.clientX, y: t.clientY });
  });
}

els.messages.addEventListener('mousedown', (e) => {
  if (e.detail > 1 && !e.target.closest('input, textarea')) e.preventDefault();
});
els.messages.addEventListener('dblclick', (e) => {
  if (byTouch || e.target.closest('a, button, input, textarea, .vplayer, .media-frame, video, .bubble-actions')) return;
  const bubble = e.target.closest('.bubble') || bubbleAtY(e.clientY);
  const m = bubble ? messageOfBubble(bubble) : null;
  if (!canReplyTo(m)) return;
  if (window.getSelection) window.getSelection().removeAllRanges();
  startReply(m);
});

// As a Home Screen app there is no browser bar to go back with: a swipe in
// from the left edge returns to the list. In a browser tab the browser's own
// back gesture already does this, and this stays out of its way.
if (IS_HOME_SCREEN_APP) {
  const edge = { on: false, x0: 0, y0: 0 };
  els.thread.addEventListener('touchstart', (e) => {
    edge.on = e.touches.length === 1 && e.touches[0].clientX < 22;
    edge.x0 = e.touches[0].clientX;
    edge.y0 = e.touches[0].clientY;
  }, { passive: true });
  els.thread.addEventListener('touchend', (e) => {
    if (!edge.on) return;
    edge.on = false;
    const t = e.changedTouches[0];
    if (t.clientX - edge.x0 > 70 && Math.abs(t.clientY - edge.y0) < 60 && els.app.dataset.view === 'thread') {
      if (history.state && history.state.chat) history.back();
      else closeThread();
    }
  }, { passive: true });
}
