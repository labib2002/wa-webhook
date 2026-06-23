/* =============================================================================
   Agent Inbox — frontend SPA (vanilla, no build step)
   Talks only to the passcode-gated /api/* routes. Stays live via smart polling
   (list every 4s, open thread every 2.5s incrementally), paused when the tab
   is hidden and refreshed on focus. Optimistic send for instant feedback.
   ============================================================================= */

const $ = (sel) => document.querySelector(sel);

const els = {
  body: document.body,
  login: $('#login-screen'),
  loginForm: $('#login-form'),
  loginBtn: $('#login-btn'),
  loginError: $('#login-error'),
  passcode: $('#passcode'),
  app: $('#app'),
  logoutBtn: $('#logout-btn'),
  connStatus: $('#conn-status'),
  search: $('#search'),
  convList: $('#conv-list'),
  convEmpty: $('#conv-empty'),
  convLoading: $('#conv-loading'),
  placeholder: $('#thread-placeholder'),
  thread: $('#thread'),
  backBtn: $('#back-btn'),
  threadAvatar: $('#thread-avatar'),
  threadName: $('#thread-name'),
  threadSub: $('#thread-sub'),
  messages: $('#messages'),
  threadLoading: $('#thread-loading'),
  messagesEmpty: $('#messages-empty'),
  composerForm: $('#composer-form'),
  composerInput: $('#composer-input'),
  composerBanner: $('#composer-banner'),
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
  newChatError: $('#new-chat-error'),
  newChatCancel: $('#new-chat-cancel'),
  forwardModal: $('#forward-modal'),
  forwardSearch: $('#forward-search'),
  forwardList: $('#forward-list'),
  forwardEmpty: $('#forward-empty'),
  forwardError: $('#forward-error'),
  forwardCancel: $('#forward-cancel'),
  forwardSubmit: $('#forward-submit'),
  toast: $('#toast'),
};

const state = {
  conversations: [],      // latest list snapshot
  filter: '',
  listFilter: 'all',      // 'all' | 'unread' — composes WITH the search term
  activeWaId: null,
  forward: null,          // { msgId, selected: Set(wa_id), search } while the picker is open
  threads: {},            // wa_id -> { byId: Map(id->msg), order: [ids], lastMsgId, loaded }
  drafts: {},             // wa_id -> unsent composer text (preserved across chat switches)
  sending: false,
  listTimer: null,
  threadTimer: null,
  optimisticSeq: -1,      // negative ids for optimistic bubbles
  pendingFile: null,      // { name, mime, size, base64, dataUrl } staged to send
  rec: null,              // active voice recorder { mediaRecorder, stream, chunks, timer, startedAt }
};

// Get (or create) the cached thread for a wa_id.
function thread(waId) {
  if (!state.threads[waId]) {
    state.threads[waId] = { byId: new Map(), order: [], maxUpdatedAt: null, loaded: false };
  }
  return state.threads[waId];
}

