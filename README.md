# wa-webhook

Minimal WhatsApp Business Cloud API webhook receiver (Node.js + Express).

- `GET /` — Meta verification handshake. Echoes `hub.challenge` with 200 when
  `hub.mode === 'subscribe'` and `hub.verify_token` matches `VERIFY_TOKEN`; otherwise 403.
- `POST /` — logs the incoming JSON event (prettified) and replies 200.

## Run locally

```bash
npm install
node app.js          # listens on PORT (default 3000)
```

Create a `.env` with:

```
VERIFY_TOKEN=vibecode123
```

Verify:

```bash
curl "http://localhost:3000/?hub.mode=subscribe&hub.verify_token=vibecode123&hub.challenge=12345"
# -> 12345  (HTTP 200)
```

## Deploy permanently to Render.com

This repo includes a `render.yaml` Blueprint.

1. Push this folder to a GitHub repository.
2. In the Render dashboard: **New → Blueprint**, and point it at the repo.
3. Render reads `render.yaml` and creates the `wa-webhook` web service.
4. When prompted, set the `VERIFY_TOKEN` environment variable (it is marked
   `sync: false`, so it is not stored in the repo). Use `vibecode123`, or any
   value — just use the same one in the Meta dashboard.
5. After the first deploy, your permanent URL is `https://<service-name>.onrender.com`.
   Use that as the Callback URL in Meta instead of the temporary tunnel URL.

Render injects `PORT` automatically; `app.js` already reads `process.env.PORT`.

> Note: Render's free plan spins the service down after inactivity, so the first
> request after idle may be slow. Meta's verification retries, so this is usually fine.
