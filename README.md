# Agent Inbox - WhatsApp Business webhook + dashboard

A WhatsApp Business Cloud API **webhook receiver** plus a WhatsApp-Web-style
**agent dashboard** where a human reads incoming messages and replies in
near-real-time. Node.js + Express, deployed on Vercel, backed by Supabase
Postgres.

- **Receive:** Meta POSTs incoming messages/statuses to the webhook → they are
  persisted to Postgres.
- **Read & reply:** a responsive single-page dashboard lists conversations,
  shows each thread as chat bubbles, and sends replies via the Graph API.

```
WhatsApp user ──▶ Meta ──▶  POST /  (webhook)  ──▶  Supabase (Postgres)
                                                          ▲
agent's browser ──▶  /app (gated SPA)  ──▶  /api/*  ──────┘
                              │
                              └─ POST /api/send ──▶ Graph API ──▶ WhatsApp user
```

---

## Architecture at a glance

| Concern | Choice | Why |
|---|---|---|
| Server | **Express on Vercel** (kept, not migrated) | The verified webhook already runs here; the dashboard is a single view that needs no SSR/framework. |
| Frontend | **Vanilla SPA** (`web/`), no build step | Easy to audit, zero tooling, served by the function. |
| Database | **Supabase Postgres** (free, no card) | Built-in Postgres; service-role key used server-side only. |
| Live updates | **Smart polling** (list 4s, open thread 2.5s, incremental) | Robust on serverless, no realtime-auth complexity, keeps all customer PII behind the passcode gate. Supabase Realtime is a documented future upgrade - see below. |
| Access control | **Shared passcode** → signed httpOnly cookie, enforced on every `/api/*` route | Minimal but real server-side gate, not just hidden UI. |
| Webhook auth | **`X-Hub-Signature-256`** verified against the app secret | Rejects forged POSTs. Skipped (with a warning) only if `APP_SECRET` is unset. |

### Why polling, not Supabase Realtime?
Realtime is great, but the clean ways to use it here both add cost:
`postgres_changes` won't deliver under our locked-down RLS (no anon read of
customer PII - by design), and Broadcast-from-DB needs an **authenticated**
realtime session (RLS on `realtime.messages`), i.e. custom JWT signing. For a
single-agent inbox, **smart polling** is simpler and just as usable: it fetches
incrementally (only new message ids), pauses when the tab is hidden, and
refreshes instantly on focus. Optimistic send means your own messages appear
immediately. If you later want sub-second pushes, add a Supabase Realtime
subscription in `web/app.js` - the data model already supports it.

---

## Routes

