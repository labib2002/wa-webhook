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
      console.error('Webhook ingest error (returning 200 anyway):', e);
    }
  }

  // 3) Always 200 fast.
  res.sendStatus(200);
});

// TEMP PROBE — verify ffmpeg executes on the deployed Vercel runtime. Remove
// before final. Tries: locate binary, run -version, list encoders for libopus,
// and do a real synthetic transcode to ogg/opus in /tmp.
app.get('/__ffprobe', async (_req, res) => {
  const out = {};
  try {
    const ffmpegPath = require('ffmpeg-static');
    const fs = require('fs');
    const os = require('os');
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const run = promisify(execFile);
    out.ffmpegPath = ffmpegPath;
    out.exists = ffmpegPath ? fs.existsSync(ffmpegPath) : false;
    if (out.exists) {
      try { fs.chmodSync(ffmpegPath, 0o755); } catch (e) { out.chmodErr = e.message; }
      try { out.size = fs.statSync(ffmpegPath).size; } catch (_) {}
      try {
        const v = await run(ffmpegPath, ['-version'], { timeout: 10000 });
        out.version = (v.stdout || '').split('\n')[0];
      } catch (e) { out.versionErr = e.message; }
      try {
        const enc = await run(ffmpegPath, ['-hide_banner', '-encoders'], { timeout: 10000 });
        out.hasLibopus = /libopus/.test(enc.stdout || '');
        out.hasOpus = /\bopus\b/.test(enc.stdout || '');
      } catch (e) { out.encErr = e.message; }
      // real transcode: synth 0.5s tone -> ogg/opus in /tmp
      try {
        const tmp = path.join(os.tmpdir(), `probe-${Date.now()}.ogg`);
        const codec = out.hasLibopus ? 'libopus' : 'opus';
        await run(ffmpegPath, ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-c:a', codec, '-y', tmp], { timeout: 15000 });
        out.transcodeBytes = fs.statSync(tmp).size;
        fs.unlinkSync(tmp);
        out.transcodeOk = out.transcodeBytes > 0;
      } catch (e) { out.transcodeErr = e.message; }
    }
  } catch (e) {
    out.fatal = e.message;
  }
  res.json(out);
});

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