// Merge a batch of message rows into a thread, deduping by id. Returns true if
// anything visible changed (new message, or an existing one's status/reaction/
// body updated). Also advances the thread's updated_at high-water mark.
function mergeMessages(t, rows) {
  let changed = false;
  for (const m of rows) {
    const existing = t.byId.get(m.id);
    if (!existing) {
      // drop an optimistic twin (same body+direction) the server now confirms
      for (let i = t.order.length - 1; i >= 0; i--) {
        const o = t.byId.get(t.order[i]);
        if (o && o._optimistic && o.direction === m.direction && o.body === m.body && o.type === m.type) {
          t.byId.delete(o.id); t.order.splice(i, 1); break;
        }
      }
      t.byId.set(m.id, m);
      t.order.push(m.id);
      changed = true;
    } else if (
      existing.status !== m.status || existing.reaction !== m.reaction ||
      existing.media_status !== m.media_status || existing.body !== m.body
    ) {
      t.byId.set(m.id, { ...existing, ...m });
      changed = true;
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

function threadMessages(t) {
  return t.order.map((id) => t.byId.get(id)).filter(Boolean);
}

const LIST_POLL_MS = 4000;
// Thread poll is cheap now (it fetches only rows changed since the high-water
// mark — usually nothing), so we can poll faster for snappy reactions/ticks.
const THREAD_POLL_MS = 1500;

/* ----------------------------- utilities ----------------------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, ok: res.ok, data: data || {} };
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

function displayName(c) {
  return (c.profile_name && c.profile_name.trim()) || formatPhone(c.wa_id);
}

function formatPhone(waId) {
  if (!waId) return 'Unknown';
  // light formatting: prefix with + (WhatsApp ids are E.164 without +)
  return '+' + waId;
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
    case 'read':      return '<span class="tick read">✓✓</span>';
    case 'delivered': return '<span class="tick">✓✓</span>';
    case 'sent':      return '<span class="tick">✓</span>';
    case 'failed':    return '<span class="tick">⚠</span>';
    default:          return '<span class="tick">🕓</span>'; // pending/queued
  }
}

let toastTimer = null;
function toast(msg, danger = false) {
  els.toast.textContent = msg;
  els.toast.classList.toggle('danger', danger);
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
    setTimeout(() => { els.toast.hidden = true; }, 220);
  }, 3200);
}

function setConn(stateName) {
  // stateName: 'live' | 'stale' | 'error'
  els.connStatus.classList.remove('stale', 'error');
  if (stateName === 'stale') els.connStatus.classList.add('stale');
  if (stateName === 'error') els.connStatus.classList.add('error');
  const labels = { live: 'live', stale: 'paused', error: 'offline' };
  els.connStatus.lastChild.textContent = labels[stateName] || 'live';
}

/* ----------------------------- auth flow ----------------------------- */

async function boot() {
  const { data } = await api('/api/session');
  if (data.authed) {
    showApp();
  } else {
    showLogin();
  }
  // reveal (drop the no-transition preload class)
  requestAnimationFrame(() => els.body.classList.remove('preload'));
}

function showLogin() {
  els.app.hidden = true;
  els.login.hidden = false;
  els.passcode.focus();
}

function showApp() {
  els.login.hidden = true;
  els.app.hidden = false;
  startListPolling();
  refreshConversations(true);
}

els.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.loginError.hidden = true;
  els.loginBtn.disabled = true;
  els.loginBtn.textContent = 'Unlocking…';
  const { ok, data } = await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ passcode: els.passcode.value }),
  });
  els.loginBtn.disabled = false;
  els.loginBtn.textContent = 'Unlock';
  if (ok) {
    els.passcode.value = '';
    showApp();
  } else {
    els.loginError.textContent = data.error || 'Login failed.';
    els.loginError.hidden = false;
    els.passcode.select();
  }
});

els.logoutBtn.addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  stopListPolling();
  stopThreadPolling();
  state.activeWaId = null;
  showLogin();
});

/* ----------------------- conversation list ----------------------- */

async function refreshConversations(initial = false) {
  const { ok, status, data } = await api('/api/conversations');
  if (!ok) {
    if (status === 401) return handleAuthLost();
    if (status === 503) {
      els.convLoading.hidden = true;
      els.convEmpty.hidden = false;
      els.convEmpty.querySelector('p').textContent = 'Database not connected';
      els.convEmpty.querySelector('span').textContent =
        'Set the Supabase env vars to start receiving messages.';
      setConn('error');
      return;
    }
    setConn('error');
    if (initial) { els.convLoading.hidden = true; }
    return;
  }
  setConn(document.hidden ? 'stale' : 'live');
  state.conversations = data.conversations || [];
  els.convLoading.hidden = true;
  renderConversations();
}

