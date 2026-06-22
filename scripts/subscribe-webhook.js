/* =============================================================================
   Subscribe this app to the WABA's webhook fields (so incoming messages are
   delivered to the webhook) and verify. Verifying the Callback URL is separate
   from subscribing — this does the subscription.

   Usage:  node scripts/subscribe-webhook.js <WABA_ID>
   Reads WHATSAPP_TOKEN + GRAPH_API_VERSION from .env.
   ============================================================================= */

require('dotenv').config();

const WABA = process.argv[2];
const v = process.env.GRAPH_API_VERSION || 'v23.0';
const tok = process.env.WHATSAPP_TOKEN;

if (!WABA) {
  console.error('Usage: node scripts/subscribe-webhook.js <WABA_ID>');
  process.exit(1);
}

const base = `https://graph.facebook.com/${v}/${WABA}/subscribed_apps`;
const auth = { Authorization: `Bearer ${tok}` };

(async () => {
  // 1) current state
  let r = await fetch(base, { headers: auth });
  let j = await r.json();
  console.log('--- BEFORE: subscribed_apps ---');
  console.log(r.status, JSON.stringify(j, null, 1));

  // 2) subscribe (idempotent). Defaults to subscribing the app behind the token.
  r = await fetch(base, { method: 'POST', headers: auth });
  j = await r.json();
  console.log('\n--- SUBSCRIBE result ---');
  console.log(r.status, JSON.stringify(j));

  // 3) verify
  r = await fetch(base, { headers: auth });
  j = await r.json();
  console.log('\n--- AFTER: subscribed_apps ---');
  console.log(r.status, JSON.stringify(j, null, 1));

  const apps = (j && j.data) || [];
  const ok = apps.length > 0;
  console.log(ok
    ? '\n✓ App is subscribed. Now send a WhatsApp to the business number and watch the dashboard.'
    : '\n✗ No subscribed apps found — the subscription did not take. Check token scopes / WABA id.');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
