// WhatsApp Graph API calls (the SEND side — separate channel from the webhook).
//
// We read the token + phone number id from env at call time so a freshly
// pasted/rotated token is picked up without a redeploy of this module's state.
// Uses global fetch (Node 18+ / 20 on Vercel).

function graphBase() {
  const version = process.env.GRAPH_API_VERSION || 'v23.0';
  const phoneId = process.env.PHONE_NUMBER_ID;
  return { version, phoneId };
}

function isConfigured() {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.PHONE_NUMBER_ID);
}

// Map Meta's error shapes to a short, agent-friendly message.
function describeGraphError(status, body) {
  const err = body && body.error;
  const code = err && err.code;
  const sub = err && err.error_subcode;
  const msg = (err && err.message) || `WhatsApp API error (HTTP ${status})`;

  // 131047 / re-engagement: outside the 24h customer service window.
  if (code === 131047 || sub === 2018278) {
    return 'Outside the 24-hour reply window — only approved templates can be sent now.';
  }
  // 190: invalid/expired access token.
  if (code === 190 || status === 401) {
    return 'WhatsApp access token is invalid or expired — update WHATSAPP_TOKEN.';
  }
  // 100: often a bad phone number id or malformed recipient.
  if (code === 100) {
    return `WhatsApp rejected the request: ${msg}`;
  }
  return msg;
}

// Send a free-form text message. Returns { ok, waMessageId } or { ok:false, error }.
async function sendText(toWaId, text) {
  if (!isConfigured()) {
    return {
      ok: false,
      error: 'Sending is not configured. Set WHATSAPP_TOKEN and PHONE_NUMBER_ID.',
    };
  }
  const { version, phoneId } = graphBase();
  const url = `https://graph.facebook.com/${version}/${phoneId}/messages`;

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toWaId,
        type: 'text',
        text: { preview_url: false, body: text },
      }),
    });
  } catch (e) {
    return { ok: false, error: `Network error reaching WhatsApp: ${e.message}` };
  }

  let data = null;
  try {
    data = await resp.json();
  } catch (_) {
    /* non-JSON response */
  }

  if (!resp.ok) {
    return { ok: false, error: describeGraphError(resp.status, data), raw: data };
  }
  const waMessageId =
    data && data.messages && data.messages[0] && data.messages[0].id;
  return { ok: true, waMessageId };
}

// Map an outgoing message type to the WhatsApp media category.
function mediaCategory(mime) {
  const m = (mime || '').split(';')[0].toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

// Upload raw bytes to the Graph API, returning a media id we can send.
async function uploadMedia(buffer, mime, filename) {
  if (!isConfigured()) return { ok: false, error: 'Sending is not configured.' };
  const { version, phoneId } = graphBase();
  const url = `https://graph.facebook.com/${version}/${phoneId}/media`;
  try {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime || 'application/octet-stream');
    // Node's global Blob/File via undici; filename matters for documents.
    const blob = new Blob([buffer], { type: mime || 'application/octet-stream' });
    form.append('file', blob, filename || 'upload');
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      body: form,
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) return { ok: false, error: describeGraphError(resp.status, data) };
    return { ok: true, mediaId: data && data.id };
  } catch (e) {
    return { ok: false, error: `Upload failed: ${e.message}` };
  }
}

// Send a media message by uploaded media id. `category` is image|video|audio|document.
async function sendMedia(toWaId, category, mediaId, { caption, filename } = {}) {
  if (!isConfigured()) return { ok: false, error: 'Sending is not configured.' };
  const { version, phoneId } = graphBase();
  const url = `https://graph.facebook.com/${version}/${phoneId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toWaId,
    type: category,
    [category]: { id: mediaId },
  };
  // Captions are allowed on image/video/document (not audio).
  if (caption && category !== 'audio') payload[category].caption = caption;
  if (category === 'document' && filename) payload[category].filename = filename;

  let resp, data;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    data = await resp.json().catch(() => null);
  } catch (e) {
    return { ok: false, error: `Network error reaching WhatsApp: ${e.message}` };
  }
  if (!resp.ok) return { ok: false, error: describeGraphError(resp.status, data) };
  const waMessageId = data && data.messages && data.messages[0] && data.messages[0].id;
  return { ok: true, waMessageId };
}

// Attempt to delete a message on WhatsApp ("delete for everyone").
// NOTE: the Cloud API's support for deleting a previously-sent message is
// limited/undocumented; many setups reject it. We attempt it and report back
// honestly so the UI can say whether the recall actually happened.
async function deleteMessage(waMessageId) {
  if (!isConfigured() || !waMessageId) return { ok: false, supported: false };
  const { version, phoneId } = graphBase();
  const url = `https://graph.facebook.com/${version}/${phoneId}/messages`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'deleted', message_id: waMessageId }),
    });
    if (resp.ok) return { ok: true, supported: true };
    const body = await resp.json().catch(() => null);
    return { ok: false, supported: false, error: describeGraphError(resp.status, body) };
  } catch (e) {
    return { ok: false, supported: false, error: e.message };
  }
}

// Mark a specific inbound message as read (gives the sender blue ticks).
// Best-effort: never throws into the caller's flow.
async function markRead(waMessageId) {
  if (!isConfigured() || !waMessageId) return { ok: false };
  const { version, phoneId } = graphBase();
  const url = `https://graph.facebook.com/${version}/${phoneId}/messages`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: waMessageId,
      }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => null);
      console.warn('mark-as-read rejected:', describeGraphError(resp.status, body));
    }
    return { ok: resp.ok };
  } catch (e) {
    console.warn('mark-as-read error:', e.message);
    return { ok: false };
  }
}

module.exports = { sendText, sendMedia, uploadMedia, mediaCategory, deleteMessage, markRead, isConfigured };