let _lastConvSig = '';
function renderConversations(forceRender = false) {
  const q = state.filter.trim().toLowerCase();
  const onlyUnread = state.listFilter === 'unread';
  let list = state.conversations;
  // Filter first, then search WITHIN the active filter.
  if (onlyUnread) list = list.filter((c) => c.unread_count > 0);
  if (q) {
    list = list.filter((c) =>
      displayName(c).toLowerCase().includes(q) || (c.wa_id || '').includes(q)
    );
  }

  // Skip the DOM rebuild if nothing the list shows has changed — avoids
  // flicker, lost hover, and wasted work on every 4s poll. The active filter +
  // search term are part of the signature so a row correctly appears/disappears
  // as its unread state changes.
  const sig = state.activeWaId + '|' + state.listFilter + '|' + q + '|' + list.map((c) =>
    `${c.wa_id}:${c.last_message_at}:${c.unread_count}:${c.last_message_text}:${c.profile_name || ''}:${c.last_message_direction || ''}`
  ).join(';');
  if (!forceRender && sig === _lastConvSig) return;
  _lastConvSig = sig;

  if (!list.length) {
    els.convList.innerHTML = '';
    els.convEmpty.hidden = false;
    if (onlyUnread && !q) {
      els.convEmpty.querySelector('p').textContent = 'No unread chats';
      els.convEmpty.querySelector('span').textContent = 'You’re all caught up.';
    } else if (q) {
      els.convEmpty.querySelector('p').textContent = 'No matches';
      els.convEmpty.querySelector('span').textContent = 'Try a different name or number.';
    }
    return;
  }
  els.convEmpty.hidden = true;

  els.convList.innerHTML = list.map((c) => {
    const name = escapeHtml(displayName(c));
    const active = c.wa_id === state.activeWaId ? ' active' : '';
    const hasUnread = c.unread_count > 0;
    const unread = hasUnread ? ' has-unread' : '';
    const badge = c.unread_count > 99 ? '99+' : c.unread_count;
    const outTick =
      c.last_message_direction === 'out'
        ? '<span class="tick">✓</span> '
        : '';
    // Per-row read/unread control: a hovered chat with unread can be cleared;
    // a read chat can be re-flagged unread.
    const toggleTitle = hasUnread ? 'Mark as read' : 'Mark as unread';
    const toggleIco = hasUnread
      ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
      : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg>';
    return `
      <button class="conv-row${active}${unread}" role="listitem" data-wa="${escapeHtml(c.wa_id)}">
        <span class="avatar">${escapeHtml(initials(c.profile_name, c.wa_id))}</span>
        <span class="row-name">${name}</span>
        <span class="row-time">${escapeHtml(fmtListTime(c.last_message_at))}</span>
        <span class="row-preview">${outTick}${escapeHtml(c.last_message_text || '')}</span>
        <span class="row-badge">${badge}</span>
        <span class="row-readtoggle" role="button" tabindex="0" data-read="${hasUnread ? 'read' : 'unread'}" title="${toggleTitle}" aria-label="${toggleTitle}">${toggleIco}</span>
      </button>`;
  }).join('');
}

