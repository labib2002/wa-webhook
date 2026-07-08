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
// Force a hermetic environment: blank out any real Supabase creds from .env so
// the suite NEVER touches the live database.
process.env.VERIFY_TOKEN = 'vibecode123';
process.env.APP_SECRET = 'test_app_secret';
process.env.SESSION_SECRET = 'test_session_secret_0123456789';
process.env.DASHBOARD_PASSCODE = 'letmein';
process.env.NODE_ENV = 'test';
// Empty (not delete): dotenv won't override an already-present key, so this
// survives the dotenv.config() inside api/index.js and keeps the DB unconfigured.
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

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
function req(srv, method, path, { body, headers } = {}) {
  const port = srv.address().port;
  const payload = body ? JSON.stringify(body) : null;
  const h = { 'Content-Type': 'application/json', ...(headers || {}) };
  return fetch(`http://127.0.0.1:${port}${path}`, { method, headers: h, body: payload })
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
  console.log('\n\x1b[1mFORWARD + READ/UNREAD ROUTES (fake DB)\x1b[0m');
  const dbmod = require('../lib/db');
  const wa = require('../lib/whatsapp');
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

  await test('service send: WA_TEMPLATE_ALLOWLIST env overrides the ops_ prefix rule', async () => {
    process.env.WA_TEMPLATE_ALLOWLIST = 'custom_one';
    wa.sendTemplate = async () => ({ ok: true, waMessageId: 'wamid.TPL2' });
    const allowed = await svc('POST', '/api/service/send-template', { to: '201000000009', template: 'custom_one' });
    assert.strictEqual(allowed.status, 200);
    const blocked = await svc('POST', '/api/service/send-template', { to: '201000000009', template: 'ops_group_invite' });
    assert.strictEqual(blocked.status, 400);
    process.env.WA_TEMPLATE_ALLOWLIST = '';
  });

  srv2.close();
  dbmod.__setDbForTesting(null);

  // ---- summary ----
  console.log(`\n\x1b[1mRESULT:\x1b[0m ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
