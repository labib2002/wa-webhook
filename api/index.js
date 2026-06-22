require('dotenv').config();
const path = require('path');
const express = require('express');

const { checkSignature } = require('../lib/signature');
const { ingestWebhook } = require('../lib/ingest');
const apiRouter = require('../lib/routes');

const app = express();

// Capture the raw request body so we can verify Meta's X-Hub-Signature-256.
// (Meta signs the exact bytes it sent; we must hash those, not a re-encode.)
app.use(
  express.json({
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
      console.error('Webhook ingest error (returning 200 anyway):', e);
    }
  }

  // 3) Always 200 fast.
  res.sendStatus(200);
});

// ---------------------------------------------------------------------------
//  Dashboard API (passcode-gated inside the router) + static SPA.
// ---------------------------------------------------------------------------
app.use('/api', apiRouter);

// Serve the dashboard SPA and its assets from /public.
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// The dashboard lives at /app (a single HTML file; the gate is the API, the
// page itself shows a login screen until /api/login succeeds).
app.get('/app', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

module.exports = app;
