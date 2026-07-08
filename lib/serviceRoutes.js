// Machine-to-machine send API for the Byte+ ops backend (Phase 4).
//
// Auth: `x-service-token` header, timing-safe-compared to SERVICE_SEND_TOKEN.
// This is a SEPARATE gate from the human passcode cookie — the ops backend
// calls this server-side; no cookie, no session. When SERVICE_SEND_TOKEN is
// unset the whole surface answers 503 (explicitly "not configured"), so
// deploying this code changes nothing until the env var is set on Vercel.
//
// Cloud API reality this endpoint lives within (do not "fix" these):
//   - business-initiated sends MUST be pre-approved templates; free-form text
//     is only legal inside the 24h window after the USER's last message.
//   - templates are allow-listed here (WA_TEMPLATE_ALLOWLIST or the ops_
//     prefix) so a compromised caller cannot fire arbitrary marketing sends.
//   - the API cannot create or message WhatsApp GROUPS; group invites go out
//     as individual template messages carrying a manually created group link.

const crypto = require('crypto');
const express = require('express');
const wa = require('./whatsapp');
const { getDb, isConfigured: dbConfigured } = require('./db');

const router = express.Router();

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

router.use((req, res, next) => {
  const expected = process.env.SERVICE_SEND_TOKEN || '';
  if (!expected) {
    return res.status(503).json({ error: 'Service sends are not configured (SERVICE_SEND_TOKEN unset).' });
  }
  const got = req.header('x-service-token') || '';
  if (!safeEqual(got, expected)) {
    return res.status(401).json({ error: 'Invalid service token.' });
  }
  next();
});

function allowedTemplate(name) {
  const list = (process.env.WA_TEMPLATE_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length) return list.includes(name);
  return /^ops_[a-z0-9_]+$/.test(name);
}

// Extract the body-parameter texts for the inbox preview line.
function previewFromComponents(name, components) {
  const texts = [];
  for (const c of components || []) {
    for (const p of c.parameters || []) {
      if (p.type === 'text' && p.text) texts.push(p.text);
    }
  }
  return `📋 [${name}] ${texts.join(' · ')}`.trim();
}

// POST /api/service/send-template
// { to, template, language?, components? } → { ok, waMessageId } | { error }
router.post('/send-template', async (req, res) => {
  const { to, template, language, components } = req.body || {};
  const waId = String(to || '').replace(/\D/g, '');
  if (!waId || waId.length < 8) {
    return res.status(400).json({ error: 'to must be a phone number in international digits.' });
  }
  if (!template || !allowedTemplate(String(template))) {
    return res.status(400).json({ error: `Template '${template}' is not on the allow-list.` });
  }

  const result = await wa.sendTemplate(waId, {
    name: String(template),
    language: language || 'en',
    components: Array.isArray(components) ? components : [],
  });
  if (!result.ok) {
    return res.status(502).json({ error: result.error });
  }

  // Persist into the inbox thread like a human-sent message, so agents see
  // what the machine sent. Failure to persist must not fail the send.
  if (dbConfigured()) {
    try {
      const db = getDb();
      const nowIso = new Date().toISOString();
      const body = previewFromComponents(String(template), components);
      await db
        .from('conversations')
        .upsert(
          { wa_id: waId, last_message_text: body, last_message_at: nowIso, last_message_direction: 'out' },
          { onConflict: 'wa_id' },
        );
      await db.from('messages').insert({
        wa_message_id: result.waMessageId || null,
        wa_id: waId,
        direction: 'out',
        type: 'text',
        body,
        status: 'sent',
        wa_timestamp: nowIso,
      });
    } catch (e) {
      console.error('service send persisted-failed:', e);
    }
  }

  res.json({ ok: true, waMessageId: result.waMessageId || null });
});

// GET /api/service/health — lets the ops backend verify wiring without sending.
router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    whatsapp_configured: wa.isConfigured(),
    db_configured: dbConfigured(),
  });
});

module.exports = router;