els.convList.addEventListener('click', (e) => {
  const toggle = e.target.closest('.row-readtoggle');
  if (toggle) {
    e.stopPropagation();
    const row = toggle.closest('.conv-row');
    if (row) setConversationRead(row.dataset.wa, toggle.dataset.read === 'read');
    return;
  }
  const row = e.target.closest('.conv-row');
  if (!row) return;
  openConversation(row.dataset.wa);
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

els.search.addEventListener('input', () => {
  state.filter = els.search.value;
  renderConversations();
});

// Filter chips (All / Unread) — compose with the search term.
document.querySelectorAll('.filter-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    state.listFilter = chip.dataset.filter;
    document.querySelectorAll('.filter-chip').forEach((c) => {
      const on = c === chip;
      c.classList.toggle('active', on);
      c.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    renderConversations();
  });
});

// Manual read/unread flag (dashboard-local; does NOT touch WhatsApp blue ticks).
// Optimistic: flip the local count, re-render, then persist; the list poll keeps
// it in sync afterwards. Marking unread sets the count to 1 so the badge shows.
async function setConversationRead(waId, read) {
  const conv = state.conversations.find((c) => c.wa_id === waId);
  if (conv) {
    conv.unread_count = read ? 0 : 1;
    renderConversations();
  }
  const { ok, status, data } = await api(`/api/conversations/${encodeURIComponent(waId)}/read`, {
    method: 'POST', body: JSON.stringify({ read }),
  });
  if (status === 401) return handleAuthLost();
  if (!ok) {
    toast((data && data.error) || 'Could not update the chat.', true);
    refreshConversations(); // resync from the server
  }
}

/* --------------------------- open a thread --------------------------- */

async function openConversation(waId) {
  if (!waId) return;
  const conv = state.conversations.find((c) => c.wa_id === waId);

  // Preserve the previous chat's unsent text as a per-chat draft before switching.
  saveDraft();

  state.activeWaId = waId;
  const t = thread(waId);

  // header
  els.threadName.textContent = conv ? displayName(conv) : formatPhone(waId);
  els.threadSub.textContent = conv && conv.profile_name ? formatPhone(waId) : 'WhatsApp';
  els.threadAvatar.textContent = initials(conv?.profile_name, waId);

  // view swap
  els.placeholder.hidden = true;
  els.thread.hidden = false;
  els.app.dataset.view = 'thread';
  els.messagesEmpty.hidden = true;
  clearBanner();
  // Restore this chat's draft (don't blow away unsent text). Clears any staged
  // file from the prior chat but keeps the typed draft.
  clearPendingFile();
  els.composerInput.value = state.drafts[waId] || '';
  autoGrow();
  refreshSendEnabled();

  // Render whatever we already have cached (instant — no flash, no reload),
  // then only show the spinner if we have nothing yet.
  els.messages.querySelectorAll('.bubble, .day-sep').forEach((n) => n.remove());
  renderMessages(true);
  els.threadLoading.hidden = t.loaded || t.order.length > 0;

  renderConversations(); // reflect active highlight

  await loadThread(true);
  els.threadLoading.hidden = true;
  startThreadPolling();
  els.composerInput.focus();
  // Place the caret at the END of a restored draft (focus alone leaves it at 0).
  const end = els.composerInput.value.length;
  els.composerInput.setSelectionRange(end, end);

  // Always mark read on open (reset badge + blue ticks), regardless of the
  // client-side unread count — polling may already have zeroed it locally.
  if (conv) { conv.unread_count = 0; renderConversations(); }
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
  const changed = mergeMessages(t, data.messages || []);
  if (changed || initial) {
    const atBottom = isNearBottom();
    renderMessages();
    if (atBottom || initial) scrollMessagesToBottom();
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
  // Build the desired sequence of [type,key,node-spec].
  const desiredIds = msgs.map((m) => String(m.id));
  const existingNodes = new Map(
    [...container.querySelectorAll('.bubble')].map((n) => [n.dataset.mid, n])
  );

  // If forced (chat switch), clear day separators; we rebuild them inline.
  container.querySelectorAll('.day-sep').forEach((n) => n.remove());

  let lastDay = '';
  let lastDir = '';
  let anchor = els.threadLoading; // insert after the loading/empty sentinels
  // Ensure sentinels stay at the top.
  for (const m of msgs) {
    const iso = m.wa_timestamp || m.created_at;
    const day = iso ? new Date(iso).toDateString() : '';
    if (day && day !== lastDay) {
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.textContent = dayLabel(iso);
      container.insertBefore(sep, anchor.nextSibling);
      anchor = sep;
      lastDay = day;
      lastDir = '';
    }
    const continued = m.direction === lastDir;
    let node = existingNodes.get(String(m.id));
    if (node) {
      // update in place only if the rendered signature changed
      const sig = bubbleSig(m, continued);
      if (node.dataset.sig !== sig) {
        const fresh = renderBubble(m, continued);
        node.replaceWith(fresh);
        node = fresh;
      }
      existingNodes.delete(String(m.id));
    } else {
      node = renderBubble(m, continued);
    }
    // place node right after anchor (keeps order without full rebuild)
    if (node.previousSibling !== anchor) container.insertBefore(node, anchor.nextSibling);
    anchor = node;
    lastDir = m.direction;
  }
  // remove stale bubbles no longer present
  for (const [, node] of existingNodes) node.remove();
}

// A cheap signature of everything that affects a bubble's rendering, so we
// only re-render when something visible actually changed.
function bubbleSig(m, continued) {
  return [m.id, m.status, m.error || '', m.reaction, m.media_status, m.forwarded ? 1 : 0, m._optimistic ? 1 : 0, continued ? 1 : 0, m.body].join('|');
}

function renderBubble(m, continued) {
  const div = document.createElement('div');
  const dir = m.direction === 'out' ? 'out' : 'in';
  div.className = `bubble ${dir}`;
  div.dataset.mid = String(m.id);
  div.dataset.sig = bubbleSig(m, continued);
  if (continued) div.classList.add(dir === 'out' ? 'cont-out' : 'cont-in');
  if (m.status === 'failed') div.classList.add('failed');
  if (m._optimistic) div.classList.add('pending');
  if (m.reaction) div.classList.add('has-reaction');

  const iso = m.wa_timestamp || m.created_at;

  let inner = '';

  // Dashboard-only "Forwarded" tag (the Cloud API can't set WhatsApp's native
  // forwarded label, so this shows only here).
  if (m.forwarded) {
    inner += `<span class="forwarded-tag"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>Forwarded</span>`;
  }

  if (m.type && m.type !== 'text') {
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
      inner += `<a href="${src}" target="_blank" rel="noopener" class="media-frame">
        <img src="${src}" alt="${escapeHtml(labelForType(m.type))}" loading="lazy" />
      </a>`;
    } else if (stored && m.type === 'video') {
      div.classList.add('has-media');
      inner += `<video class="media-frame" controls preload="metadata" src="${src}"></video>`;
    } else if (stored && (m.type === 'audio' || m.type === 'voice')) {
      const isVoice = m.type === 'voice' || meta.voice === true;
      div.classList.add(isVoice ? 'is-voice' : 'is-audio');
      inner += `<span class="media-label">${isVoice ? '🎤 Voice message' : '🎵 Audio'}</span>
        <audio class="media-audio" controls preload="metadata" src="${src}"></audio>`;
    } else if (stored && m.type === 'document') {
      const fname = escapeHtml(meta.filename || 'Document');
      inner += `<a class="media-doc" href="${src}" target="_blank" rel="noopener" download>
        <span class="doc-ico">📄</span><span class="doc-name">${fname}</span>
        <span class="doc-dl">Download</span>
      </a>`;
    } else {
      // pending / failed / unsupported / non-downloadable → labeled placeholder
      const isVoice = m.type === 'voice' || meta.voice === true;
      const label = escapeHtml(stripCaption(m.body) || (isVoice ? '🎤 Voice message' : labelForType(m.type)));
      const note =
        m.media_status === 'pending' && isDownloadable ? ' <span class="media-pending">· loading…</span>'
        : m.media_status === 'failed' ? ' <span class="media-pending">· unavailable</span>'
        : '';
      inner += `<span class="media-label">${label}${note}</span>`;
    }

    if (meta.caption) inner += `<span class="caption">${escapeHtml(meta.caption)}</span>`;
  } else {
    inner += escapeHtml(m.body || '');
  }

  const metaClass = div.classList.contains('has-media') ? 'meta meta-block' : 'meta';
  let metaHtml = `<span class="${metaClass}">${escapeHtml(fmtTime(iso))}`;
  if (dir === 'out') metaHtml += ' ' + tickGlyph(m._optimistic ? 'pending' : m.status);
  metaHtml += '</span>';

  div.innerHTML = inner + metaHtml;

  if (m.status === 'failed') {
    const reason = document.createElement('span');
    reason.className = 'fail-reason';
    reason.textContent = '⚠ ' + (m.error || 'Failed to send.');
    div.appendChild(reason);

    // Retry control — only on genuinely failed outgoing messages.
    if (dir === 'out' && !m._optimistic) {
      const retry = document.createElement('button');
      retry.className = 'bubble-retry';
      retry.title = 'Retry sending';
      retry.setAttribute('aria-label', 'Retry sending');
      retry.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg><span>Retry</span>';
      retry.addEventListener('click', (e) => { e.stopPropagation(); retrySend(m); });
      div.appendChild(retry);
    }
  }

  // Reaction emoji (customer reacted to one of our messages) — a small pill
  // pinned to the bubble's bottom edge, WhatsApp-style.
  if (m.reaction) {
    const r = document.createElement('span');
    r.className = 'reaction-pill';
    r.textContent = m.reaction;
    div.appendChild(r);
  }

  // Forward control — on every persisted message (in/out, any type). Not shown
  // on optimistic bubbles (no real id yet to forward).
  if (!m._optimistic && typeof m.id === 'number') {
    const fwd = document.createElement('button');
    fwd.type = 'button';
    fwd.className = 'bubble-forward';
    fwd.title = 'Forward';
    fwd.setAttribute('aria-label', 'Forward message');
    fwd.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>';
    fwd.addEventListener('click', (e) => { e.stopPropagation(); openForwardModal(m); });
    div.appendChild(fwd);
  }
  return div;
}

function stripCaption(body) {
  // body may be "📷 Image · caption"; show only the label part in the bubble
  if (!body) return '';
  const idx = body.indexOf(' · ');
  return idx > -1 ? body.slice(0, idx) : body;
}

function labelForType(type) {
  const map = {
    image: '📷 Image', audio: '🎵 Audio', voice: '🎤 Voice message',
    video: '🎬 Video', document: '📄 Document', sticker: '💟 Sticker',
    location: '📍 Location', contacts: '👤 Contact',
  };
  return map[type] || '💬 Message';
}

function scrollMessagesToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
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
    // client-drop: re-POST the exact original request
    resp = await api(cur._retry.endpoint, { method: 'POST', body: JSON.stringify(cur._retry.payload) });
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
    t2.order.push(data.message.id);
    mergeMessages(t2, []); // re-sort + advance maxUpdatedAt
    renderMessages();
    bumpConversationPreview(waId, data.message.body || stripCaption(stillThere.body) || '', 'out');
    toast('Message sent.');
  } else {
    // still failing — restore the failed state (and keep _retry for another go)
    t2.byId.set(m.id, { ...stillThere, _retrying: false, status: 'failed', error: (data && data.error) || 'Failed to send.' });
    renderMessages();
    setBanner((data && data.error) || 'Still couldn’t send. Check the connection or the 24-hour window.');
  }
}

