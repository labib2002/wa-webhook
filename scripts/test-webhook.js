/* =============================================================================
   Self-contained test suite (no live DB needed).
   Run: npm test
   Covers: handshake 200/403, signature rejection, inbound persistence,
   idempotency, status updates, non-text types, and the API auth gate.
   ============================================================================= */

const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const { makeFakeDb } = require('./fake-db');

// ---- test env (set BEFORE requiring the app/modules) ----
// Force a hermetic environment: blank out any real DB creds from .env so the
// suite NEVER touches a live database.
process.env.VERIFY_TOKEN = 'vibecode123';
process.env.APP_SECRET = 'test_app_secret';
process.env.SESSION_SECRET = 'test_session_secret_0123456789';
process.env.DASHBOARD_PASSCODE = 'letmein';
process.env.NODE_ENV = 'test';
// Empty (not delete): dotenv won't override an already-present key, so this
// survives the dotenv.config() inside api/index.js and keeps the DB unconfigured.
process.env.DATABASE_URL = '';

const { ingestWebhook, describeMessage, __setMediaFetcher } = require('../lib/ingest');

let passed = 0, failed = 0;
function ok(name) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function bad(name, e) { console.log(`  \x1b[31m✗ ${name}\x1b[0m\n    ${e && e.message || e}`); failed++; }
async function test(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

// ---- sample payloads ----
function inboundText(text, id = 'wamid.TEXT1') {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_ID',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550000000', phone_number_id: 'PNID_123' },
          contacts: [{ profile: { name: 'Ada Lovelace' }, wa_id: '201001234567' }],
          messages: [{
            from: '201001234567',
            id,
            timestamp: '1718000000',
            type: 'text',
            text: { body: text },
          }],
        },
      }],
    }],
  };
}

function inboundImage(id = 'wamid.IMG1') {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'PNID_123' },
      contacts: [{ profile: { name: 'Ada Lovelace' }, wa_id: '201001234567' }],
      messages: [{
        from: '201001234567', id, timestamp: '1718000100', type: 'image',
        image: { id: 'MEDIA_9', mime_type: 'image/jpeg', caption: 'a graph' },
      }],
    }}]}],
  };
}

function inboundReaction(targetWamid, emoji) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'PNID_123' },
      contacts: [{ profile: { name: 'Ada Lovelace' }, wa_id: '201001234567' }],
      messages: [{
        from: '201001234567', id: 'wamid.REACT_' + Math.random().toString(36).slice(2, 7),
        timestamp: '1718000300', type: 'reaction',
        reaction: { message_id: targetWamid, emoji },
      }],
    }}]}],
  };
}

function statusUpdate(id, status) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'PNID_123' },
      statuses: [{
        id, status, timestamp: '1718000200', recipient_id: '201001234567',
        ...(status === 'failed' ? { errors: [{ code: 131047, title: 'Re-engagement message' }] } : {}),
      }],
    }}]}],
  };
}

// ---- HTTP helpers against the real Express app ----
function startServer() {
  const app = require('../api/index');
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, () => resolve(srv));
  });
}
function req(srv, method, path, { body, headers, redirect } = {}) {
  const port = srv.address().port;
  const payload = body ? JSON.stringify(body) : null;
  const h = { 'Content-Type': 'application/json', ...(headers || {}) };
  return fetch(`http://127.0.0.1:${port}${path}`, { method, headers: h, body: payload, redirect })
    .then(async (r) => ({ status: r.status, text: await r.text(), headers: r.headers }));
}
function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', process.env.APP_SECRET)
    .update(Buffer.from(JSON.stringify(body))).digest('hex');
}

