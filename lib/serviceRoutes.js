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
const idem = require('./idempotency');
const { sendTemplateFlow } = require('./templateSend');
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

// POST /api/service/send-template
// { to, template, language?, components? } → { ok, waMessageId } | { error }
//
// Idempotency: callers should pass a STABLE key per logical send (header
// `x-idempotency-key` or body `client_key`, max 128 chars) — e.g. one UUID
// per invite, reused on every retry of that invite. A replayed key returns
// { ok, deduped: true, id, waMessageId } from the original row and does NOT
// send again, unless that row is 'failed' and never reached Meta — then the
// replay really does re-send onto it (see lib/templateSend.js). Migration 007
// is live in production, so this is active; a caller that sends no key still
// gets the old send-every-time behaviour.
router.post('/send-template', async (req, res) => {
  const { to, template, language, components } = req.body || {};
  const waId = String(to || '').replace(/\D/g, '');
  if (!waId || waId.length < 8) {
    return res.status(400).json({ error: 'to must be a phone number in international digits.' });
  }
  if (!template || !allowedTemplate(String(template))) {
    return res.status(400).json({ error: `Template '${template}' is not on the allow-list.` });
  }

  const { key, invalid } = idem.keyFromRequest(req);
  if (invalid) return res.status(400).json({ error: invalid });

  const { status, body } = await sendTemplateFlow(dbConfigured() ? getDb() : null, {
    waId,
    template: String(template),
    language,
    components,
    key,
  });
  res.status(status).json(body);
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