/* ----------------------------- composer ----------------------------- */

function autoGrow() {
  const ta = els.composerInput;
  ta.style.height = 'auto';
  const full = ta.scrollHeight;
  ta.style.height = Math.min(full, 140) + 'px';
  // only show a scrollbar once we've hit the max height
  ta.classList.toggle('is-scrolling', full > 140);
}

function setBanner(msg) {
  els.composerBanner.textContent = msg;
  els.composerBanner.hidden = false;
}
function clearBanner() {
  els.composerBanner.hidden = true;
}

function refreshSendEnabled() {
  els.sendBtn.disabled = state.sending || (!els.composerInput.value.trim() && !state.pendingFile);
}

function resetComposer() {
  clearPendingFile();
  els.composerInput.value = '';
  if (state.activeWaId) delete state.drafts[state.activeWaId]; // content was sent
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
}

els.composerInput.addEventListener('input', () => {
  autoGrow();
  refreshSendEnabled();
  saveDraft(); // keep the per-chat draft current as the user types
});

els.composerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    els.composerForm.requestSubmit();
  }
});

/* ----------------------------- attachments ----------------------------- */

els.attachBtn.addEventListener('click', () => els.fileInput.click());

els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files && els.fileInput.files[0];
  els.fileInput.value = ''; // allow re-selecting the same file later
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    setBanner('File too large (max 25 MB).');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result; // data:<mime>;base64,XXXX
    const base64 = String(dataUrl).split(',')[1] || '';
    state.pendingFile = { name: file.name, mime: file.type || 'application/octet-stream', size: file.size, base64, dataUrl };
    showPendingFile();
    refreshSendEnabled();
    els.composerInput.focus();
  };
  reader.readAsDataURL(file);
});

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

