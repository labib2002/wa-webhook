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
  toast: $('#toast'),
};

const state = {
  conversations: [],      // latest list snapshot
  filter: '',
  activeWaId: null,
  messages: [],           // messages in the open thread
  lastMsgId: 0,           // highest message id seen in open thread (for incremental poll)
  sending: false,
  listTimer: null,
  threadTimer: null,
  optimisticSeq: -1,      // negative ids for optimistic bubbles
};

const LIST_POLL_MS = 4000;
const THREAD_POLL_MS = 2500;

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

function renderConversations() {
  const q = state.filter.trim().toLowerCase();
  let list = state.conversations;
  if (q) {
    list = list.filter((c) =>
      displayName(c).toLowerCase().includes(q) || (c.wa_id || '').includes(q)
    );
  }

  if (!list.length) {
    els.convList.innerHTML = '';
    els.convEmpty.hidden = false;
    if (q) {
      els.convEmpty.querySelector('p').textContent = 'No matches';
      els.convEmpty.querySelector('span').textContent = 'Try a different name or number.';
    }
    return;
  }
  els.convEmpty.hidden = true;

  els.convList.innerHTML = list.map((c) => {
    const name = escapeHtml(displayName(c));
    const active = c.wa_id === state.activeWaId ? ' active' : '';
    const unread = c.unread_count > 0 ? ' has-unread' : '';
    const badge = c.unread_count > 99 ? '99+' : c.unread_count;
    const outTick =
      c.last_message_direction === 'out'
        ? '<span class="tick">✓</span> '
        : '';
    return `
      <button class="conv-row${active}${unread}" role="listitem" data-wa="${escapeHtml(c.wa_id)}">
        <span class="avatar">${escapeHtml(initials(c.profile_name, c.wa_id))}</span>
        <span class="row-name">${name}</span>
        <span class="row-time">${escapeHtml(fmtListTime(c.last_message_at))}</span>
        <span class="row-preview">${outTick}${escapeHtml(c.last_message_text || '')}</span>
        <span class="row-badge">${badge}</span>
      </button>`;
  }).join('');
}

els.convList.addEventListener('click', (e) => {
  const row = e.target.closest('.conv-row');
  if (!row) return;
  openConversation(row.dataset.wa);
});

els.search.addEventListener('input', () => {
  state.filter = els.search.value;
  renderConversations();
});

/* --------------------------- open a thread --------------------------- */

async function openConversation(waId) {
  if (!waId) return;
  const conv = state.conversations.find((c) => c.wa_id === waId);
  state.activeWaId = waId;
  state.messages = [];
  state.lastMsgId = 0;

  // header
  els.threadName.textContent = conv ? displayName(conv) : formatPhone(waId);
  els.threadSub.textContent = conv && conv.profile_name ? formatPhone(waId) : 'WhatsApp';
  els.threadAvatar.textContent = initials(conv?.profile_name, waId);

  // view swap
  els.placeholder.hidden = true;
  els.thread.hidden = false;
  els.app.dataset.view = 'thread';
  els.messagesEmpty.hidden = true;
  els.messages.querySelectorAll('.bubble, .day-sep').forEach((n) => n.remove());
  els.threadLoading.hidden = false;
  clearBanner();

  renderConversations(); // reflect active highlight

  await loadThread(true);
  els.threadLoading.hidden = true;
  startThreadPolling();
  els.composerInput.focus();

  // mark read (reset badge locally + server, optional blue ticks)
  if (conv && conv.unread_count > 0) {
    conv.unread_count = 0;
    renderConversations();
    api('/api/mark-read', { method: 'POST', body: JSON.stringify({ wa_id: waId }) })
      .catch(() => {});
  }
}

async function loadThread(initial = false) {
  const waId = state.activeWaId;
  if (!waId) return;
  const after = state.lastMsgId || '';
  const { ok, status, data } = await api(
    `/api/messages?wa_id=${encodeURIComponent(waId)}${after ? `&after=${after}` : ''}`
  );
  if (!ok) {
    if (status === 401) return handleAuthLost();
    if (initial) toast(data.error || 'Could not load messages.', true);
    return;
  }
  const incoming = data.messages || [];
  if (incoming.length) {
    // merge (incremental fetch only returns new ones)
    for (const m of incoming) {
      // replace optimistic twin if the persisted row matches
      state.messages = state.messages.filter(
        (x) => !(x._optimistic && x.body === m.body && x.direction === m.direction)
      );
      state.messages.push(m);
      if (m.id > state.lastMsgId) state.lastMsgId = m.id;
    }
    renderMessages();
    scrollMessagesToBottom();
  } else if (initial && !state.messages.length) {
    els.messagesEmpty.hidden = false;
  }
}

