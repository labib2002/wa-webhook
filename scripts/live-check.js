/* =============================================================================
   Live end-to-end check against the REAL Supabase project.
   Boots the real app in-process, POSTs signed webhook payloads (text + a status
   update), and reads the rows back through the DB. Cleans up after itself.
   Run:  node scripts/live-check.js
   Requires a configured .env (SUPABASE_*, APP_SECRET, PHONE_NUMBER_ID).
   ============================================================================= */

require('dotenv').config();
const http = require('http');
const crypto = require('crypto');
const { getDb } = require('../lib/db');

const TEST_WA = '15550001234';

function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', process.env.APP_SECRET)
    .update(Buffer.from(body)).digest('hex');
}

function post(port, payload) {
  const body = JSON.stringify(payload);
  return fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sign(body) },
    body,
  }).then(async (r) => ({ status: r.status, text: await r.text() }));
}

(async () => {
  if (!process.env.SUPABASE_URL || !process.env.APP_SECRET) {
    console.error('Missing SUPABASE_URL / APP_SECRET in .env'); process.exit(1);
  }
  const db = getDb();
  const app = require('../api/index');
  const srv = http.createServer(app).listen(0);
  const port = srv.address().port;
  let failed = 0;
  const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
  const bad = (m) => { console.log(`  \x1b[31m✗ ${m}\x1b[0m`); failed++; };

  try {
    // clean slate
    await db.from('conversations').delete().eq('wa_id', TEST_WA);

    const wamid = 'wamid.LIVECHECK_' + Date.now();
    // 1) inbound text
    const r1 = await post(port, {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: process.env.PHONE_NUMBER_ID },
        contacts: [{ profile: { name: 'Live Check' }, wa_id: TEST_WA }],
        messages: [{ from: TEST_WA, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'live check message' } }],
      } }] }],
    });
    r1.status === 200 ? ok('inbound POST → 200') : bad(`inbound POST → ${r1.status}`);

    await new Promise((r) => setTimeout(r, 400)); // let writes settle

    const conv = await db.from('conversations').select('*').eq('wa_id', TEST_WA).maybeSingle();
    conv.data ? ok(`conversation row created (name="${conv.data.profile_name}", unread=${conv.data.unread_count})`)
              : bad('conversation row NOT created');

    const msg = await db.from('messages').select('*').eq('wa_message_id', wamid).maybeSingle();
    msg.data ? ok(`message row created (body="${msg.data.body}", status=${msg.data.status})`)
             : bad('message row NOT created');

    // 2) idempotency
    await post(port, {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: process.env.PHONE_NUMBER_ID },
        contacts: [{ profile: { name: 'Live Check' }, wa_id: TEST_WA }],
        messages: [{ from: TEST_WA, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'live check message' } }],
      } }] }],
    });
    await new Promise((r) => setTimeout(r, 300));
    const dupe = await db.from('messages').select('id', { count: 'exact', head: true }).eq('wa_message_id', wamid);
    dupe.count === 1 ? ok('idempotent: still exactly 1 row after re-POST') : bad(`idempotency broken: ${dupe.count} rows`);

    // 3) bad signature rejected
    const bodyBad = JSON.stringify({ entry: [] });
    const rbad = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=bad' }, body: bodyBad,
    });
    rbad.status === 401 ? ok('bad signature → 401') : bad(`bad signature → ${rbad.status}`);

    // cleanup
    await db.from('conversations').delete().eq('wa_id', TEST_WA);
    ok('cleaned up test rows');
  } catch (e) {
    bad('threw: ' + e.message);
  } finally {
    srv.close();
    console.log(failed ? `\n\x1b[31m${failed} check(s) failed\x1b[0m\n` : '\n\x1b[32mAll live checks passed\x1b[0m\n');
    process.exit(failed ? 1 : 0);
  }
})();