async function sendPendingFile() {
  const waId = state.activeWaId;
  const f = state.pendingFile;
  if (!f || !waId) return;
  const caption = els.composerInput.value.trim();
  const isVoice = Boolean(f.voice);
  const kind = f.mime.startsWith('image/') ? 'image'
    : f.mime.startsWith('video/') ? 'video'
    : f.mime.startsWith('audio/') ? 'audio' : 'document';
  const label = isVoice ? '🎤 Voice message'
    : { image: '📷 Image', video: '🎬 Video', audio: '🎵 Audio', document: '📄 Document' }[kind];

  // optimistic bubble — show the local preview immediately for images + voice
  const localPlayable = kind === 'image' || kind === 'audio';
  const opt = addOptimistic(waId, {
    type: kind,
    body: caption ? `${label} · ${caption}` : label,
    media_status: localPlayable ? 'stored' : null,
    media_meta: { filename: f.name, mime_type: f.mime, caption: caption || null, voice: isVoice || null },
    _localUrl: localPlayable ? f.dataUrl : null,
  });

  const payload = { wa_id: waId, file_base64: f.base64, mime: f.mime, filename: f.name, caption, voice: isVoice };
  resetComposer();
  state.sending = true;
  els.sendBtn.disabled = true;
  clearBanner();

  const { ok, status, data } = await api('/api/send-media', { method: 'POST', body: JSON.stringify(payload) });
  state.sending = false;
  refreshSendEnabled();
  if (status === 401) return handleAuthLost();

  if (ok && data.message) {
    settleOptimistic(waId, opt, null, data.message);
    scrollMessagesToBottom();
    bumpConversationPreview(waId, opt.body, 'out');
  } else if (status === 207) {
    settleOptimistic(waId, opt, { _optimistic: false, status: 'sent' });
    toast(data.warning || 'Sent, but not saved.');
  } else {
    // keep the failed bubble retryable: re-POST the same media (base64 retained)
    settleOptimistic(waId, opt, {
      _optimistic: false, status: 'failed', error: data.error || 'Failed to send.',
      _retry: { endpoint: '/api/send-media', payload },
    });
    setBanner(data.error || 'Failed to send attachment.');
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
  if (state.rec || !state.activeWaId) return;
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
  const rec = {
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

function setRecPausedUI(paused) {
  els.recBar.classList.toggle('paused', paused);
  els.recHint.textContent = paused ? 'Paused — tap ▶ to resume' : 'Recording… tap send to finish';
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
    state.pendingFile = {
      name: `voice-note.${ext}`, mime: bareMime, size: blob.size, base64, dataUrl, voice: true,
    };
    // Voice notes send immediately on stop (WhatsApp-style) — no staging preview.
    sendPendingFile();
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
  const opt = {
    id: state.optimisticSeq--,
    _optimistic: true,
    wa_id: waId,
    direction: 'out',
    status: 'pending',
    created_at: new Date().toISOString(),
    wa_timestamp: new Date().toISOString(),
    ...fields,
  };
  t.byId.set(opt.id, opt);
  t.order.push(opt.id);
  renderMessages();
  scrollMessagesToBottom();
  return opt;
}

// Replace an optimistic bubble with the server's persisted row (or mutate it).
function settleOptimistic(waId, opt, patch, persisted) {
  const t = thread(waId);
  t.byId.delete(opt.id);
  const idx = t.order.indexOf(opt.id);
  if (idx > -1) t.order.splice(idx, 1);
  const row = persisted || { ...opt, ...patch };
  t.byId.set(row.id, row);
  t.order.push(row.id);
  if (typeof row.id === 'number' && row.id > t.lastMsgId) t.lastMsgId = row.id;
  mergeMessages(t, []); // re-sort
  renderMessages();
}

els.composerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.sending || !state.activeWaId) return;
  const waId = state.activeWaId;

  // If a file is staged, send media; otherwise send text.
  if (state.pendingFile) return sendPendingFile();

  const text = els.composerInput.value.trim();
  if (!text) return;

  const opt = addOptimistic(waId, { type: 'text', body: text });
  els.composerInput.value = '';
  delete state.drafts[waId]; // sent → no lingering draft
  autoGrow();
  state.sending = true;
  els.sendBtn.disabled = true;
  clearBanner();

  const { ok, status, data } = await api('/api/send', {
    method: 'POST',
    body: JSON.stringify({ wa_id: waId, text }),
  });

  state.sending = false;
  els.sendBtn.disabled = !els.composerInput.value.trim();
  if (status === 401) return handleAuthLost();

  if (ok && data.message) {
    settleOptimistic(waId, opt, null, data.message);
    scrollMessagesToBottom();
    bumpConversationPreview(waId, text, 'out');
  } else if (status === 207) {
    settleOptimistic(waId, opt, { _optimistic: false, status: 'sent' });
    toast(data.warning || 'Sent, but not saved.');
  } else {
    // keep the failed bubble retryable: re-POST the same text on retry
    settleOptimistic(waId, opt, {
      _optimistic: false, status: 'failed', error: data.error || 'Failed to send.',
      _retry: { endpoint: '/api/send', payload: { wa_id: waId, text } },
    });
    setBanner(data.error || 'Failed to send. Check the connection and try again.');
  }
});