function renderMessages() {
  els.messagesEmpty.hidden = state.messages.length > 0;
  // wipe existing bubbles/separators (keep loading + empty nodes)
  els.messages.querySelectorAll('.bubble, .day-sep').forEach((n) => n.remove());

  const frag = document.createDocumentFragment();
  let lastDay = '';
  let lastDir = '';
  for (const m of state.messages) {
    const iso = m.wa_timestamp || m.created_at;
    const day = iso ? new Date(iso).toDateString() : '';
    if (day && day !== lastDay) {
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.textContent = dayLabel(iso);
      frag.appendChild(sep);
      lastDay = day;
      lastDir = '';
    }
    frag.appendChild(renderBubble(m, m.direction === lastDir));
    lastDir = m.direction;
  }
  els.messages.appendChild(frag);
}

function renderBubble(m, continued) {
  const div = document.createElement('div');
  const dir = m.direction === 'out' ? 'out' : 'in';
  div.className = `bubble ${dir}`;
  if (continued) div.classList.add(dir === 'out' ? 'cont-out' : 'cont-in');
  if (m.status === 'failed') div.classList.add('failed');
  if (m._optimistic) div.classList.add('pending');

  const iso = m.wa_timestamp || m.created_at;
  let inner = '';

  if (m.type && m.type !== 'text') {
    const meta = m.media_meta || {};
    const src = `/api/media/${m.id}`;
    const stored = m.media_status === 'stored';
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
      inner += `<span class="media-label">${m.type === 'voice' ? '🎤 Voice message' : '🎵 Audio'}</span>
        <audio class="media-audio" controls preload="none" src="${src}"></audio>`;
    } else if (stored && m.type === 'document') {
      const fname = escapeHtml(meta.filename || 'Document');
      inner += `<a class="media-doc" href="${src}" target="_blank" rel="noopener" download>
        <span class="doc-ico">📄</span><span class="doc-name">${fname}</span>
        <span class="doc-dl">Download</span>
      </a>`;
    } else {
      // pending / failed / unsupported / non-downloadable → labeled placeholder
      const label = escapeHtml(stripCaption(m.body) || labelForType(m.type));
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

  if (m.status === 'failed' && m.error) {
    const reason = document.createElement('span');
    reason.className = 'fail-reason';
    reason.textContent = '⚠ ' + m.error;
    div.appendChild(reason);
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

/* ----------------------------- composer ----------------------------- */

function autoGrow() {
  const ta = els.composerInput;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
}

function setBanner(msg) {
  els.composerBanner.textContent = msg;
  els.composerBanner.hidden = false;
}
function clearBanner() {
  els.composerBanner.hidden = true;
}

els.composerInput.addEventListener('input', () => {
  autoGrow();
  els.sendBtn.disabled = !els.composerInput.value.trim() || state.sending;
});

els.composerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    els.composerForm.requestSubmit();
  }
});

els.composerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = els.composerInput.value.trim();
  if (!text || state.sending || !state.activeWaId) return;
  const waId = state.activeWaId;

  // optimistic bubble
  const optimistic = {
    id: state.optimisticSeq--,
    _optimistic: true,
    wa_id: waId,
    direction: 'out',
    type: 'text',
    body: text,
    status: 'pending',
    created_at: new Date().toISOString(),
    wa_timestamp: new Date().toISOString(),
  };
  state.messages.push(optimistic);
  renderMessages();
  scrollMessagesToBottom();

  els.composerInput.value = '';
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
    // replace optimistic with the real persisted row
    const i = state.messages.indexOf(optimistic);
    if (i > -1) state.messages[i] = data.message;
    if (data.message.id > state.lastMsgId) state.lastMsgId = data.message.id;
    renderMessages();
    scrollMessagesToBottom();
    bumpConversationPreview(waId, text);
  } else if (status === 207) {
    // sent but not saved — keep bubble, mark as sent, warn
    optimistic._optimistic = false;
    optimistic.status = 'sent';
    renderMessages();
    toast(data.warning || 'Sent, but not saved.');
  } else {
    // failed — mark the bubble failed with the reason
    optimistic._optimistic = false;
    optimistic.status = 'failed';
    optimistic.error = data.error || 'Failed to send.';
    renderMessages();
    setBanner(data.error || 'Failed to send. Check the connection and try again.');
  }
});

function bumpConversationPreview(waId, text) {
  const conv = state.conversations.find((c) => c.wa_id === waId);
  if (conv) {
    conv.last_message_text = text;
    conv.last_message_at = new Date().toISOString();
    conv.last_message_direction = 'out';
    // re-sort: most recent first
    state.conversations.sort((a, b) =>
      new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0)
    );
    renderConversations();
  }
}

/* --------------------------- back (mobile) --------------------------- */

els.backBtn.addEventListener('click', () => {
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

/* ----------------------------- start ----------------------------- */
boot();