**Webhook (public - Meta's Callback URL is unchanged):**
- `GET /` - verification handshake. Echoes `hub.challenge` (200) for the right
  `hub.verify_token`, else 403.
- `POST /` - verifies the signature, parses `messages` / `contacts` /
  `statuses`, upserts the conversation, inserts messages (idempotent on
  `wa_message_id`), updates delivery/read status, returns **200 fast**.

**Dashboard API (passcode-gated, except login/session):**
- `GET  /api/session` - is this browser logged in? (and is send/DB configured)
- `POST /api/login` - `{ passcode }` → sets the session cookie.
- `POST /api/logout`
- `GET  /api/conversations` - list for the left pane (most recent first).
- `GET  /api/messages?wa_id=…&after=<id>` - thread (incremental).
- `POST /api/send` - `{ wa_id, text }` → Graph API call + persist outgoing row.
- `POST /api/mark-read` - `{ wa_id }` → reset unread; best-effort blue ticks.

**Dashboard UI:** `GET /app`.

**Service API (machine-to-machine, for a trusted backend):**
- `POST /api/service/send` - token-authenticated (timing-safe comparison) send
  endpoint with a template allowlist, so an operations backend can trigger
  WhatsApp messages without a browser session.

---

## Data model (`supabase/schema.sql`)

**conversations** - one row per WhatsApp user (`wa_id` PK): `profile_name`,
`last_message_text`, `last_message_at`, `last_message_direction`,
`unread_count`, `phone_number_id`.

**messages** - one row per message: `wa_message_id` (UNIQUE → idempotent),
`wa_id` (FK), `direction` (`in`/`out`), `type`, `body`, `media_meta` (jsonb),
`media_path` + `media_status` (for stored media), `status`
(`sent`/`delivered`/`read`/`failed`/`received`), `error`, `wa_timestamp`.

RLS is **enabled with no anon policies**; the server uses the service-role key
(which bypasses RLS) for all access, and the anon key is never shipped to the
browser.

---

## Environment variables

Copy `.env.example` → `.env` and fill in. Set the **same** variables in Vercel
(Project → Settings → Environment Variables).

| Variable | Where to get it |
|---|---|
| `VERIFY_TOKEN` | You choose; must match Meta's webhook "Verify token". |
| `WHATSAPP_TOKEN` | Meta dashboard → WhatsApp → **API Setup** (temporary ~24h token; see Tokens). |
| `PHONE_NUMBER_ID` | Same **API Setup** page. |
| `GRAPH_API_VERSION` | Defaults to `v23.0`. |
| `APP_SECRET` | Meta dashboard → **App Settings → Basic → App secret**. |
| `SUPABASE_URL` | Supabase → Project Settings → API → **Project URL**. |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page → secret key (`sb_secret_…` or legacy `service_role`; server-only). |
| `MEDIA_BUCKET` | Storage bucket name for media. Defaults to `wa-media`. |
| `DASHBOARD_PASSCODE` | You choose - the passcode agents type to log in. |
| `SESSION_SECRET` | You choose - long random string. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

---

## Run locally

```bash
npm install
cp .env.example .env        # then fill in values
node app.js                 # http://localhost:3000  (dashboard at /app)
```

Quick handshake check:

```bash
curl "http://localhost:3000/?hub.mode=subscribe&hub.verify_token=<your-verify-token>&hub.challenge=12345"
# -> 12345   (HTTP 200)
```

### Set up the database (once)
1. Create a Supabase project (free, no card).
2. Open **SQL Editor**, paste the entire contents of `supabase/schema.sql`, run.
   (If you ran an older schema, also run the deltas in `supabase/migrations/`:
   `002_media.sql`, `003_reactions.sql`, `005_updated_at.sql`, `006_forwarded.sql`,
   `007_hardening.sql`.)
3. Put `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in `.env` (and Vercel).
4. Create the media bucket: `node scripts/setup-storage.js` (makes a private
   `wa-media` bucket).

### Media handling
Incoming WhatsApp media (image/video/audio/voice/sticker/document) is **not** in
the webhook - only a media **id** is. On receipt, the server:
1. inserts the message row immediately with `media_status='pending'` (so it shows
   a labeled placeholder right away), returns 200, then
2. downloads the bytes from the Graph API (two hops: resolve id → temporary URL →
   fetch with the bearer token) and uploads them to the private `wa-media` bucket,
   flipping the row to `media_status='stored'` with a `media_path`.

The browser loads media through the gated `GET /api/media/:id`, which 302-redirects
to a short-lived **signed URL** (10 min) - bytes never pass through a public key,
and the bucket is private. Images/videos/audio render inline; documents show a
download card; locations link to Google Maps. If a download fails the bubble
falls back to its placeholder (`media_status='failed'`), and the row is never
lost. Voice notes are transcoded server-side to OGG/Opus with bundled
`ffmpeg-static` so they play inline in every browser. Free tier is 1 GB of
storage - upgrade the Supabase plan if you outgrow it.

---

## Tests & verification

```bash
npm test          # 15 checks: handshake 200/403, signature reject, inbound
                  # persistence, idempotency, status ticks, non-text types,
                  # API auth gate. Uses an in-memory DB - no live Supabase needed.

npm run shots     # drives headless Chromium over a seeded dashboard and writes
                  # screenshots/{desktop,mobile}-{list,thread}.png
```

The send path is exercised against a mocked Graph call. **End-to-end sending can
only be fully confirmed once you provide a live `WHATSAPP_TOKEN` and a real user
messages your number within the 24-hour window** (see below).

---

## Deploy (Vercel)

`vercel.json` rewrites all routes to the Express function, so the webhook,
`/api/*`, and `/app` are all served by `api/index.js`.

1. Push to GitHub.
2. Import the repo in Vercel (or `vercel --prod`).
3. Add every env var above in Project → Settings → Environment Variables.
4. The **Callback URL in Meta is unchanged** (`https://<your-app>/`, with the
   verify token you configured).

---

## Operational notes

### 24-hour reply window
WhatsApp only allows **free-form** replies within 24 hours of the user's last
message. Outside that window, only pre-approved **template** messages send, and
the API rejects free-form text. The dashboard surfaces this as a clear inline
error ("Outside the 24-hour reply window…"). Template sending is not built in;
add it if you need to re-engage cold conversations.

### Temporary vs permanent token
The token on Meta's **API Setup** page expires in ~24 hours. When it expires,
sends fail with "access token is invalid or expired" (shown inline). For
production, create a **System User** with a permanent token (Meta Business
Settings → Users → System Users → generate token with `whatsapp_business_messaging`
+ `whatsapp_business_management`) and set it as `WHATSAPP_TOKEN`. No code change -
just swap the env var.

### Webhook reliability
The handler persists and returns 200 quickly. If persistence ever fails it still
returns 200 (logging the error) so Meta doesn't retry and create duplicates;
inbound messages are deduped by `wa_message_id` regardless. A dropped (unstored)
inbound is logged with the tag `INBOUND_DROPPED` — grep the Vercel logs for it.

### Retention & limits
A daily cron (`vercel.json` → `GET /api/cron/maintenance`, 03:00 UTC) keeps the
free-tier footprint in check. **Manual migration step:** run
`supabase/migrations/007_hardening.sql` in the Supabase SQL Editor (same way
002-006 were applied) — until then the app degrades gracefully (in-process
login limiter, idempotency keys ignored, `login_attempts` prune errors logged).

What the cron does each run:
- deletes bucket **bytes** of media older than `MEDIA_RETENTION_DAYS` and flips
  those rows to `media_status='expired'` (message text, `media_meta`, and
  conversations are never deleted; the bubble shows an "expired" placeholder);
- prunes `login_attempts` rows older than 24h;
- measures usage (bucket bytes, walk capped at 20k objects + `messages` row
  count) and, above **70%** of either cap, sends one WhatsApp alert text.

| Variable | Meaning | Default |
|---|---|---|
| `CRON_SECRET` | Cron auth; Vercel sends `Authorization: Bearer <CRON_SECRET>` on cron calls. If unset, the endpoint requires `x-service-token` = `SERVICE_SEND_TOKEN` instead (never open). | unset |
| `MEDIA_RETENTION_DAYS` | Days to keep stored media bytes; `0` disables retention. | `90` |
| `MEDIA_CAP_MB` | Media usage cap the 70% alert is measured against. | `1000` |
| `MESSAGES_CAP_ROWS` | `messages` row-count cap for the alert. | `400000` |
| `WA_USAGE_ALERT_TO` | WhatsApp number (international digits) that receives the alert; empty = no alert. | unset |

Related hardening in the same migration: `POST /api/login` is rate limited
(5 failed tries per IP, 50 global, per 15 min → 429) via the `login_attempts`
table, and outbound sends (`/api/send`, `/api/send-media`,
`/api/service/send-template`) accept an idempotency key
(`x-idempotency-key` header or `client_key` body field, max 128 chars) that
dedupes replays via `messages.client_key` instead of double-sending.