function bumpConversationPreview(waId, text, direction) {
  const conv = state.conversations.find((c) => c.wa_id === waId);
  if (conv) {
    conv.last_message_text = text;
    conv.last_message_at = new Date().toISOString();
    conv.last_message_direction = direction || 'out';
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

/* --------------------------- back (mobile) --------------------------- */

els.backBtn.addEventListener('click', () => {
  saveDraft(); // keep the unsent text for when this chat is reopened
  els.app.dataset.view = 'list';
  state.activeWaId = null;
  stopThreadPolling();
  els.thread.hidden = true;
  els.placeholder.hidden = false;
  renderConversations();
});

/* ----------------------------- polling ----------------------------- */

function startListPolling() {
  stopListPolling();
  state.listTimer = setInterval(() => {
    if (document.hidden) return;
    refreshConversations();
  }, LIST_POLL_MS);
}
function stopListPolling() {
  if (state.listTimer) clearInterval(state.listTimer);
  state.listTimer = null;
}
function startThreadPolling() {
  stopThreadPolling();
  state.threadTimer = setInterval(() => {
    if (document.hidden || !state.activeWaId) return;
    loadThread(false);
  }, THREAD_POLL_MS);
}
function stopThreadPolling() {
  if (state.threadTimer) clearInterval(state.threadTimer);
  state.threadTimer = null;
}

// Pause/refresh on tab visibility for efficiency + instant freshness.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    setConn('stale');
  } else if (!els.app.hidden) {
    setConn('live');
    refreshConversations();
    if (state.activeWaId) loadThread(false);
  }
});

