require('dotenv').config();
const path = require('path');
const express = require('express');

const { checkSignature } = require('../lib/signature');
const { ingestWebhook } = require('../lib/ingest');
const apiRouter = require('../lib/routes');
const serviceRouter = require('../lib/serviceRoutes');
const maintenance = require('../lib/maintenance');

const app = express();

// Capture the raw request body so we can verify Meta's X-Hub-Signature-256.
// (Meta signs the exact bytes it sent; we must hash those, not a re-encode.)
app.use(
  express.json({
    // base64-encoded media uploads from the composer can be several MB.
    limit: '30mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

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
app.post('/', async (req, res) => {
  // 1) Signature check (skipped only if APP_SECRET isn't set yet).
  const sig = checkSignature(req);
  if (sig === 'invalid') {
    console.warn('Rejected webhook POST: bad X-Hub-Signature-256');
    return res.sendStatus(401);
  }
  if (sig === 'skipped') {
    console.warn('APP_SECRET not set — skipping webhook signature verification.');
  }

  // 2) Persist. We await the (fast) DB writes so data is durable BEFORE we
  //    return 200 — on Vercel a fire-and-forget write can be frozen after the
  //    response and lost. If persistence fails we still return 200 so Meta
  //    doesn't hammer us with retries; the error is logged for inspection.
  try {
    const summary = await ingestWebhook(req.body || {});
    if (summary.messages || summary.statuses) {
      console.log(
        `Webhook ok: ${summary.messages} message(s), ${summary.statuses} status(es).`
      );
    }
  } catch (e) {
    if (e && e.code === 'DB_NOT_CONFIGURED') {
      console.warn('Webhook received but DB not configured — event not stored.');
    } else {
      // INBOUND_DROPPED: this inbound event was NOT stored (we still 200 so
      // Meta won't retry). Grep Vercel logs for this tag to find silent loss.
      console.error('INBOUND_DROPPED webhook ingest error (returning 200 anyway):', e);
    }
  }

  // 3) Always 200 fast.
  res.sendStatus(200);
});

// ---------------------------------------------------------------------------
//  Service API (token-gated, machine callers) — mounted BEFORE the passcode
//  router so /api/service/* never hits the cookie gate.
// ---------------------------------------------------------------------------
app.use('/api/service', serviceRouter);

// Daily maintenance cron (retention + usage alert), also BEFORE the passcode
// router. Own auth: CRON_SECRET bearer, else the service token (never open).
app.get('/api/cron/maintenance', maintenance);

// ---------------------------------------------------------------------------
//  Dashboard API (passcode-gated inside the router) + static SPA.
// ---------------------------------------------------------------------------
app.use('/api', apiRouter);

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
