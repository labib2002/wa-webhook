require('dotenv').config();
const path = require('path');
const express = require('express');

const { checkSignature } = require('../lib/signature');
const { ingestWebhook } = require('../lib/ingest');
const apiRouter = require('../lib/routes');
const serviceRouter = require('../lib/serviceRoutes');
const maintenance = require('../lib/maintenance');

const app = express();

// Body parsing is scoped per path, not global. A 30mb parse mounted above the
// signature check put the largest allocation in the process on the public
// unauthenticated path, and the ALB in front of this has no WAF and no rate
// limiting. Meta's own payloads are a few KB.
const webhookJson = express.json({
  limit: '256kb',
  // Capture the raw bytes so we can verify Meta's X-Hub-Signature-256.
  // (Meta signs the exact bytes it sent; we must hash those, not a re-encode.)
  verify: (req, _res, buf) => { req.rawBody = buf; },
});
const smallJson = express.json({ limit: '1mb' });
// Only the composer's base64 media upload needs the big ceiling.
const largeJson = express.json({ limit: '30mb' });

// ---------------------------------------------------------------------------
//  Webhook — UNCHANGED public path. Meta's Callback URL stays the same.
// ---------------------------------------------------------------------------

// GET / — Meta verification handshake (echo hub.challenge for the right token).
app.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// POST / — incoming WhatsApp events.
// 1) verify signature, 2) persist (fast), 3) return 200.
app.post('/', webhookJson, async (req, res) => {
  // 1) Signature check (skipped only if APP_SECRET isn't set yet).
  const sig = checkSignature(req);
  if (sig === 'invalid') {
    console.warn('Rejected webhook POST: bad X-Hub-Signature-256');
    return res.sendStatus(401);
  }
  if (sig === 'skipped') {
    console.warn('APP_SECRET not set — skipping webhook signature verification.');
  }

  // 2) Persist, awaited so the data is durable before we answer.
  try {
    const summary = await ingestWebhook(req.body || {});
    if (summary.messages || summary.statuses) {
      console.log(
        `Webhook ok: ${summary.messages} message(s), ${summary.statuses} status(es).`
      );
    }
  } catch (e) {
    if (e && e.code === 'DB_NOT_CONFIGURED') {
      // Deliberate 200: a retry cannot fix a missing DATABASE_URL, and this is
      // loud in the logs already.
      console.warn('Webhook received but DB not configured — event not stored.');
      return res.sendStatus(200);
    }
    // INBOUND_DROPPED: this inbound event was NOT stored. Answer 500 so Meta
    // redelivers it — the upsert is idempotent on wa_message_id, so the retry
    // is free and cannot duplicate. A 200 here told Meta we had it and the
    // message was gone for good.
    let payload = '';
    try {
      payload = JSON.stringify(req.body).slice(0, 8000);
    } catch {
      payload = '[unserializable]';
    }
    console.error('INBOUND_DROPPED webhook ingest error (returning 500 for redelivery):', e, 'payload:', payload);
    return res.sendStatus(500);
  }

  // 3) 200 fast.
  res.sendStatus(200);
});

// ---------------------------------------------------------------------------
//  Service API (token-gated, machine callers) — mounted BEFORE the passcode
//  router so /api/service/* never hits the cookie gate.
// ---------------------------------------------------------------------------
app.use('/api/service', smallJson, serviceRouter);

// Daily maintenance cron (retention + usage alert), also BEFORE the passcode
// router. Own auth: CRON_SECRET bearer, else the service token (never open).
app.get('/api/cron/maintenance', maintenance);

// ---------------------------------------------------------------------------
//  Dashboard API (passcode-gated inside the router) + static SPA.
// ---------------------------------------------------------------------------
// The composer's base64 upload is the only body that needs 30mb, and it sits
// behind requireAuth inside the router.
app.use('/api/send-media', largeJson);
app.use('/api', smallJson, apiRouter);

// Serve the dashboard SPA assets under /static.
// Two Vercel gotchas this avoids:
//   1) a top-level public/ dir is auto-served as static, shadowing the function;
//   2) a URL that matches a root file (e.g. /app.js -> the root app.js entry)
//      is served as that static file, shadowing the function.
// Mounting assets under /static keeps every path unambiguous and routed through
// Express, so the GET / handshake and /api/* stay on the function.
const webDir = path.join(__dirname, '..', 'web');
app.use('/static', express.static(webDir));

// The dashboard HTML lives at /app (the gate is the API; the page shows a login
// screen until /api/login succeeds).
app.get('/app', (_req, res) => {
  res.sendFile(path.join(webDir, 'index.html'));
});

module.exports = app;