function handleAuthLost() {
  stopListPolling();
  stopThreadPolling();
  toast('Session expired — please log in again.', true);
  showLogin();
}

/* ----------------------- new conversation ----------------------- */

function openNewChatModal() {
  els.newChatError.hidden = true;
  els.newChatNumber.value = '';
  els.newChatName.value = '';
  els.newChatModal.hidden = false;
  setTimeout(() => els.newChatNumber.focus(), 50);
}
function closeNewChatModal() { els.newChatModal.hidden = true; }

els.newChatBtn.addEventListener('click', openNewChatModal);
els.newChatCancel.addEventListener('click', closeNewChatModal);
els.newChatModal.addEventListener('click', (e) => {
  if (e.target === els.newChatModal) closeNewChatModal();
});

els.newChatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.newChatError.hidden = true;
  const raw = els.newChatNumber.value;
  const digits = (raw || '').replace(/[^0-9]/g, '');
  if (digits.length < 8) {
    els.newChatError.textContent = 'Enter a valid phone number with country code.';
    els.newChatError.hidden = false;
    return;
  }
  const { ok, status, data } = await api('/api/start-conversation', {
    method: 'POST',
    body: JSON.stringify({ wa_id: digits, name: els.newChatName.value }),
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
  if (!state.conversations.find((c) => c.wa_id === data.wa_id)) {
    state.conversations.unshift({
      wa_id: data.wa_id,
      profile_name: els.newChatName.value.trim() || null,
      last_message_text: '', last_message_at: new Date().toISOString(),
      last_message_direction: 'out', unread_count: 0,
    });
  }
  openConversation(data.wa_id);
});

// Escape closes the modal.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.newChatModal.hidden) closeNewChatModal();
});

/* ----------------------- forward message ----------------------- */

// Open the destination picker for a message. Media must be stored to forward;
// if it isn't (pending/failed), show a clear inline message instead.
function openForwardModal(m) {
  if (m.type && m.type !== 'text' && (m.media_status !== 'stored' || (!m.media_path && !m._localUrl))) {
    // _localUrl alone (optimistic) has no server-stored copy yet either.
    toast('This media isn’t stored yet, so it can’t be forwarded.', true);
    return;
  }
  state.forward = { msgId: m.id, srcWaId: m.wa_id || state.activeWaId, selected: new Set(), search: '' };
  els.forwardError.hidden = true;
  els.forwardSearch.value = '';
  els.forwardModal.hidden = false;
  renderForwardList();
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
  const q = (f.search || '').trim().toLowerCase();
  // All existing conversations except the source chat (forwarding to itself is
  // pointless). New numbers are handled by the existing New-conversation flow.
  let list = state.conversations.filter((c) => c.wa_id !== f.srcWaId);
  if (q) {
    list = list.filter((c) =>
      displayName(c).toLowerCase().includes(q) || (c.wa_id || '').includes(q)
    );
  }
  els.forwardEmpty.hidden = list.length > 0;
  els.forwardList.innerHTML = list.map((c) => {
    const sel = f.selected.has(c.wa_id) ? ' selected' : '';
    return `
      <button type="button" class="forward-opt${sel}" data-wa="${escapeHtml(c.wa_id)}">
        <span class="avatar">${escapeHtml(initials(c.profile_name, c.wa_id))}</span>
        <span class="fo-name">${escapeHtml(displayName(c))}</span>
        <span class="fo-check">${f.selected.has(c.wa_id) ? '✓' : ''}</span>
      </button>`;
  }).join('');
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
  renderForwardList();
});

els.forwardCancel.addEventListener('click', closeForwardModal);
els.forwardModal.addEventListener('click', (e) => {
  if (e.target === els.forwardModal) closeForwardModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.forwardModal.hidden) closeForwardModal();
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

/* ----------------------------- start ----------------------------- */
boot();
