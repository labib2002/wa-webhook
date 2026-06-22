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
    return { ok: resp.ok };
  } catch (_) {
    return { ok: false };
  }
}

module.exports = { sendText, markRead, isConfigured };
