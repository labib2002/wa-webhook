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
  newChatBtn: $('#new-chat-btn'),
  newChatModal: $('#new-chat-modal'),
  newChatForm: $('#new-chat-form'),
  newChatNumber: $('#new-chat-number'),
  newChatName: $('#new-chat-name'),
  newChatError: $('#new-chat-error'),
  newChatCancel: $('#new-chat-cancel'),
  toast: $('#toast'),
};

const state = {
  conversations: [],      // latest list snapshot
  filter: '',
  activeWaId: null,
  threads: {},            // wa_id -> { byId: Map(id->msg), order: [ids], lastMsgId, loaded }
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
  let list = state.conversations;
  if (q) {
    list = list.filter((c) =>
      displayName(c).toLowerCase().includes(q) || (c.wa_id || '').includes(q)
    );
  }

  // Skip the DOM rebuild if nothing the list shows has changed — avoids
  // flicker, lost hover, and wasted work on every 4s poll.
  const sig = state.activeWaId + '|' + q + '|' + list.map((c) =>
    `${c.wa_id}:${c.last_message_at}:${c.unread_count}:${c.last_message_text}:${c.profile_name || ''}:${c.last_message_direction || ''}`
  ).join(';');
  if (!forceRender && sig === _lastConvSig) return;
  _lastConvSig = sig;

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
  resetComposer();

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
  return [m.id, m.status, m.reaction, m.media_status, m._optimistic ? 1 : 0, continued ? 1 : 0, m.body].join('|');
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

  if (m.status === 'failed' && m.error) {
    const reason = document.createElement('span');
    reason.className = 'fail-reason';
    reason.textContent = '⚠ ' + m.error;
    div.appendChild(reason);
  }

  // Reaction emoji (customer reacted to one of our messages) — a small pill
  // pinned to the bubble's bottom edge, WhatsApp-style.
  if (m.reaction) {
    const r = document.createElement('span');
    r.className = 'reaction-pill';
    r.textContent = m.reaction;
    div.appendChild(r);
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
  autoGrow();
  refreshSendEnabled();
}

els.composerInput.addEventListener('input', () => {
  autoGrow();
  refreshSendEnabled();
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
    settleOptimistic(waId, opt, { _optimistic: false, status: 'failed', error: data.error || 'Failed to send.' });
    setBanner(data.error || 'Failed to send attachment.');
  }
}

/* --------------------- voice note recording --------------------- */
// Record audio in the browser via MediaRecorder, then send it through the
// existing media path. Heads-up: WhatsApp renders uploaded audio as a regular
// audio message on the customer's phone (not its native push-to-talk bubble) —
// a Cloud API limitation. In our dashboard it shows with the voice player.

// Pick a recording mime that WhatsApp will ACCEPT. WhatsApp's audio allow-list
// is aac/mp4/mpeg/amr/ogg/opus — NOT webm. Browsers differ: Chrome/Edge/Safari
// can record audio/mp4; Firefox records audio/ogg;codecs=opus. We deliberately
// never fall back to webm (WhatsApp rejects it). Returns null if the browser
// can only do webm, so the caller can decline gracefully.
function pickRecorderMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = [
    'audio/mp4',                 // Chrome (Win/Android), Edge, Safari -> accepted as audio/mp4
    'audio/mp4;codecs=mp4a.40.2',
    'audio/ogg;codecs=opus',     // Firefox -> accepted as audio/ogg
    'audio/ogg',
    'audio/aac',
  ];
  for (const m of candidates) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
  }
  return null; // only webm available -> not acceptable to WhatsApp
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
  const mime = pickRecorderMime();
  if (!mime) {
    // Only webm is available here, which WhatsApp won't accept. Decline cleanly
    // rather than record something that will fail to send.
    stream.getTracks().forEach((t) => t.stop());
    setBanner('Voice notes aren’t supported in this browser. Try Chrome, Edge, or Safari, or attach an audio file.');
    return;
  }
  let mediaRecorder;
  try {
    mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
  } catch (_) {
    stream.getTracks().forEach((t) => t.stop());
    setBanner('Could not start recording in a supported format.');
    return;
  }
  const chunks = [];
  mediaRecorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) chunks.push(e.data); });

  const startedAt = performance.now();
  const rec = { mediaRecorder, stream, chunks, startedAt, timer: null, canceled: false, requestedMime: mime };
  state.rec = rec;

  mediaRecorder.addEventListener('stop', () => finishRecording(rec));

  // live timer; auto-stop at 5 min as a safety cap
  els.recTime.textContent = '0:00';
  rec.timer = setInterval(() => {
    const elapsed = performance.now() - startedAt;
    els.recTime.textContent = fmtRecTime(elapsed);
    if (elapsed > 5 * 60 * 1000) stopRecording();
  }, 200);

  showRecBar(true);
  mediaRecorder.start();
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

  const fullMime = rec.mediaRecorder.mimeType || rec.requestedMime || 'audio/mp4';
  // Send WhatsApp the bare type (no ";codecs=..."), and map ogg/opus -> audio/ogg
  // which is the value on their allow-list.
  let mime = fullMime.split(';')[0].trim().toLowerCase();
  if (mime === 'audio/opus') mime = 'audio/ogg';
  const blob = new Blob(rec.chunks, { type: fullMime });
  if (!blob.size) { setBanner('Nothing was recorded.'); return; }
  if (blob.size > 25 * 1024 * 1024) { setBanner('Recording too large (max 25 MB).'); return; }

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const base64 = String(dataUrl).split(',')[1] || '';
    const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : mime.includes('aac') ? 'aac' : 'm4a';
    state.pendingFile = {
      name: `voice-note.${ext}`, mime, size: blob.size, base64, dataUrl, voice: true,
    };
    // Voice notes send immediately on stop (WhatsApp-style) — no staging preview.
    sendPendingFile();
  };
  reader.readAsDataURL(blob);
}

els.micBtn.addEventListener('click', startRecording);
els.recSend.addEventListener('click', stopRecording);
els.recCancel.addEventListener('click', cancelRecording);

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
    settleOptimistic(waId, opt, { _optimistic: false, status: 'failed', error: data.error || 'Failed to send.' });
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

/* ----------------------------- start ----------------------------- */
boot();