(async function run() {
  console.log('\n\x1b[1mWEBHOOK + INGEST TESTS\x1b[0m');

  const srv = await startServer();

  // --- handshake ---
  await test('GET / handshake: correct token → 200 + raw challenge', async () => {
    const r = await req(srv, 'GET', '/?hub.mode=subscribe&hub.verify_token=vibecode123&hub.challenge=XYZ123');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.text, 'XYZ123');
  });
  await test('GET / handshake: wrong token → 403', async () => {
    const r = await req(srv, 'GET', '/?hub.mode=subscribe&hub.verify_token=NOPE&hub.challenge=XYZ123');
    assert.strictEqual(r.status, 403);
  });

  // --- signature on POST / ---
  await test('POST / with NO signature → 401 (APP_SECRET set)', async () => {
    const r = await req(srv, 'POST', '/', { body: inboundText('hi') });
    assert.strictEqual(r.status, 401);
  });
  await test('POST / with BAD signature → 401', async () => {
    const r = await req(srv, 'POST', '/', { body: inboundText('hi'), headers: { 'x-hub-signature-256': 'sha256=deadbeef' } });
    assert.strictEqual(r.status, 401);
  });
  await test('POST / with VALID signature → 200 (DB not configured, still 200)', async () => {
    const body = inboundText('hi');
    const r = await req(srv, 'POST', '/', { body, headers: { 'x-hub-signature-256': sign(body) } });
    assert.strictEqual(r.status, 200);
  });

  // --- API auth gate ---
  await test('GET /api/conversations without cookie → 401', async () => {
    const r = await req(srv, 'GET', '/api/conversations');
    assert.strictEqual(r.status, 401);
  });
  await test('POST /api/retry/:id without cookie → 401 (gated)', async () => {
    const r = await req(srv, 'POST', '/api/retry/1');
    assert.strictEqual(r.status, 401);
  });
  await test('POST /api/forward without cookie → 401 (gated, not 404)', async () => {
    const r = await req(srv, 'POST', '/api/forward', { body: { message_id: 1, wa_ids: ['201001234567'] } });
    assert.strictEqual(r.status, 401);
  });
  await test('POST /api/send-template without cookie → 401 (gated)', async () => {
    const r = await req(srv, 'POST', '/api/send-template', {
      body: { wa_id: '201001234567', template: 'ops_support_followup', language: 'ar', params: ['Omar', 'Oasis'] },
    });
    assert.strictEqual(r.status, 401);
  });
  await test('POST /api/conversations/:wa_id/read without cookie → 401 (gated)', async () => {
    const r = await req(srv, 'POST', '/api/conversations/201001234567/read', { body: { read: false } });
    assert.strictEqual(r.status, 401);
  });
  await test('POST /api/login wrong passcode → 401', async () => {
    const r = await req(srv, 'POST', '/api/login', { body: { passcode: 'wrong' } });
    assert.strictEqual(r.status, 401);
  });
  await test('POST /api/login correct passcode → 200 + Set-Cookie', async () => {
    const r = await req(srv, 'POST', '/api/login', { body: { passcode: 'letmein' } });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('set-cookie') || '', /wa_session=/);
    assert.match(r.headers.get('set-cookie') || '', /HttpOnly/);
  });

  srv.close();

  // --- ingest logic against fake DB ---
  console.log('\n\x1b[1mPERSISTENCE LOGIC (fake DB)\x1b[0m');
  const db = makeFakeDb();

  // Stub the media fetcher so no real network/storage is touched.
  let mediaCalls = 0;
  __setMediaFetcher(async (mediaId, waId, kind) => {
    mediaCalls++;
    return { path: `${waId}/${kind}/${mediaId}.jpg`, mime: 'image/jpeg', size: 1234 };
  });

  await test('inbound text creates conversation + message, unread = 1', async () => {
    await ingestWebhook(inboundText('Hello there', 'wamid.A'), db);
    assert.strictEqual(db._tables.conversations.length, 1);
    const c = db._tables.conversations[0];
    assert.strictEqual(c.wa_id, '201001234567');
    assert.strictEqual(c.profile_name, 'Ada Lovelace');
    assert.strictEqual(c.last_message_text, 'Hello there');
    assert.strictEqual(c.last_message_direction, 'in');
    assert.strictEqual(c.unread_count, 1);
    assert.strictEqual(db._tables.messages.length, 1);
    assert.strictEqual(db._tables.messages[0].body, 'Hello there');
    assert.strictEqual(db._tables.messages[0].direction, 'in');
    assert.strictEqual(db._tables.messages[0].status, 'received');
  });

  await test('second inbound increments unread to 2', async () => {
    await ingestWebhook(inboundText('You there?', 'wamid.B'), db);
    assert.strictEqual(db._tables.conversations[0].unread_count, 2);
    assert.strictEqual(db._tables.messages.length, 2);
  });

  await test('idempotency: re-deliver same wamid → no duplicate row', async () => {
    const before = db._tables.messages.length;
    await ingestWebhook(inboundText('You there?', 'wamid.B'), db); // same id
    assert.strictEqual(db._tables.messages.length, before, 'duplicate message was inserted');
  });

  await test('non-text (image) → labeled placeholder + media stored', async () => {
    await ingestWebhook(inboundImage('wamid.IMG'), db);
    const msg = db._tables.messages.find((m) => m.wa_message_id === 'wamid.IMG');
    assert.ok(msg, 'image message missing');
    assert.strictEqual(msg.type, 'image');
    assert.ok(msg.body.startsWith('📷 Image'), `got: ${msg.body}`);
    assert.strictEqual(msg.media_meta.caption, 'a graph');
    // media pipeline ran: row was downloaded + marked stored with a path
    assert.strictEqual(msg.media_status, 'stored', `media_status = ${msg.media_status}`);
    assert.ok(msg.media_path && msg.media_path.endsWith('.jpg'), `path = ${msg.media_path}`);
  });

  await test('media idempotency: re-deliver image → no second download', async () => {
    const before = mediaCalls;
    await ingestWebhook(inboundImage('wamid.IMG'), db); // same id, already stored
    assert.strictEqual(mediaCalls, before, 'media was downloaded again');
  });

  await test('media failure → row marked failed, message still present', async () => {
    __setMediaFetcher(async () => { throw new Error('boom'); });
    await ingestWebhook(inboundImage('wamid.IMGFAIL'), db);
    const msg = db._tables.messages.find((m) => m.wa_message_id === 'wamid.IMGFAIL');
    assert.ok(msg, 'failed-media message missing');
    assert.strictEqual(msg.media_status, 'failed');
    // restore the working stub for any later tests
    __setMediaFetcher(async (mediaId, waId, kind) => ({ path: `${waId}/${kind}/${mediaId}.jpg`, mime: 'image/jpeg', size: 1 }));
  });

  await test('reaction attaches emoji to the target message (no new bubble)', async () => {
    // seed an outgoing message the customer will react to
    db._tables.messages.push({
      id: 555, wa_message_id: 'wamid.REACTABLE', wa_id: '201001234567',
      direction: 'out', type: 'text', body: 'thanks!', status: 'delivered',
    });
    const before = db._tables.messages.length;
    await ingestWebhook(inboundReaction('wamid.REACTABLE', '❤️'), db);
    assert.strictEqual(db._tables.messages.length, before, 'reaction created an extra row');
    assert.strictEqual(db._tables.messages.find((m) => m.id === 555).reaction, '❤️');
  });

  await test('reaction bumps the conversation (preview + unread) so the inbox surfaces it', async () => {
    const conv = db._tables.conversations.find((c) => c.wa_id === '201001234567');
    const beforeUnread = conv.unread_count;
    await ingestWebhook(inboundReaction('wamid.REACTABLE', '👍'), db);
    const after = db._tables.conversations.find((c) => c.wa_id === '201001234567');
    assert.strictEqual(after.last_message_text, '👍 Reacted to your message');
    assert.strictEqual(after.last_message_direction, 'in');
    assert.strictEqual(after.unread_count, beforeUnread + 1, 'reaction did not increment unread');
  });

  await test('reaction removal clears the emoji and does NOT bump unread', async () => {
    const conv = db._tables.conversations.find((c) => c.wa_id === '201001234567');
    const beforeUnread = conv.unread_count;
    await ingestWebhook(inboundReaction('wamid.REACTABLE', ''), db);
    const after = db._tables.conversations.find((c) => c.wa_id === '201001234567');
    assert.strictEqual(db._tables.messages.find((m) => m.id === 555).reaction, null);
    assert.strictEqual(after.unread_count, beforeUnread, 'un-reacting should not bump unread');
  });

  await test('voice note (audio.voice=true) labels as Voice message + flags meta.voice', async () => {
    const { body, media_meta } = describeMessage({
      type: 'audio', audio: { id: 'AUD1', mime_type: 'audio/ogg', voice: true },
    });
    assert.strictEqual(body, '🎤 Voice message');
    assert.strictEqual(media_meta.voice, true);
  });

  await test('plain audio (no voice flag) labels as Audio', async () => {
    const { body, media_meta } = describeMessage({
      type: 'audio', audio: { id: 'AUD2', mime_type: 'audio/mpeg' },
    });
    assert.strictEqual(body, '🎵 Audio');
    assert.strictEqual(media_meta.voice, null);
  });

  await test('status update flips an outgoing message tick to "read"', async () => {
    // simulate an outgoing message we previously sent
    db._tables.messages.push({
      id: 999, wa_message_id: 'wamid.OUT', wa_id: '201001234567',
      direction: 'out', type: 'text', body: 'hi back', status: 'sent',
    });
    await ingestWebhook(statusUpdate('wamid.OUT', 'delivered'), db);
    assert.strictEqual(db._tables.messages.find((m) => m.id === 999).status, 'delivered');
    await ingestWebhook(statusUpdate('wamid.OUT', 'read'), db);
    assert.strictEqual(db._tables.messages.find((m) => m.id === 999).status, 'read');
  });

  await test('failed status records the error reason', async () => {
    db._tables.messages.push({
      id: 1000, wa_message_id: 'wamid.OUT2', wa_id: '201001234567',
      direction: 'out', type: 'text', body: 'late reply', status: 'sent',
    });
    await ingestWebhook(statusUpdate('wamid.OUT2', 'failed'), db);
    const m = db._tables.messages.find((x) => x.id === 1000);
    assert.strictEqual(m.status, 'failed');
    assert.ok(m.error && m.error.length, 'no error reason recorded');
  });

  await test('malformed payload (empty entry) does not throw', async () => {
    await ingestWebhook({ entry: [] }, db);
    await ingestWebhook({}, db);
  });

  // --- forward + read/unread routes against an injected fake DB ---
  // These DB-backed routes return 503 under the blanked-Supabase HTTP suite, so
  // we inject a fake DB (like the screenshots harness) and stub the WhatsApp
  // send helpers so no real network is touched.
  // --- phone numbers (pure) ---
  console.log('\n\x1b[1mPHONE NUMBERS\x1b[0m');
  const phone = require('../web/phone');

  await test('Egyptian numbers typed any common way become one wa_id', async () => {
    for (const raw of ['01012345678', '1012345678', '201012345678', '+201012345678', '00201012345678',
      '+20 010 1234 5678', '+2 010 1234 5678', '(+20) 101-234-5678', '010-1234-5678',
      '\u0660\u0661\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668', '\u202a+20 10 1234 5678\u202c']) {
      assert.strictEqual(phone.toWaId(raw), '201012345678', raw);
    }
  });

  await test('Egyptian landlines and other countries keep their own code', async () => {
    assert.strictEqual(phone.toWaId('02 2345 6789'), '20223456789');
    assert.strictEqual(phone.toWaId('+20 3 456 7890'), '2034567890');
    assert.strictEqual(phone.toWaId('+44 7911 123456'), '447911123456');
    assert.strictEqual(phone.toWaId('0044 7911 123456'), '447911123456');
    assert.strictEqual(phone.toWaId('966501234567'), '966501234567');
    assert.strictEqual(phone.toWaId('+1 (415) 555-2671'), '14155552671');
  });

  await test('ambiguous or broken numbers are refused, not guessed', async () => {
    for (const raw of ['', null, undefined, 'hello', '12345', '3581234567', '+20 10 1234 567', '2010123456789', '0123', '+0044']) {
      assert.strictEqual(phone.toWaId(raw), null, String(raw));
    }
  });

  await test('lenient mode (machine callers, stored phones) only rescues Egyptian mobiles', async () => {
    assert.strictEqual(phone.toWaId('01012345678', { lenient: true }), '201012345678');
    assert.strictEqual(phone.toWaId('201012345678', { lenient: true }), '201012345678');
    assert.strictEqual(phone.toWaId('3581234567', { lenient: true }), '3581234567');
    assert.strictEqual(phone.toWaId('1234567', { lenient: true }), null);
  });

  await test('numbers display grouped, Egyptian mobiles the local way', async () => {
    assert.strictEqual(phone.formatWaId('201012345678'), '+20 10 1234 5678');
    assert.strictEqual(phone.formatWaId('447911123456'), '+447911123456');
  });

  await test('a search typed the local way finds the stored number', async () => {
    const id = '201012345678';
    for (const q of ['01012345678', '010 1234', '0020 101', '+20 10 1234 5678', '5678']) {
      assert.ok(phone.searchKeys(q).some((k) => id.includes(k)), q);
    }
    assert.ok(!phone.searchKeys('01099999999').some((k) => id.includes(k)));
  });

  console.log('\n\x1b[1mFORWARD + READ/UNREAD ROUTES (fake DB)\x1b[0m');
  const dbmod = require('../lib/db');
  const wa = require('../lib/whatsapp');
  const idem = require('../lib/idempotency');
  const fdb = makeFakeDb();
  dbmod.__setDbForTesting(fdb);
  // Stub the send side so forwarding "succeeds" without a live token.
  wa.sendText = async () => ({ ok: true, waMessageId: 'wamid.FWD_TXT' });
  wa.sendMedia = async () => ({ ok: true, waMessageId: 'wamid.FWD_MEDIA' });
  wa.uploadMedia = async () => ({ ok: true, mediaId: 'MEDIA_FWD' });

  const srv2 = await startServer();
  // log in to get a session cookie for the gated routes
  const loginRes = await req(srv2, 'POST', '/api/login', { body: { passcode: 'letmein' } });
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  const authed = (method, path, body) => req(srv2, method, path, { body, headers: { cookie } });
  const rowsForKey = (k) => fdb._tables.messages.filter((m) => m.client_key === k);

  await test('read endpoint: mark unread sets unread_count = 1', async () => {
    fdb._tables.conversations.push({ wa_id: '201000000001', unread_count: 0 });
    const r = await authed('POST', '/api/conversations/201000000001/read', { read: false });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(fdb._tables.conversations.find((c) => c.wa_id === '201000000001').unread_count, 1);
  });

  await test('read endpoint: mark read sets unread_count = 0', async () => {
    const r = await authed('POST', '/api/conversations/201000000001/read', { read: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(fdb._tables.conversations.find((c) => c.wa_id === '201000000001').unread_count, 0);
  });

  await test('manually-unread chat that gets a new inbound still reads as unread', async () => {
    // mark unread (=1), then an inbound arrives → increments to 2 (still > 0)
    await authed('POST', '/api/conversations/201000000001/read', { read: false });
    await ingestWebhook(inboundText('ping', 'wamid.AFTER_UNREAD'), fdb); // bumps a DIFFERENT wa_id
    const c = fdb._tables.conversations.find((x) => x.wa_id === '201000000001');
    assert.ok(c.unread_count > 0, 'manually-unread chat lost its unread state');
  });

  await test('forward text: persists a forwarded outgoing row in the destination', async () => {
    // seed a source message + a destination conversation
    fdb._tables.conversations.push({ wa_id: '201000000002', unread_count: 0 });
    fdb._tables.messages.push({
      id: 7001, wa_message_id: 'wamid.SRC', wa_id: '201000000003',
      direction: 'in', type: 'text', body: 'forward me', status: 'received',
    });
    const r = await authed('POST', '/api/forward', { message_id: 7001, wa_ids: ['201000000002'] });
    assert.strictEqual(r.status, 200);
    const out = JSON.parse(r.text);
    assert.strictEqual(out.sent, 1);
    const row = fdb._tables.messages.find((m) => m.wa_id === '201000000002' && m.body === 'forward me');
    assert.ok(row, 'forwarded row not persisted');
    assert.strictEqual(row.direction, 'out');
    assert.strictEqual(row.forwarded, true, `forwarded flag = ${row.forwarded}`);
  });

  await test('forward to two chats reports sent=2', async () => {
    fdb._tables.conversations.push({ wa_id: '201000000004', unread_count: 0 });
    fdb._tables.conversations.push({ wa_id: '201000000005', unread_count: 0 });
    const r = await authed('POST', '/api/forward', { message_id: 7001, wa_ids: ['201000000004', '201000000005'] });
    const out = JSON.parse(r.text);
    assert.strictEqual(out.sent, 2);
    assert.strictEqual(out.total, 2);
  });

  await test('forward unstored media → 409 with a clear message', async () => {
    fdb._tables.messages.push({
      id: 7002, wa_message_id: 'wamid.SRC2', wa_id: '201000000003',
      direction: 'in', type: 'image', body: '📷 Image', media_status: 'pending', media_path: null,
    });
    const r = await authed('POST', '/api/forward', { message_id: 7002, wa_ids: ['201000000002'] });
    assert.strictEqual(r.status, 409);
  });

  await test('forward voice note carries media_meta.voice so it renders as voice', async () => {
    fdb._tables.messages.push({
      id: 7003, wa_message_id: 'wamid.SRCVOICE', wa_id: '201000000003',
      direction: 'in', type: 'audio', body: '🎤 Voice message',
      media_status: 'stored', media_path: '201000000003/audio/v.ogg',
      media_meta: { voice: true, mime_type: 'audio/ogg', caption: null },
    });
    const r = await authed('POST', '/api/forward', { message_id: 7003, wa_ids: ['201000000002'] });
    assert.strictEqual(r.status, 200);
    const row = fdb._tables.messages.find((m) => m.wa_id === '201000000002' && m.wa_message_id === 'wamid.FWD_MEDIA');
    assert.ok(row, 'forwarded voice row missing');
    assert.strictEqual(row.type, 'audio');
    assert.strictEqual(row.forwarded, true);
    assert.strictEqual(row.media_meta && row.media_meta.voice, true);
  });

  // --- saved names, local numbers, member lookup ---
  console.log('\n\x1b[1mCONTACT NAMES + MEMBERS (fake DB)\x1b[0m');
  const members = require('../lib/members');
  members.__setLookupForTesting(async () => []);
  const conv = (id) => fdb._tables.conversations.find((c) => c.wa_id === id);

  await test('rename: PATCH saves the name and keeps the WhatsApp name apart', async () => {
    fdb._tables.conversations.push({ wa_id: '201000000020', profile_name: 'Mo 🦁', unread_count: 0 });
    const r = await authed('PATCH', '/api/conversations/201000000020', { name: '  Mohamed   Ali ' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(JSON.parse(r.text).display_name, 'Mohamed Ali');
    assert.strictEqual(conv('201000000020').display_name, 'Mohamed Ali');
    assert.strictEqual(conv('201000000020').profile_name, 'Mo 🦁');
  });

  await test('rename: their next WhatsApp message does not overwrite the saved name', async () => {
    const body = inboundText('hello again', 'wamid.RENAME1');
    body.entry[0].changes[0].value.contacts[0] = { profile: { name: 'Mo' }, wa_id: '201000000020' };
    body.entry[0].changes[0].value.messages[0].from = '201000000020';
    await ingestWebhook(body, fdb);
    assert.strictEqual(conv('201000000020').display_name, 'Mohamed Ali');
    assert.strictEqual(conv('201000000020').profile_name, 'Mo');
  });

  await test('rename: the list returns the saved name', async () => {
    const r = await authed('GET', '/api/conversations');
    const row = JSON.parse(r.text).conversations.find((c) => c.wa_id === '201000000020');
    assert.strictEqual(row.display_name, 'Mohamed Ali');
  });

  await test('rename: an empty name clears it, a long or non-text one is refused', async () => {
    let r = await authed('PATCH', '/api/conversations/201000000020', { name: '   ' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(conv('201000000020').display_name, null);
    r = await authed('PATCH', '/api/conversations/201000000020', { name: 'x'.repeat(81) });
    assert.strictEqual(r.status, 400);
    r = await authed('PATCH', '/api/conversations/201000000020', { name: 42 });
    assert.strictEqual(r.status, 400);
    await authed('PATCH', '/api/conversations/201000000020', { name: 'Mohamed Ali' });
  });

  await test('rename: unknown chat → 404, no cookie → 401', async () => {
    let r = await authed('PATCH', '/api/conversations/201000000099', { name: 'Nobody' });
    assert.strictEqual(r.status, 404);
    r = await req(srv2, 'PATCH', '/api/conversations/201000000020', { body: { name: 'x' } });
    assert.strictEqual(r.status, 401);
  });

  await test('new chat on a number that already has a chat saves the name (it used to be dropped)', async () => {
    fdb._tables.conversations.push({ wa_id: '201000000021', profile_name: 'sara', unread_count: 3 });
    const r = await authed('POST', '/api/start-conversation', { wa_id: '010 0000 0021', name: 'Sara Ali' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.text), { wa_id: '201000000021', created: false, display_name: 'Sara Ali' });
    assert.strictEqual(conv('201000000021').display_name, 'Sara Ali');
    assert.strictEqual(conv('201000000021').unread_count, 3);
  });

  await test('new chat typed the local Egyptian way opens the +20 number', async () => {
    const r = await authed('POST', '/api/start-conversation', { wa_id: '01000000022', name: 'Omar' });
    const j = JSON.parse(r.text);
    assert.strictEqual(j.wa_id, '201000000022');
    assert.strictEqual(j.created, true);
    assert.strictEqual(conv('201000000022').display_name, 'Omar');
    assert.ok(!conv('201000000022').profile_name);
    assert.ok(!conv('01000000022'), 'a second chat under the local spelling was created');
  });

  await test('new chat with a number that cannot be read → 400, nothing created', async () => {
    const before = fdb._tables.conversations.length;
    const r = await authed('POST', '/api/start-conversation', { wa_id: '12345' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(fdb._tables.conversations.length, before);
  });

  await test('before migration 008 the list still loads, chats still open, renaming says so', async () => {
    const realFrom = fdb.from;
    const missing = { code: '42703', message: 'column "display_name" does not exist' };
    const failing = () => {
      const f = {
        eq: () => f, order: () => f, limit: () => f, select: () => f,
        single: () => Promise.resolve({ data: null, error: missing }),
        maybeSingle: () => Promise.resolve({ data: null, error: missing }),
        then: (res) => res({ data: null, error: missing }),
      };
      return f;
    };
    fdb.from = (table) => {
      const b = realFrom(table);
      if (table !== 'conversations') return b;
      const select = b.select;
      const update = b.update;
      b.select = (cols) => (String(cols || '').includes('display_name') ? failing() : select(cols));
      b.update = (patch) => ('display_name' in patch ? failing() : update(patch));
      return b;
    };
    try {
      let r = await authed('GET', '/api/conversations');
      assert.strictEqual(r.status, 200);
      assert.ok(JSON.parse(r.text).conversations.length > 0);
      r = await authed('PATCH', '/api/conversations/201000000020', { name: 'X' });
      assert.strictEqual(r.status, 503);
      assert.strictEqual(JSON.parse(r.text).code, 'SAVED_NAMES_OFF');
      r = await authed('POST', '/api/start-conversation', { wa_id: '01000000023', name: 'Lina' });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(JSON.parse(r.text), { wa_id: '201000000023', created: true, display_name: null });
    } finally {
      fdb.from = realFrom;
    }
  });

  await test('members: each chat carries its member and company', async () => {
    members.__setLookupForTesting(async (ids) => {
      assert.ok(ids.includes('201000000020'));
      return [
        { wa_id: '201000000020', source: 'app', kind: 'member', name: 'Mohamed Ali', company: 'Nawy Degla', active: true },
        { wa_id: '201000000020', source: 'roster', kind: 'member', name: 'Mohamed Ali Hassan', company: 'Nawy Degla', active: true },
        { wa_id: '201000000021', source: 'contact', kind: 'hr', name: 'Sara HR', company: 'Oasis', active: true },
      ];
    });
    const j = JSON.parse((await authed('GET', '/api/conversations')).text);
    assert.strictEqual(j.members_available, true);
    const row = (id) => j.conversations.find((c) => c.wa_id === id);
    assert.deepStrictEqual(row('201000000020').member, { name: 'Mohamed Ali Hassan', company: 'Nawy Degla', kind: 'member', active: true, more: 0 });
    assert.strictEqual(row('201000000021').member.kind, 'hr');
    assert.strictEqual(row('201000000022').member, null);
  });

  await test('members: one lookup per refresh, not one per chat, and cached between polls', async () => {
    let calls = 0;
    members.__setLookupForTesting(async () => { calls++; return []; });
    await authed('GET', '/api/conversations');
    await authed('GET', '/api/conversations');
    assert.strictEqual(calls, 1);
  });

  await test('members: a lookup that fails leaves the list working and claims nothing', async () => {
    members.__setLookupForTesting(async () => {
      throw Object.assign(new Error('function wa_lookup.members(text[]) does not exist'), { code: '42883' });
    });
    const r = await authed('GET', '/api/conversations');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.text);
    assert.strictEqual(j.members_available, false);
    assert.ok(j.conversations.every((c) => c.member === null));
  });

  await test('members: a lookup that hangs is cut off and the list still answers', async () => {
    members.__setLookupForTesting(() => new Promise(() => {}), { timeoutMs: 50 });
    const r = await authed('GET', '/api/conversations');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(JSON.parse(r.text).members_available, false);
  });

  await test('members: active beats inactive, and the other company is counted', async () => {
    const m = members.pick([
      { source: 'roster', kind: 'member', name: 'Moved Person', company: 'Oasis', active: false },
      { source: 'app', kind: 'member', name: 'Moved Person', company: 'Nawy Degla', active: true },
    ]);
    assert.deepStrictEqual(m, { name: 'Moved Person', company: 'Nawy Degla', kind: 'member', active: true, more: 1 });
  });
  members.__setLookupForTesting(async () => []);

  // --- service send API (token gate + template allow-list) ---
  console.log('\n\x1b[1mSERVICE SEND API (fake DB, stubbed Graph)\x1b[0m');

  await test('service send: 503 while SERVICE_SEND_TOKEN is unset', async () => {
    const r = await req(srv2, 'POST', '/api/service/send-template', {
      body: { to: '201000000009', template: 'ops_group_invite' },
      headers: { 'x-service-token': 'anything' },
    });
    assert.strictEqual(r.status, 503);
  });

  process.env.SERVICE_SEND_TOKEN = 'svc_test_token';
  const svc = (method, path, body) =>
    req(srv2, method, path, { body, headers: { 'x-service-token': 'svc_test_token' } });

  await test('service send: wrong token → 401', async () => {
    const r = await req(srv2, 'POST', '/api/service/send-template', {
      body: { to: '201000000009', template: 'ops_group_invite' },
      headers: { 'x-service-token': 'WRONG' },
    });
    assert.strictEqual(r.status, 401);
  });

  await test('service health reports wiring without sending', async () => {
    const r = await svc('GET', '/api/service/health');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.text);
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.db_configured, true); // fake db injected
  });

  await test('service send: non-numeric to → 400', async () => {
    const r = await svc('POST', '/api/service/send-template', { to: 'not-a-phone', template: 'ops_group_invite' });
    assert.strictEqual(r.status, 400);
  });

  await test('service send: template outside the allow-list → 400', async () => {
    const r = await svc('POST', '/api/service/send-template', { to: '201000000009', template: 'marketing_blast' });
    assert.strictEqual(r.status, 400);
  });

  await test('service send: unapproved template surfaces the Graph error as 502', async () => {
    wa.sendTemplate = async () => ({ ok: false, error: "Template 'ops_group_invite' is not approved (or does not exist) for this WABA yet." });
    const r = await svc('POST', '/api/service/send-template', { to: '201000000009', template: 'ops_group_invite' });
    assert.strictEqual(r.status, 502);
    assert.ok(r.text.includes('not approved'));
  });

  await test('service send: ok path returns waMessageId and persists the inbox preview', async () => {
    wa.sendTemplate = async (to, t) => {
      assert.strictEqual(to, '201000000009');
      assert.strictEqual(t.name, 'ops_group_invite');
      assert.strictEqual(t.language, 'en');
      return { ok: true, waMessageId: 'wamid.TPL1' };
    };
    const r = await svc('POST', '/api/service/send-template', {
      to: '+20 100 000 0009',
      template: 'ops_group_invite',
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ali' }, { type: 'text', text: 'Group 2' }] }],
    });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.text);
    assert.strictEqual(j.waMessageId, 'wamid.TPL1');
    const row = fdb._tables.messages.find((m) => m.wa_message_id === 'wamid.TPL1');
    assert.ok(row, 'outbound template row not persisted');
    assert.strictEqual(row.direction, 'out');
    assert.ok(row.body.includes('[ops_group_invite]') && row.body.includes('Ali'), 'preview body missing template context');
  });

  await test('service send: a local Egyptian number goes to its +20 wa_id', async () => {
    let sentTo = null;
    wa.sendTemplate = async (to) => { sentTo = to; return { ok: true, waMessageId: 'wamid.SVC_LOCAL' }; };
    const r = await svc('POST', '/api/service/send-template', { to: '01000000031', template: 'ops_group_invite' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(sentTo, '201000000031');
  });

  await test('service send: WA_TEMPLATE_ALLOWLIST env overrides the ops_ prefix rule', async () => {
    process.env.WA_TEMPLATE_ALLOWLIST = 'custom_one';
    wa.sendTemplate = async () => ({ ok: true, waMessageId: 'wamid.TPL2' });
    const allowed = await svc('POST', '/api/service/send-template', { to: '201000000009', template: 'custom_one' });
    assert.strictEqual(allowed.status, 200);
    const blocked = await svc('POST', '/api/service/send-template', { to: '201000000009', template: 'ops_group_invite' });
    assert.strictEqual(blocked.status, 400);
    process.env.WA_TEMPLATE_ALLOWLIST = '';
  });

  await test('service send: replayed key dedupes without a second Graph call', async () => {
    let calls = 0;
    wa.sendTemplate = async () => { calls++; return { ok: true, waMessageId: 'wamid.SVC1' }; };
    const body = { to: '201000000009', template: 'ops_group_invite', client_key: 'svc-key-1' };
    const first = await svc('POST', '/api/service/send-template', body);
    assert.strictEqual(first.status, 200);
    const second = await svc('POST', '/api/service/send-template', body);
    assert.strictEqual(second.status, 200);
    const j = JSON.parse(second.text);
    assert.strictEqual(j.deduped, true);
    assert.strictEqual(j.waMessageId, 'wamid.SVC1');
    assert.strictEqual(calls, 1, `Graph was called ${calls} times`);
    assert.strictEqual(rowsForKey('svc-key-1').length, 1);
  });

  await test('service send: retry of a FAILED key re-sends onto the same row', async () => {
    let calls = 0;
    wa.sendTemplate = async () => {
      calls++;
      return calls === 1
        ? { ok: false, error: 'Temporary send failure.' }
        : { ok: true, waMessageId: 'wamid.SVC2' };
    };
    const body = { to: '201000000009', template: 'ops_group_invite', client_key: 'svc-key-failed' };
    const first = await svc('POST', '/api/service/send-template', body);
    assert.strictEqual(first.status, 502);
    assert.strictEqual(rowsForKey('svc-key-failed')[0].status, 'failed');
    const second = await svc('POST', '/api/service/send-template', body);
    assert.strictEqual(second.status, 200);
    const j = JSON.parse(second.text);
    assert.strictEqual(j.deduped, undefined, 'a failed key must not report deduped');
    assert.strictEqual(j.waMessageId, 'wamid.SVC2');
    assert.strictEqual(calls, 2, `Graph was called ${calls} times`);
    const rows = rowsForKey('svc-key-failed');
    assert.strictEqual(rows.length, 1, `duplicate row inserted (${rows.length})`);
    assert.strictEqual(rows[0].status, 'sent');
    assert.strictEqual(rows[0].wa_message_id, 'wamid.SVC2');
  });

  await test('service send: language outside en/ar → 400, no Graph call', async () => {
    let calls = 0;
    wa.sendTemplate = async () => { calls++; return { ok: true, waMessageId: 'wamid.NEVER' }; };
    const eg = await svc('POST', '/api/service/send-template', { to: '201000000009', template: 'ops_group_invite', language: 'ar_EG' });
    assert.strictEqual(eg.status, 400);
    assert.ok(eg.text.includes('language'), `error not about language: ${eg.text}`);
    const us = await svc('POST', '/api/service/send-template', { to: '201000000009', template: 'ops_group_invite', language: 'en_US' });
    assert.strictEqual(us.status, 400);
    assert.strictEqual(calls, 0, `Graph was called ${calls} times`);
  });

  await test('service send: malformed components → 400, no Graph call', async () => {
    let calls = 0;
    wa.sendTemplate = async () => { calls++; return { ok: true, waMessageId: 'wamid.NEVER' }; };
    const obj = await svc('POST', '/api/service/send-template', { to: '201000000009', template: 'ops_group_invite', components: { type: 'body' } });
    assert.strictEqual(obj.status, 400);
    assert.ok(obj.text.includes('components'), `error not about components: ${obj.text}`);
    const strings = await svc('POST', '/api/service/send-template', { to: '201000000009', template: 'ops_group_invite', components: ['body'] });
    assert.strictEqual(strings.status, 400);
    assert.strictEqual(calls, 0, `Graph was called ${calls} times`);
  });

  await test('service send: dedupe onto a pending row reports status pending', async () => {
    let calls = 0;
    wa.sendTemplate = async () => { calls++; return { ok: true, waMessageId: 'wamid.NEVER' }; };
    fdb._tables.messages.push({
      id: 7301, client_key: 'svc-key-pending', wa_id: '201000000009',
      direction: 'out', type: 'text', body: 'in flight', status: 'pending',
    });
    const r = await svc('POST', '/api/service/send-template', { to: '201000000009', template: 'ops_group_invite', client_key: 'svc-key-pending' });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.text);
    assert.strictEqual(j.deduped, true);
    assert.strictEqual(j.status, 'pending');
    assert.strictEqual(j.waMessageId, null);
    assert.strictEqual(calls, 0, `Graph was called ${calls} times`);
  });

  await test('service send: replay onto a row Meta accepted then failed re-sends it', async () => {
    let calls = 0;
    wa.sendTemplate = async () => { calls++; return { ok: true, waMessageId: 'wamid.SVCRESENT' }; };
    fdb._tables.messages.push({
      id: 7302, client_key: 'svc-key-meta-failed', wa_id: '201000000009',
      direction: 'out', type: 'text', body: 'accepted then failed', status: 'failed',
      wa_message_id: 'wamid.SVCACCEPTED', error: 'Business eligibility payment issue',
    });
    const r = await svc('POST', '/api/service/send-template', { to: '201000000009', template: 'ops_group_invite', client_key: 'svc-key-meta-failed' });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.text);
    assert.strictEqual(j.deduped, undefined, 'a failed key must not report deduped');
    assert.strictEqual(j.waMessageId, 'wamid.SVCRESENT');
    assert.strictEqual(calls, 1, `Graph was called ${calls} times`);
    const rows = rowsForKey('svc-key-meta-failed');
    assert.strictEqual(rows.length, 1, `duplicate row inserted (${rows.length})`);
    assert.strictEqual(rows[0].status, 'sent');
    assert.strictEqual(rows[0].wa_message_id, 'wamid.SVCRESENT');
    assert.strictEqual(rows[0].error, null);
  });

  // --- inbox send-template (passcode gate + narrower human allow-list) ---
  console.log('\n\x1b[1mINBOX SEND-TEMPLATE (fake DB, stubbed Graph)\x1b[0m');

  const followup = (body) => req(srv2, 'POST', '/api/send-template', { body, headers: { cookie } });
  const goodBody = {
    wa_id: '201000000010', template: 'ops_support_followup', language: 'ar', params: ['Omar', 'Oasis'],
  };

  await test('send-template: a service-allowed template the inbox may not send → 400', async () => {
    const r = await followup({ ...goodBody, template: 'ops_group_invite' });
    assert.strictEqual(r.status, 400);
  });

  await test('send-template: ar_EG / fr are not valid languages → 400', async () => {
    const eg = await followup({ ...goodBody, language: 'ar_EG' });
    assert.strictEqual(eg.status, 400);
    const fr = await followup({ ...goodBody, language: 'fr' });
    assert.strictEqual(fr.status, 400);
  });

  await test('send-template: empty / whitespace-only param → 400', async () => {
    const empty = await followup({ ...goodBody, params: ['', 'Oasis'] });
    assert.strictEqual(empty.status, 400);
    const blank = await followup({ ...goodBody, params: ['Omar', '   '] });
    assert.strictEqual(blank.status, 400);
  });

  await test('send-template: ok path sends ar, returns waMessageId, persists row + preview', async () => {
    wa.sendTemplate = async (to, t) => {
      assert.strictEqual(to, '201000000010');
      assert.strictEqual(t.name, 'ops_support_followup');
      assert.strictEqual(t.language, 'ar');
      assert.deepStrictEqual(t.components[0].parameters.map((p) => p.text), ['Omar', 'Oasis']);
      return { ok: true, waMessageId: 'wamid.FUP1' };
    };
    const r = await followup(goodBody);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(JSON.parse(r.text).waMessageId, 'wamid.FUP1');
    const row = fdb._tables.messages.find((m) => m.wa_message_id === 'wamid.FUP1');
    assert.ok(row, 'outbound template row not persisted');
    assert.strictEqual(row.direction, 'out');
    assert.strictEqual(row.status, 'sent');
    assert.ok(row.body.includes('[ops_support_followup]') && row.body.includes('Omar'), `preview = ${row.body}`);
    const conv = fdb._tables.conversations.find((c) => c.wa_id === '201000000010');
    assert.strictEqual(conv.last_message_text, row.body);
    assert.strictEqual(conv.last_message_direction, 'out');
  });

  await test('send-template: replayed client_key dedupes without a second Graph call', async () => {
    let calls = 0;
    wa.sendTemplate = async () => { calls++; return { ok: true, waMessageId: 'wamid.FUP2' }; };
    const first = await followup({ ...goodBody, client_key: 'inbox-key-1' });
    assert.strictEqual(first.status, 200);
    const second = await followup({ ...goodBody, client_key: 'inbox-key-1' });
    assert.strictEqual(second.status, 200);
    const j = JSON.parse(second.text);
    assert.strictEqual(j.deduped, true);
    assert.strictEqual(j.waMessageId, 'wamid.FUP2');
    assert.strictEqual(calls, 1, `Graph was called ${calls} times`);
    assert.strictEqual(rowsForKey('inbox-key-1').length, 1);
  });

  await test('send-template: retry of a FAILED key re-sends and settles the same row', async () => {
    let calls = 0;
    wa.sendTemplate = async () => {
      calls++;
      return calls === 1
        ? { ok: false, error: 'Temporary send failure.' }
        : { ok: true, waMessageId: 'wamid.FUP3' };
    };
    const first = await followup({ ...goodBody, client_key: 'inbox-key-failed' });
    assert.strictEqual(first.status, 502);
    let rows = rowsForKey('inbox-key-failed');
    assert.strictEqual(rows.length, 1, `rows after the failure = ${rows.length}`);
    assert.strictEqual(rows[0].status, 'failed');
    assert.strictEqual(rows[0].error, 'Temporary send failure.');

    const second = await followup({ ...goodBody, client_key: 'inbox-key-failed' });
    assert.strictEqual(second.status, 200);
    const j = JSON.parse(second.text);
    assert.strictEqual(j.deduped, undefined, 'a failed key must not report deduped');
    assert.strictEqual(j.waMessageId, 'wamid.FUP3');
    assert.strictEqual(calls, 2, `Graph was called ${calls} times`);
    rows = rowsForKey('inbox-key-failed');
    assert.strictEqual(rows.length, 1, `duplicate row inserted (${rows.length})`);
    assert.strictEqual(rows[0].status, 'sent');
    assert.strictEqual(rows[0].wa_message_id, 'wamid.FUP3');
    assert.strictEqual(rows[0].error, null);
  });

  await test('send-template: a failed key that fails again stays one failed row', async () => {
    let calls = 0;
    wa.sendTemplate = async () => { calls++; return { ok: false, error: 'Still rejected by Meta.' }; };
    const first = await followup({ ...goodBody, client_key: 'inbox-key-failed-2' });
    assert.strictEqual(first.status, 502);
    const second = await followup({ ...goodBody, client_key: 'inbox-key-failed-2' });
    assert.strictEqual(second.status, 502);
    assert.ok(second.text.includes('Still rejected by Meta.'), `error not surfaced: ${second.text}`);
    assert.strictEqual(calls, 2, `Graph was called ${calls} times`);
    const rows = rowsForKey('inbox-key-failed-2');
    assert.strictEqual(rows.length, 1, `duplicate row inserted (${rows.length})`);
    assert.strictEqual(rows[0].status, 'failed');
    assert.strictEqual(rows[0].error, 'Still rejected by Meta.');
  });

  await test('send-template: a pending row is still in flight, not re-sent', async () => {
    let calls = 0;
    wa.sendTemplate = async () => { calls++; return { ok: true, waMessageId: 'wamid.NEVER' }; };
    fdb._tables.messages.push({
      id: 7101, client_key: 'inbox-key-pending', wa_id: '201000000010',
      direction: 'out', type: 'text', body: 'in flight', status: 'pending',
    });
    const r = await followup({ ...goodBody, client_key: 'inbox-key-pending' });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.text);
    assert.strictEqual(j.deduped, true);
    assert.strictEqual(j.waMessageId, null);
    assert.strictEqual(calls, 0, `Graph was called ${calls} times`);
    assert.strictEqual(rowsForKey('inbox-key-pending').length, 1);
  });

  await test('send-template: a delivered row still dedupes', async () => {
    let calls = 0;
    wa.sendTemplate = async () => { calls++; return { ok: true, waMessageId: 'wamid.NEVER' }; };
    fdb._tables.messages.push({
      id: 7102, client_key: 'inbox-key-delivered', wa_id: '201000000010',
      direction: 'out', type: 'text', body: 'already out', status: 'delivered',
      wa_message_id: 'wamid.DLV',
    });
    const r = await followup({ ...goodBody, client_key: 'inbox-key-delivered' });
    const j = JSON.parse(r.text);
    assert.strictEqual(j.deduped, true);
    assert.strictEqual(j.waMessageId, 'wamid.DLV');
    assert.strictEqual(calls, 0, `Graph was called ${calls} times`);
  });

  await test('send-template: a row Meta accepted then failed is re-sent on replay', async () => {
    let calls = 0;
    wa.sendTemplate = async () => { calls++; return { ok: true, waMessageId: 'wamid.RESENT' }; };
    fdb._tables.messages.push({
      id: 7103, client_key: 'inbox-key-undelivered', wa_id: '201000000010',
      direction: 'out', type: 'text', body: 'accepted then failed', status: 'failed',
      wa_message_id: 'wamid.ACCEPTED', error: 'Message undeliverable.',
    });
    const r = await followup({ ...goodBody, client_key: 'inbox-key-undelivered' });
    const j = JSON.parse(r.text);
    assert.strictEqual(j.deduped, undefined, 'a failed key must not report deduped');
    assert.strictEqual(j.waMessageId, 'wamid.RESENT');
    assert.strictEqual(calls, 1, `Graph was called ${calls} times`);
    const rows = rowsForKey('inbox-key-undelivered');
    assert.strictEqual(rows.length, 1, `duplicate row inserted (${rows.length})`);
    assert.strictEqual(rows[0].status, 'sent');
    assert.strictEqual(rows[0].wa_message_id, 'wamid.RESENT');
  });

  // The reserve race: our SELECT missed the row, the insert then loses on the
  // client_key unique index and reserve hands back the winner.
  await test('send-template: reserve race onto a failed row re-sends', async () => {
    let calls = 0;
    wa.sendTemplate = async () => { calls++; return { ok: true, waMessageId: 'wamid.RACE1' }; };
    fdb._tables.messages.push({
      id: 7104, client_key: 'inbox-key-race-failed', wa_id: '201000000010',
      direction: 'out', type: 'text', body: 'raced', status: 'failed', error: 'Temporary send failure.',
    });
    const realFind = idem.findByKey;
    idem.findByKey = async () => ({ row: null });
    try {
      const r = await followup({ ...goodBody, client_key: 'inbox-key-race-failed' });
      assert.strictEqual(r.status, 200);
      const j = JSON.parse(r.text);
      assert.strictEqual(j.deduped, undefined, 'a failed row must not report deduped');
      assert.strictEqual(j.waMessageId, 'wamid.RACE1');
    } finally {
      idem.findByKey = realFind;
    }
    assert.strictEqual(calls, 1, `Graph was called ${calls} times`);
    const rows = rowsForKey('inbox-key-race-failed');
    assert.strictEqual(rows.length, 1, `duplicate row inserted (${rows.length})`);
    assert.strictEqual(rows[0].status, 'sent');
    assert.strictEqual(rows[0].wa_message_id, 'wamid.RACE1');
  });

  await test('send-template: reserve race onto a sent row dedupes', async () => {
    let calls = 0;
    wa.sendTemplate = async () => { calls++; return { ok: true, waMessageId: 'wamid.RACE2' }; };
    fdb._tables.messages.push({
      id: 7105, client_key: 'inbox-key-race-sent', wa_id: '201000000010',
      direction: 'out', type: 'text', body: 'winner', status: 'sent', wa_message_id: 'wamid.WINNER',
    });
    const realFind = idem.findByKey;
    idem.findByKey = async () => ({ row: null });
    try {
      const r = await followup({ ...goodBody, client_key: 'inbox-key-race-sent' });
      const j = JSON.parse(r.text);
      assert.strictEqual(j.deduped, true);
      assert.strictEqual(j.waMessageId, 'wamid.WINNER');
    } finally {
      idem.findByKey = realFind;
    }
    assert.strictEqual(calls, 0, `Graph was called ${calls} times`);
    assert.strictEqual(rowsForKey('inbox-key-race-sent').length, 1);
  });

  // --- /api/send + /api/send-media: the same key lifecycle as send-template ---
  console.log('\n\x1b[1mSEND + SEND-MEDIA IDEMPOTENCY (fake DB, stubbed Graph)\x1b[0m');

  const sendText = (body) => authed('POST', '/api/send', { wa_id: '201000000011', text: 'hi', ...body });

  await test('send: replayed key dedupes without a second Graph call', async () => {
    let calls = 0;
    wa.sendText = async () => { calls++; return { ok: true, waMessageId: 'wamid.TXT1' }; };
    const first = await sendText({ client_key: 'send-key-1' });
    assert.strictEqual(first.status, 200);
    const second = await sendText({ client_key: 'send-key-1' });
    assert.strictEqual(second.status, 200);
    const j = JSON.parse(second.text);
    assert.strictEqual(j.deduped, true);
    assert.strictEqual(j.message.wa_message_id, 'wamid.TXT1');
    assert.strictEqual(calls, 1, `Graph was called ${calls} times`);
    assert.strictEqual(rowsForKey('send-key-1').length, 1);
  });

  await test('send: retry of a FAILED key re-sends and settles the same row', async () => {
    let calls = 0;
    wa.sendText = async () => {
      calls++;
      return calls === 1
        ? { ok: false, error: 'Temporary send failure.' }
        : { ok: true, waMessageId: 'wamid.TXT2' };
    };
    const first = await sendText({ client_key: 'send-key-failed' });
    assert.strictEqual(first.status, 502);
    let rows = rowsForKey('send-key-failed');
    assert.strictEqual(rows.length, 1, `rows after the failure = ${rows.length}`);
    assert.strictEqual(rows[0].status, 'failed');

    const second = await sendText({ client_key: 'send-key-failed' });
    assert.strictEqual(second.status, 200);
    const j = JSON.parse(second.text);
    assert.strictEqual(j.deduped, undefined, 'a failed key must not report deduped');
    assert.strictEqual(j.message.wa_message_id, 'wamid.TXT2');
    assert.strictEqual(calls, 2, `Graph was called ${calls} times`);
    rows = rowsForKey('send-key-failed');
    assert.strictEqual(rows.length, 1, `duplicate row inserted (${rows.length})`);
    assert.strictEqual(rows[0].status, 'sent');
    assert.strictEqual(rows[0].error, null);
  });

  await test('send: a pending row is still in flight, not re-sent', async () => {
    let calls = 0;
    wa.sendText = async () => { calls++; return { ok: true, waMessageId: 'wamid.NEVER' }; };
    fdb._tables.messages.push({
      id: 7201, client_key: 'send-key-pending', wa_id: '201000000011',
      direction: 'out', type: 'text', body: 'in flight', status: 'pending',
    });
    const r = await sendText({ client_key: 'send-key-pending' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(JSON.parse(r.text).deduped, true);
    assert.strictEqual(calls, 0, `Graph was called ${calls} times`);
    assert.strictEqual(rowsForKey('send-key-pending').length, 1);
  });

  await test('send: a delivered row still dedupes', async () => {
    let calls = 0;
    wa.sendText = async () => { calls++; return { ok: true, waMessageId: 'wamid.NEVER' }; };
    fdb._tables.messages.push({
      id: 7202, client_key: 'send-key-delivered', wa_id: '201000000011',
      direction: 'out', type: 'text', body: 'already out', status: 'delivered',
      wa_message_id: 'wamid.TXTDLV',
    });
    const r = await sendText({ client_key: 'send-key-delivered' });
    const j = JSON.parse(r.text);
    assert.strictEqual(j.deduped, true);
    assert.strictEqual(j.message.wa_message_id, 'wamid.TXTDLV');
    assert.strictEqual(calls, 0, `Graph was called ${calls} times`);
  });

  await test('send: a row Meta accepted then failed is re-sent on replay', async () => {
    let calls = 0;
    wa.sendText = async () => { calls++; return { ok: true, waMessageId: 'wamid.TXTRESENT' }; };
    fdb._tables.messages.push({
      id: 7203, client_key: 'send-key-undelivered', wa_id: '201000000011',
      direction: 'out', type: 'text', body: 'accepted then failed', status: 'failed',
      wa_message_id: 'wamid.TXTACCEPTED', error: 'Message undeliverable.',
    });
    const r = await sendText({ client_key: 'send-key-undelivered' });
    const j = JSON.parse(r.text);
    assert.strictEqual(j.deduped, undefined, 'a failed key must not report deduped');
    assert.strictEqual(j.message.wa_message_id, 'wamid.TXTRESENT');
    assert.strictEqual(calls, 1, `Graph was called ${calls} times`);
    const rows = rowsForKey('send-key-undelivered');
    assert.strictEqual(rows.length, 1, `duplicate row inserted (${rows.length})`);
    assert.strictEqual(rows[0].status, 'sent');
  });

  const sendMedia = (body) => authed('POST', '/api/send-media', {
    wa_id: '201000000012',
    file_base64: Buffer.from('fake-png-bytes').toString('base64'),
    mime: 'image/png',
    filename: 'shot.png',
    ...body,
  });

  await test('send-media: replayed key dedupes without a second Graph call', async () => {
    let calls = 0;
    wa.uploadMedia = async () => ({ ok: true, mediaId: 'MEDIA_K1' });
    wa.sendMedia = async () => { calls++; return { ok: true, waMessageId: 'wamid.MED1' }; };
    const first = await sendMedia({ client_key: 'media-key-1' });
    assert.strictEqual(first.status, 200);
    const second = await sendMedia({ client_key: 'media-key-1' });
    assert.strictEqual(second.status, 200);
    const j = JSON.parse(second.text);
    assert.strictEqual(j.deduped, true);
    assert.strictEqual(j.message.wa_message_id, 'wamid.MED1');
    assert.strictEqual(calls, 1, `Graph was called ${calls} times`);
    assert.strictEqual(rowsForKey('media-key-1').length, 1);
  });

  await test('send-media: retry of a FAILED key re-sends and settles the same row', async () => {
    let calls = 0;
    wa.uploadMedia = async () => ({ ok: true, mediaId: 'MEDIA_K2' });
    wa.sendMedia = async () => {
      calls++;
      return calls === 1
        ? { ok: false, error: 'Temporary media failure.' }
        : { ok: true, waMessageId: 'wamid.MED2' };
    };
    const first = await sendMedia({ client_key: 'media-key-failed' });
    assert.strictEqual(first.status, 502);
    let rows = rowsForKey('media-key-failed');
    assert.strictEqual(rows.length, 1, `rows after the failure = ${rows.length}`);
    assert.strictEqual(rows[0].status, 'failed');
    assert.strictEqual(rows[0].media_status, 'stored');

    const second = await sendMedia({ client_key: 'media-key-failed' });
    assert.strictEqual(second.status, 200);
    const j = JSON.parse(second.text);
    assert.strictEqual(j.deduped, undefined, 'a failed key must not report deduped');
    assert.strictEqual(j.message.wa_message_id, 'wamid.MED2');
    assert.strictEqual(calls, 2, `Graph was called ${calls} times`);
    rows = rowsForKey('media-key-failed');
    assert.strictEqual(rows.length, 1, `duplicate row inserted (${rows.length})`);
    assert.strictEqual(rows[0].status, 'sent');
    assert.strictEqual(rows[0].media_status, 'stored');
  });

  await test('send-media: a pending row is still in flight, not re-sent', async () => {
    let calls = 0;
    wa.sendMedia = async () => { calls++; return { ok: true, waMessageId: 'wamid.NEVER' }; };
    fdb._tables.messages.push({
      id: 7204, client_key: 'media-key-pending', wa_id: '201000000012',
      direction: 'out', type: 'image', body: '📷 Image', status: 'pending',
    });
    const r = await sendMedia({ client_key: 'media-key-pending' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(JSON.parse(r.text).deduped, true);
    assert.strictEqual(calls, 0, `Graph was called ${calls} times`);
    assert.strictEqual(rowsForKey('media-key-pending').length, 1);
  });

  await test('send-media: a row Meta accepted then failed is re-sent on replay', async () => {
    let calls = 0;
    wa.uploadMedia = async () => ({ ok: true, mediaId: 'MEDIA_RESENT' });
    wa.sendMedia = async () => { calls++; return { ok: true, waMessageId: 'wamid.MEDRESENT' }; };
    fdb._tables.messages.push({
      id: 7205, client_key: 'media-key-undelivered', wa_id: '201000000012',
      direction: 'out', type: 'image', body: '📷 Image', status: 'failed',
      wa_message_id: 'wamid.MEDACCEPTED', error: 'Message undeliverable.',
      media_path: '201000000012/out/k7205.png', media_status: 'stored',
    });
    const r = await sendMedia({ client_key: 'media-key-undelivered' });
    const j = JSON.parse(r.text);
    assert.strictEqual(j.deduped, undefined, 'a failed key must not report deduped');
    assert.strictEqual(j.message.wa_message_id, 'wamid.MEDRESENT');
    assert.strictEqual(calls, 1, `Graph was called ${calls} times`);
    const rows = rowsForKey('media-key-undelivered');
    assert.strictEqual(rows.length, 1, `duplicate row inserted (${rows.length})`);
    assert.strictEqual(rows[0].status, 'sent');
  });

  await test('send-media: a re-send whose bucket upload fails keeps the stored copy', async () => {
    wa.uploadMedia = async () => ({ ok: true, mediaId: 'MEDIA_K3' });
    wa.sendMedia = async () => ({ ok: true, waMessageId: 'wamid.MED3' });
    fdb._tables.messages.push({
      id: 7206, client_key: 'media-key-keep-copy', wa_id: '201000000012',
      direction: 'out', type: 'image', body: '📷 Image', status: 'failed',
      media_path: '201000000012/out/k7206.png', media_status: 'stored',
    });
    const realFrom = fdb.storage.from;
    fdb.storage.from = () => ({ upload: async () => ({ error: { message: 'bucket unavailable' } }) });
    try {
      const r = await sendMedia({ client_key: 'media-key-keep-copy' });
      assert.strictEqual(r.status, 200);
    } finally {
      fdb.storage.from = realFrom;
    }
    const row = rowsForKey('media-key-keep-copy')[0];
    assert.strictEqual(row.status, 'sent');
    assert.strictEqual(row.media_status, 'stored', 'stored copy was downgraded');
    assert.strictEqual(row.media_path, '201000000012/out/k7206.png', 'stored copy was lost');
  });

  // --- media filenames: what the browser actually saves the file as ---
  console.log('\n\x1b[1mMEDIA FILENAMES\x1b[0m');
  const mediaLib = require('../lib/media');

  await test('extFromMime: octet-stream is not an extension', async () => {
    assert.strictEqual(mediaLib.extFromMime('application/octet-stream'), 'bin');
    assert.strictEqual(mediaLib.extFromMime('application/vnd.ms-excel'), 'bin');
    assert.strictEqual(mediaLib.extFromMime(null), 'bin');
  });

  await test('extFromMime: known types still map', async () => {
    assert.strictEqual(mediaLib.extFromMime('image/jpeg'), 'jpg');
    assert.strictEqual(mediaLib.extFromMime('application/pdf'), 'pdf');
    assert.strictEqual(mediaLib.extFromMime('image/png; charset=binary'), 'png');
  });

  await test('extFromName prefers the sender-supplied extension', async () => {
    assert.strictEqual(mediaLib.extFromName('Lab Results.PDF'), 'pdf');
    assert.strictEqual(mediaLib.extFromName('نتائج.pdf'), 'pdf');
    assert.strictEqual(mediaLib.extFromName('no-extension'), null);
    assert.strictEqual(mediaLib.extFromName(null), null);
  });

  await test('downloadName keeps the original document name', async () => {
    assert.strictEqual(
      mediaLib.downloadName({ filename: 'Lab Results.pdf' }, '1358517102390880', 'application/octet-stream'),
      'Lab Results.pdf',
    );
    assert.strictEqual(
      mediaLib.downloadName({ filename: 'نتائج التحاليل.pdf' }, '1', 'application/pdf'),
      'نتائج التحاليل.pdf',
    );
  });

  await test('downloadName never yields a bare media id or .octetstream', async () => {
    const n = mediaLib.downloadName({}, '1358517102390880', 'application/octet-stream');
    assert.strictEqual(n, 'whatsapp-1358517102390880.bin');
    assert.ok(!n.includes('octetstream'));
    assert.strictEqual(mediaLib.downloadName(null, '99', 'image/jpeg'), 'whatsapp-99.jpg');
  });

  // --- replies (quoted messages), forward guard, iPhone audio ---
  console.log('\n\x1b[1mREPLIES + FORWARD + IPHONE AUDIO\x1b[0m');
  {
    await test('inbound swipe-reply keeps the quoted wa_message_id', async () => {
      const text = describeMessage({ type: 'text', text: { body: 'yes' }, context: { from: '201', id: 'wamid.ORIG' } });
      assert.deepStrictEqual(text.media_meta, { reply_to: 'wamid.ORIG' });
      const img = describeMessage({ type: 'image', image: { id: 'MEDIA9', mime_type: 'image/jpeg' }, context: { id: 'wamid.ORIG' } });
      assert.strictEqual(img.media_meta.id, 'MEDIA9', 'media id lost');
      assert.strictEqual(img.media_meta.reply_to, 'wamid.ORIG');
      const fwd = describeMessage({ type: 'text', text: { body: 'fw' }, context: { forwarded: true } });
      assert.strictEqual(fwd.media_meta, null, 'a forward is not a reply');
    });

    await test('send: reply_to reaches WhatsApp and is stored on the row', async () => {
      let seen;
      wa.sendText = async (to, text, opts) => { seen = opts; return { ok: true, waMessageId: 'wamid.REPLY1' }; };
      const r = await sendText({ client_key: 'reply-key-1', reply_to: 'wamid.ORIG' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(seen && seen.replyTo, 'wamid.ORIG');
      const row = rowsForKey('reply-key-1')[0];
      assert.strictEqual(row.media_meta && row.media_meta.reply_to, 'wamid.ORIG');
    });

    await test('send: a malformed reply_to is refused before Graph', async () => {
      let calls = 0;
      wa.sendText = async () => { calls++; return { ok: true, waMessageId: 'x' }; };
      const r = await sendText({ client_key: 'reply-key-bad', reply_to: 'bad id"><script>' });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(calls, 0);
    });

    await test('send-media and retry carry the reply', async () => {
      let mediaOpts;
      wa.uploadMedia = async () => ({ ok: true, mediaId: 'MEDIA_R' });
      wa.sendMedia = async (to, cat, id, opts) => { mediaOpts = opts; return { ok: true, waMessageId: 'wamid.REPLYM' }; };
      const r = await sendMedia({ client_key: 'reply-media-1', reply_to: 'wamid.ORIG2' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(mediaOpts.replyTo, 'wamid.ORIG2');
      assert.strictEqual(rowsForKey('reply-media-1')[0].media_meta.reply_to, 'wamid.ORIG2');

      let textOpts;
      wa.sendText = async (to, text, opts) => { textOpts = opts; return { ok: true, waMessageId: 'wamid.RETRY_R' }; };
      fdb._tables.messages.push({
        id: 7901, wa_id: '201000000011', direction: 'out', type: 'text', body: 'again',
        status: 'failed', media_meta: { reply_to: 'wamid.ORIG3' },
      });
      const rr = await authed('POST', '/api/retry/7901');
      assert.strictEqual(rr.status, 200);
      assert.strictEqual(textOpts.replyTo, 'wamid.ORIG3');
    });

    await test('forward: the quote stays behind in the source chat', async () => {
      wa.uploadMedia = async () => ({ ok: true, mediaId: 'MEDIA_F' });
      wa.sendMedia = async () => ({ ok: true, waMessageId: 'wamid.FWD_Q' });
      fdb._tables.conversations.push({ wa_id: '201000000031' }, { wa_id: '201000000032' });
      fdb._tables.messages.push({
        id: 7902, wa_id: '201000000031', direction: 'in', type: 'audio', body: '🎤 Voice message',
        media_status: 'stored', media_path: '201000000031/audio/v.ogg',
        media_meta: { mime_type: 'audio/ogg', voice: true, reply_to: 'wamid.ORIG4' },
      });
      const r = await authed('POST', '/api/forward', { message_id: 7902, wa_ids: ['201000000032'] });
      assert.strictEqual(r.status, 200, r.text);
      const row = fdb._tables.messages.find((m) => m.wa_message_id === 'wamid.FWD_Q');
      assert.ok(row, 'forwarded row not persisted');
      assert.strictEqual(row.media_meta.voice, true);
      assert.strictEqual(row.media_meta.reply_to, undefined, 'quote leaked into the destination');
    });

    await test('whatsapp: replyTo becomes the Graph context, absent otherwise', async () => {
      delete require.cache[require.resolve('../lib/whatsapp')];
      const freshWa = require('../lib/whatsapp');
      const realFetch = global.fetch;
      const env = { t: process.env.WHATSAPP_TOKEN, p: process.env.PHONE_NUMBER_ID };
      process.env.WHATSAPP_TOKEN = 'test-token';
      process.env.PHONE_NUMBER_ID = '123';
      const bodies = [];
      global.fetch = async (url, init) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ messages: [{ id: 'wamid.G' }] }) };
      };
      try {
        await freshWa.sendText('201', 'hi', { replyTo: 'wamid.Q' });
        await freshWa.sendText('201', 'hi');
        await freshWa.sendMedia('201', 'audio', 'M1', { replyTo: 'wamid.Q2' });
      } finally {
        global.fetch = realFetch;
        process.env.WHATSAPP_TOKEN = env.t || '';
        process.env.PHONE_NUMBER_ID = env.p || '';
        delete require.cache[require.resolve('../lib/whatsapp')];
      }
      assert.deepStrictEqual(bodies[0].context, { message_id: 'wamid.Q' });
      assert.strictEqual(bodies[1].context, undefined);
      assert.deepStrictEqual(bodies[2].context, { message_id: 'wamid.Q2' });
    });

    const mediaReq = (id) => req(srv2, 'GET', `/api/media/${id}?compat=1`, { headers: { cookie }, redirect: 'manual' });
    const transcode = require('../lib/transcode');
    const signedFor = (stub) => {
      const signed = [];
      const realFrom = fdb.storage.from;
      fdb.storage.from = () => ({
        ...realFrom(),
        ...stub,
        createSignedUrl: async (p) => { signed.push(p); return { data: { signedUrl: `https://s3.test/${p}` }, error: null }; },
      });
      return { signed, restore: () => { fdb.storage.from = realFrom; } };
    };
    fdb._tables.messages.push(
      { id: 7903, wa_id: '201000000031', direction: 'in', type: 'audio', media_status: 'stored', media_path: 'a/audio/v.ogg', media_meta: { mime_type: 'audio/ogg; codecs=opus', voice: true } },
      { id: 7904, wa_id: '201000000031', direction: 'in', type: 'audio', media_status: 'stored', media_path: 'a/audio/s.mp3', media_meta: { mime_type: 'audio/mpeg' } },
    );

    await test('iPhone audio: an OGG voice note is transcoded once to AAC and cached', async () => {
      const uploads = [];
      let transcodes = 0;
      const realM4a = transcode.toM4a;
      transcode.toM4a = async () => { transcodes++; return { ok: true, buffer: Buffer.from('aac'), mime: 'audio/mp4', ext: 'm4a' }; };
      const s = signedFor({
        exists: async () => ({ data: false, error: null }),
        upload: async (p, b, o) => { uploads.push({ p, type: o.contentType }); return { data: { path: p }, error: null }; },
      });
      try {
        const r = await mediaReq(7903);
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.headers.get('location'), 'https://s3.test/a/audio/v.ogg.m4a');
      } finally {
        s.restore();
        transcode.toM4a = realM4a;
      }
      assert.strictEqual(transcodes, 1);
      assert.deepStrictEqual(uploads, [{ p: 'a/audio/v.ogg.m4a', type: 'audio/mp4' }]);
    });

    await test('iPhone audio: a cached copy is served without transcoding', async () => {
      const realM4a = transcode.toM4a;
      transcode.toM4a = async () => { throw new Error('should not transcode'); };
      const s = signedFor({ exists: async () => ({ data: true, error: null }) });
      try {
        const r = await mediaReq(7903);
        assert.strictEqual(r.headers.get('location'), 'https://s3.test/a/audio/v.ogg.m4a');
      } finally {
        s.restore();
        transcode.toM4a = realM4a;
      }
    });

    await test('iPhone audio: MP3 and a failed transcode both serve the original', async () => {
      const realM4a = transcode.toM4a;
      transcode.toM4a = async () => ({ ok: false, error: 'boom' });
      const s = signedFor({ exists: async () => ({ data: false, error: null }) });
      const warn = console.warn;
      console.warn = () => {};
      try {
        assert.strictEqual((await mediaReq(7904)).headers.get('location'), 'https://s3.test/a/audio/s.mp3');
        assert.strictEqual((await mediaReq(7903)).headers.get('location'), 'https://s3.test/a/audio/v.ogg');
      } finally {
        console.warn = warn;
        s.restore();
        transcode.toM4a = realM4a;
      }
    });

    await test('retention deletes the AAC copy with its original', async () => {
      const maintenance = require('../lib/maintenance');
      const removed = [];
      const realFrom = fdb.storage.from;
      fdb.storage.from = () => ({ ...realFrom(), remove: async (keys) => { removed.push(...keys); return { data: [], error: null }; } });
      fdb._tables.messages.push({
        id: 7905, wa_id: '201000000031', direction: 'in', type: 'audio', media_status: 'stored',
        media_path: 'old/audio/v.ogg', created_at: '2020-01-01T00:00:00.000Z',
      });
      const env = process.env.CRON_SECRET;
      process.env.CRON_SECRET = 'cron-test';
      const res = { status() { return this; }, json(b) { this.body = b; return this; } };
      try {
        await maintenance({ headers: { authorization: 'Bearer cron-test' }, query: {} }, res);
      } finally {
        fdb.storage.from = realFrom;
        if (env === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = env;
      }
      assert.ok(removed.includes('old/audio/v.ogg'), `removed ${JSON.stringify(removed)}`);
      assert.ok(removed.includes('old/audio/v.ogg.m4a'), 'AAC copy left behind');
    });
  }

  srv2.close();
  dbmod.__setDbForTesting(null);

  // =========================== INBOX RENDERING ===========================
  // web/app.js is a browser module, so lift the pure thread-state functions out
  // of it and drive them directly. The thread polls every 1500ms while a send
  // takes ~3.5s, so the poll normally merges the server row first; settling the
  // send afterwards used to list that id in t.order twice and draw it twice.
  console.log('\n\x1b[1mINBOX RENDERING\x1b[0m');
  {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
    const lift = (name) => {
      const lines = src.split('\n');
      const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
      assert.notStrictEqual(start, -1, `web/app.js no longer defines ${name}`);
      let end = start;
      while (end < lines.length && lines[end] !== '}') end++;
      return lines.slice(start, end + 1).join('\n');
    };
    const ui = new Function(`
      const state = { optimisticSeq: -1, threads: {} };
      function thread(waId) {
        if (!state.threads[waId]) state.threads[waId] = { byId: new Map(), order: [], maxUpdatedAt: null, loaded: false };
        return state.threads[waId];
      }
      function renderMessages() {}
      function scrollMessagesToBottom() {}
      ${lift('mergeMessages')}
      ${lift('threadMessages')}
      ${lift('addOptimistic')}
      ${lift('settleOptimistic')}
      return { state, thread, mergeMessages, threadMessages, addOptimistic, settleOptimistic };
    `)();

    const WA = '201555000111';
    const srvRow = (id, body) => ({
      id, wa_id: WA, direction: 'out', type: 'text', body, status: 'sent',
      created_at: '2026-08-17T15:00:00.000000Z', wa_timestamp: '2026-08-17T15:00:00.000000Z',
      updated_at: `2026-08-17T15:00:0${id % 10}.123456Z`,
    });

    await test('send: poll merges the row before the POST resolves -> ONE bubble', async () => {
      ui.state.threads = {};
      const opt = ui.addOptimistic(WA, { type: 'text', body: 'yo' });
      const t = ui.thread(WA);
      assert.strictEqual(ui.threadMessages(t).length, 1, 'pending bubble');
      ui.mergeMessages(t, [srvRow(587, 'yo')]);
      ui.settleOptimistic(WA, opt, null, srvRow(587, 'yo'));
      assert.strictEqual(ui.threadMessages(t).length, 1, 'settled send drew twice');
      assert.deepStrictEqual(t.order, [587], 'id listed twice in t.order');
    });

    await test('send: POST resolves before the poll -> ONE bubble', async () => {
      ui.state.threads = {};
      const opt = ui.addOptimistic(WA, { type: 'text', body: 'yo' });
      const t = ui.thread(WA);
      ui.settleOptimistic(WA, opt, null, srvRow(587, 'yo'));
      ui.mergeMessages(t, [srvRow(587, 'yo')]);
      assert.strictEqual(ui.threadMessages(t).length, 1);
    });

    await test('two sends racing the poll stay two bubbles, not four', async () => {
      ui.state.threads = {};
      const t = ui.thread(WA);
      [588, 589].forEach((id, i) => {
        const row = srvRow(id, 'yo' + i);
        const opt = ui.addOptimistic(WA, { type: 'text', body: 'yo' + i });
        ui.mergeMessages(t, [row]);
        ui.settleOptimistic(WA, opt, null, row);
      });
      assert.strictEqual(ui.threadMessages(t).length, 2);
      assert.deepStrictEqual(t.order, [588, 589]);
    });

    await test('a FAILED send is not doubled by its own server row', async () => {
      ui.state.threads = {};
      const opt = ui.addOptimistic(WA, { type: 'text', body: 'yo' });
      const t = ui.thread(WA);
      ui.settleOptimistic(WA, opt, { _optimistic: false, status: 'failed', error: 'Re-engagement message', _retry: {} });
      assert.strictEqual(ui.threadMessages(t).length, 1);
      ui.mergeMessages(t, [{ ...srvRow(590, 'yo'), status: 'failed', error: 'Re-engagement message' }]);
      assert.strictEqual(ui.threadMessages(t).length, 1, 'failed send drew twice');
    });

    await test('a duplicated id in t.order can never render twice', async () => {
      ui.state.threads = {};
      const t = ui.thread(WA);
      t.byId.set(591, srvRow(591, 'yo'));
      t.order.push(591, 591, 591);
      assert.strictEqual(ui.threadMessages(t).length, 1);
    });

    const liftConst = (name) => {
      const line = src.split('\n').find((l) => l.startsWith(`const ${name} =`));
      assert.ok(line, `web/app.js no longer defines ${name}`);
      return line;
    };
    const names = new Function('WaPhone', `
      const { toWaId, formatWaId, searchKeys } = WaPhone;
      ${liftConst('MEMBER_ROLES')}
      ${liftConst('PHONE_QUERY')}
      ${lift('knownName')}
      ${lift('displayName')}
      ${lift('memberLabel')}
      ${lift('memberTag')}
      ${lift('matchesQuery')}
      ${lift('formatPhone')}
      return { displayName, memberLabel, memberTag, matchesQuery };
    `)(require('../web/phone'));

    const member = { name: 'Ahmed Roster', company: 'Nawy Degla', kind: 'member', active: true, more: 0 };
    const c = { wa_id: '201012345678', profile_name: 'Mo 🦁', display_name: null, member: null };

    await test('names: saved name, then member name, then WhatsApp name, then the number', async () => {
      assert.strictEqual(names.displayName({ ...c, display_name: 'Mohamed', member }), 'Mohamed');
      assert.strictEqual(names.displayName({ ...c, member }), 'Ahmed Roster');
      assert.strictEqual(names.displayName(c), 'Mo 🦁');
      assert.strictEqual(names.displayName({ ...c, profile_name: null }), '+20 10 1234 5678');
    });

    await test('names: membership reads in plain words', async () => {
      assert.strictEqual(names.memberLabel(member), 'Member · Nawy Degla');
      assert.strictEqual(names.memberLabel({ ...member, active: false, company: 'Oasis' }), 'Former member · Oasis');
      assert.strictEqual(names.memberLabel({ ...member, kind: 'hr' }), 'HR · Nawy Degla');
      assert.strictEqual(names.memberLabel({ ...member, more: 1 }), 'Member · Nawy Degla +1');
      assert.strictEqual(names.memberTag(member), 'Nawy Degla');
      assert.strictEqual(names.memberTag(null), '');
    });

    await test('search: local numbers, saved names, member names and companies all find the chat', async () => {
      const row = { ...c, display_name: 'Mohamed', member };
      for (const q of ['01012345678', '010 1234 5678', '0020 10 1234', '+20 10 1234 5678', 'moham', 'roster', 'degla', 'mo 🦁']) {
        assert.ok(names.matchesQuery(row, q), q);
      }
      assert.ok(!names.matchesQuery(row, '01099999999'));
      assert.ok(!names.matchesQuery(row, 'Oasis 2'), 'a word query with a digit matched by digits');
    });
  }

  // --- reply quotes + forward guard in the browser ---
  console.log('\n\x1b[1mINBOX REPLIES (browser)\x1b[0m');
  {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
    const lift = (name) => {
      const lines = src.split('\n');
      const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
      assert.notStrictEqual(start, -1, `web/app.js no longer defines ${name}`);
      let end = start;
      while (end < lines.length && lines[end] !== '}') end++;
      return lines.slice(start, end + 1).join('\n');
    };
    const constBlock = (name) => {
      const m = new RegExp(`^const ${name} = \\{[\\s\\S]*?^\\};`, 'm').exec(src);
      assert.ok(m, `web/app.js no longer defines ${name}`);
      return m[0];
    };
    const ui = new Function(`
      const toasts = [];
      const state = { threads: {}, conversations: [{ wa_id: 'W', profile_name: 'Sara' }], activeWaId: 'W', forward: null };
      const els = { forwardError: {}, forwardSearch: { focus() {} }, forwardModal: {} };
      function thread(waId) {
        if (!state.threads[waId]) state.threads[waId] = { byId: new Map(), order: [] };
        return state.threads[waId];
      }
      function toast(msg) { toasts.push(msg); }
      function renderForwardList() {}
      function updateForwardSubmit() {}
      function setTimeout() {}
      function displayName(c) { return c.profile_name; }
      function formatPhone(w) { return '+' + w; }
      function escapeHtml(s) { return String(s); }
      ${lift('stripCaption')}
      ${lift('labelForType')}
      ${lift('replyToOf')}
      ${lift('quotedMessage')}
      ${lift('senderName')}
      ${lift('snippetOf')}
      ${constBlock('NOT_FORWARDABLE')}
      ${lift('openForwardModal')}
      return { state, thread, toasts, quotedMessage, senderName, snippetOf, openForwardModal };
    `)();

    await test('a reply finds the message it quotes by wa_message_id', async () => {
      const t = ui.thread('W');
      t.byId.set(1, { id: 1, wa_id: 'W', wa_message_id: 'wamid.A', direction: 'in', type: 'text', body: 'Can I change my plan?' });
      t.byId.set(2, { id: 2, wa_id: 'W', wa_message_id: 'wamid.B', direction: 'out', type: 'text', body: 'Sure', media_meta: { reply_to: 'wamid.A' } });
      t.byId.set(3, { id: 3, wa_id: 'W', direction: 'in', type: 'text', body: 'old', media_meta: { reply_to: 'wamid.GONE' } });
      const q = ui.quotedMessage(t.byId.get(2));
      assert.strictEqual(q && q.id, 1);
      assert.strictEqual(ui.senderName(q), 'Sara');
      assert.strictEqual(ui.senderName(t.byId.get(2)), 'You');
      assert.strictEqual(ui.quotedMessage(t.byId.get(3)), null);
      assert.strictEqual(ui.snippetOf({ type: 'audio', body: '🎤 Voice message', media_meta: { voice: true } }), '🎤 Voice message');
    });

    await test('forward: stored media opens the picker without media_path', async () => {
      ui.openForwardModal({ id: 9, wa_id: 'W', type: 'audio', media_status: 'stored', media_meta: {} });
      assert.ok(ui.state.forward && ui.state.forward.msgId === 9, 'picker did not open');
      assert.deepStrictEqual(ui.toasts, []);
    });

    await test('forward: unstored media says why', async () => {
      ui.state.forward = null;
      ui.openForwardModal({ id: 10, type: 'image', media_status: 'expired' });
      ui.openForwardModal({ id: 11, type: 'image', media_status: 'pending' });
      assert.strictEqual(ui.state.forward, null);
      assert.ok(/deleted/.test(ui.toasts[0]) && /downloading/.test(ui.toasts[1]), ui.toasts.join(' | '));
    });
  }

  // ---- summary ----
  console.log(`\n\x1b[1mRESULT:\x1b[0m ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
