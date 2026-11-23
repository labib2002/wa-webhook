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
process.env.NODE_ENV = 'test';
// Empty (not delete): dotenv won't override an already-present key, so this
// survives the dotenv.config() inside api/index.js and keeps the DB unconfigured.
process.env.DATABASE_URL = '';

const { ingestWebhook, describeMessage, __setMediaFetcher } = require('../lib/ingest');
// Sign-in asks the backend; here a stand-in answers, never a real one.
const backend = require('./fake-backend').install();
const ME = { email: 'naglaa@byte.test', password: 'demo' };

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
  const staff = require('../lib/staff');
  const login = (body, headers) => req(srv, 'POST', '/api/login', { body, headers });
  const said = (r) => JSON.parse(r.text).error;

  await test('sign-in: a wrong password and an unknown email get the same sentence and no session', async () => {
    const wrong = await login({ email: ME.email, password: 'nope' });
    assert.strictEqual(wrong.status, 401);
    assert.strictEqual(said(wrong), staff.SENTENCES.wrong);
    assert.strictEqual(wrong.headers.get('set-cookie'), null);
    const unknown = await login({ email: 'nobody@byte.test', password: 'demo' });
    assert.strictEqual(unknown.status, 401);
    assert.strictEqual(said(unknown), staff.SENTENCES.wrong);
  });
  await test('sign-in: an empty email or password is refused before the backend is asked', async () => {
    const before = backend.calls.length;
    for (const body of [{}, { email: ME.email }, { password: 'demo' }, { email: '   ', password: 'demo' }, { email: ME.email, password: 5 }, { passcode: 'letmein' }]) {
      const r = await login(body);
      assert.strictEqual(r.status, 400);
      assert.strictEqual(said(r), staff.SENTENCES.missing);
    }
    assert.strictEqual(backend.calls.length, before);
  });
  await test('sign-in: a view-only account and one with no ops role are refused in plain words', async () => {
    for (const email of ['viewer@byte.test', 'norole@byte.test']) {
      const r = await login({ email, password: 'demo' });
      assert.strictEqual(r.status, 403, email);
      assert.strictEqual(said(r), staff.SENTENCES.role);
      assert.strictEqual(r.headers.get('set-cookie'), null);
    }
  });
  await test('sign-in: the backend not answering, or answering nonsense, is its own sentence', async () => {
    backend.state.down = true;
    try {
      const r = await login(ME);
      assert.strictEqual(r.status, 503);
      assert.strictEqual(said(r), staff.SENTENCES.down);
    } finally { backend.state.down = false; }
    staff.__setBackendForTesting(async () => ({ status: 200, json: async () => { throw new Error('not json'); } }));
    try {
      assert.strictEqual((await login(ME)).status, 503);
    } finally { staff.__setBackendForTesting(backend.fetchImpl); }
  });
  await test("sign-in: the backend's own limit is passed on as a wait", async () => {
    backend.state.limited = true;
    try {
      const r = await login(ME);
      assert.strictEqual(r.status, 429);
      assert.strictEqual(said(r), staff.SENTENCES.limited);
    } finally { backend.state.limited = false; }
  });
  await test('sign-in: the right password opens a session that says who it is and holds no password or backend token', async () => {
    backend.calls.length = 0;
    const r = await login(ME, { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' });
    assert.strictEqual(r.status, 200);
    const setCookie = r.headers.get('set-cookie') || '';
    assert.match(setCookie, /wa_session=/);
    assert.match(setCookie, /HttpOnly/);
    assert.deepStrictEqual(JSON.parse(r.text).agent, { name: 'Naglaa', email: ME.email, image: null });
    const token = decodeURIComponent(setCookie.split(';')[0].split('=')[1]);
    const held = Buffer.from(token.split('.')[1], 'base64url').toString('utf8');
    assert.deepStrictEqual(Object.keys(JSON.parse(held)).sort(), ['a', 'e', 'n', 'x']);
    assert.ok(!held.includes('demo') && !held.includes('tok-'), 'the session holds a secret');
    assert.deepStrictEqual(backend.calls.map((c) => `${c.method} ${c.path}`), ['POST /api/auth/v1/admins/login', 'GET /api/ops/v1/me']);
    for (const c of backend.calls) {
      assert.strictEqual(c.headers['x-byteplus-client'], 'inbox');
      assert.strictEqual(c.headers['x-forwarded-for'], '203.0.113.9', 'the backend must count the agent, not the inbox');
    }
    const cookie = setCookie.split(';')[0];
    const session = JSON.parse((await req(srv, 'GET', '/api/session', { headers: { cookie } })).text);
    assert.strictEqual(session.authed, true);
    assert.deepStrictEqual(session.agent, { name: 'Naglaa', email: ME.email, image: null });
    assert.strictEqual(JSON.parse((await req(srv, 'GET', '/api/session')).text).authed, false);
  });
  await test('sign-in: the name is the first and last name on the account', async () => {
    backend.accounts['full@byte.test'] = { password: 'demo', admin_id: 40, first_name: ' Rafeek ', last_name: 'Ishak', opsRole: 'super_admin' };
    assert.strictEqual(JSON.parse((await login({ email: ' full@byte.test ', password: 'demo' })).text).agent.name, 'Rafeek Ishak');
    backend.accounts['bare@byte.test'] = { password: 'demo', admin_id: 41, first_name: '', last_name: null, opsRole: 'ops' };
    assert.strictEqual(JSON.parse((await login({ email: 'bare@byte.test', password: 'demo' })).text).agent.name, 'bare');
    backend.accounts['twice@byte.test'] = { password: 'demo', admin_id: 42, first_name: 'Labib', last_name: 'labib', opsRole: 'super_admin' };
    assert.strictEqual(JSON.parse((await login({ email: 'twice@byte.test', password: 'demo' })).text).agent.name, 'Labib');
  });
  await test('sign-in: the picture on the staff account comes with the session, and a bad one is dropped', async () => {
    const PIC = { url: 'https://storage.test/uploads/profiles/2159', backgroundColor: '#00FFFF' };
    backend.accounts['pic@byte.test'] = { password: 'demo', admin_id: 50, first_name: 'Ali', last_name: 'Farag', opsRole: 'super_admin', image: PIC };
    const r = await login({ email: 'pic@byte.test', password: 'demo' });
    assert.deepStrictEqual(JSON.parse(r.text).agent.image, PIC);
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    assert.deepStrictEqual(JSON.parse((await req(srv, 'GET', '/api/session', { headers: { cookie } })).text).agent.image, PIC);
    const held = Buffer.from(decodeURIComponent(cookie.split('=')[1]).split('.')[1], 'base64url').toString('utf8');
    assert.ok(!held.includes('storage.test'), 'the picture is not put in the cookie');
    for (const [i, image] of [{ url: 'http://plain.test/a.png' }, { url: 'javascript:alert(1)' }, 'not json', { backgroundColor: '#fff' }].entries()) {
      backend.accounts[`badpic${i}@byte.test`] = { password: 'demo', admin_id: 60 + i, first_name: 'Bad', last_name: 'Pic', opsRole: 'ops', image };
      assert.strictEqual(JSON.parse((await login({ email: `badpic${i}@byte.test`, password: 'demo' })).text).agent.image, null);
    }
    assert.deepStrictEqual(staff.pictureOf(JSON.stringify(PIC)), PIC, 'the database may hand json back as text');
    assert.deepStrictEqual(staff.pictureOf({ url: PIC.url, backgroundColor: 'red' }), { url: PIC.url, backgroundColor: null });
  });
  await test('the re-check picks up a new or removed picture; before 014 the picture comes from the sign-in only', async () => {
    const NEW = { url: 'https://storage.test/uploads/profiles/staff-50', backgroundColor: '#00FFFFFF' };
    const acc = backend.accounts['pic@byte.test'];
    staff.__forget();
    const r = await login({ email: 'pic@byte.test', password: 'demo' });
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    staff.__forget();
    staff.__setLookupForTesting(backend.lookup);
    let s = JSON.parse((await req(srv, 'GET', '/api/session', { headers: { cookie } })).text);
    assert.strictEqual(s.authed, true);
    assert.strictEqual(s.agent.image, null, 'a lookup without the picture column cannot invent one after a restart');
    acc.lookupImage = NEW;
    staff.__forget();
    s = JSON.parse((await req(srv, 'GET', '/api/session', { headers: { cookie } })).text);
    assert.deepStrictEqual(s.agent.image, NEW);
    acc.lookupImage = null;
    staff.__forget();
    s = JSON.parse((await req(srv, 'GET', '/api/session', { headers: { cookie } })).text);
    assert.strictEqual(s.agent.image, null, 'a picture removed on the dashboard goes away here too');
    delete acc.lookupImage;
    staff.__forget();
  });
  await test('the address sent to the backend sits where it reads it, whatever the hop count', async () => {
    assert.strictEqual(staff.forwardedFor('203.0.113.9'), '203.0.113.9', 'one value: read as the caller by a backend trusting one hop or two');
    assert.strictEqual(staff.forwardedFor('::ffff:10.0.0.1'), '::ffff:10.0.0.1');
    assert.strictEqual(staff.forwardedFor(''), '127.0.0.1');
    assert.ok(!/[,\s]/.test(staff.forwardedFor('1.1.1.1, 9.9.9.9\r\nx: y')), 'a second address or a header cannot be smuggled in');
    process.env.BACKEND_PROXY_HOPS = '3';
    try { assert.strictEqual(staff.forwardedFor('203.0.113.9'), '203.0.113.9, 127.0.0.1, 127.0.0.1'); } finally { delete process.env.BACKEND_PROXY_HOPS; }
    // What a backend called directly on this box makes of it, as Express reads it.
    for (const trusted of [1, 2]) {
      const backendLike = require('express')();
      backendLike.set('trust proxy', trusted);
      backendLike.get('/ip', (q, s) => s.json({ ip: q.ip }));
      const listening = await new Promise((resolve) => { const l = http.createServer(backendLike).listen(0, '127.0.0.1', () => resolve(l)); });
      try {
        const r = await fetch(`http://127.0.0.1:${listening.address().port}/ip`, { headers: { 'x-forwarded-for': staff.forwardedFor('203.0.113.9') } });
        assert.strictEqual((await r.json()).ip, '203.0.113.9', `a backend trusting ${trusted} hop(s)`);
      } finally { listening.close(); }
    }
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

  await test('a reaction shows in the list but does not make the chat need a reply', async () => {
    const { needsReply } = require('../lib/inbox');
    const row = () => db._tables.conversations.find((c) => c.wa_id === '201001234567');
    const answered = '2024-06-01T00:00:00.000Z';
    Object.assign(row(), { last_message_direction: 'out', last_message_at: answered, unread_count: 0, done_at: null });
    await ingestWebhook(inboundReaction('wamid.REACTABLE', '👍'), db);
    let after = db._tables.conversations.find((c) => c.wa_id === '201001234567');
    assert.strictEqual(after.last_message_text, '👍 Reacted to your message');
    assert.strictEqual(after.last_message_direction, 'out', 'our message is still the last one to answer');
    assert.strictEqual(after.unread_count, 0, 'a reaction is not unread');
    assert.ok(Date.parse(after.last_message_at) > Date.parse(answered), 'the chat still rises in the list');
    assert.strictEqual(needsReply(after), false, 'answered chat + reaction: no reply needed');

    Object.assign(row(), { last_message_direction: 'in', last_message_at: answered, unread_count: 0, done_at: '2024-06-05T00:00:00.000Z' });
    await ingestWebhook(inboundReaction('wamid.REACTABLE', '❤️'), db);
    after = db._tables.conversations.find((c) => c.wa_id === '201001234567');
    assert.strictEqual(needsReply(after), false, 'a chat marked done stays done after a reaction');

    Object.assign(row(), { last_message_direction: 'in', last_message_at: answered, unread_count: 0, done_at: null });
    await ingestWebhook(inboundReaction('wamid.REACTABLE', '😂'), db);
    after = db._tables.conversations.find((c) => c.wa_id === '201001234567');
    assert.strictEqual(needsReply(after), true, 'a question still waiting keeps waiting');
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

  await test('a message WhatsApp cannot hand over is labelled as one that cannot be shown', async () => {
    const { body } = describeMessage({ type: 'unsupported', errors: [{ code: 131051 }] });
    assert.strictEqual(body, "⚠️ Message that can't be shown");
  });

  await test('what WhatsApp says about a message it cannot hand over is kept with the row', async () => {
    const said = describeMessage({ type: 'unsupported', unsupported: { type: 'album' }, errors: [{ code: 131051, title: 'Message type unknown' }] }).media_meta.said;
    assert.deepStrictEqual(said, { unsupported: { type: 'album' }, errors: [{ code: 131051, title: 'Message type unknown' }] });
    assert.deepStrictEqual(describeMessage({ type: 'unsupported' }).media_meta.said, { unsupported: null, errors: null });
    const huge = describeMessage({ type: 'unsupported', errors: [{ title: 'x'.repeat(2000) }] });
    assert.ok(!huge.media_meta || !huge.media_meta.said, 'an oversized payload is not stored');
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

  await test('a late "delivered" does not take the blue ticks back', async () => {
    db._tables.messages.push({
      id: 1001, wa_message_id: 'wamid.OUT3', wa_id: '201001234567',
      direction: 'out', type: 'text', body: 'seen', status: 'sent',
    });
    const row = () => db._tables.messages.find((m) => m.id === 1001);
    await ingestWebhook(statusUpdate('wamid.OUT3', 'read'), db);
    await ingestWebhook(statusUpdate('wamid.OUT3', 'delivered'), db);
    assert.strictEqual(row().status, 'read');
    await ingestWebhook(statusUpdate('wamid.OUT3', 'sent'), db);
    assert.strictEqual(row().status, 'read');
    await ingestWebhook(statusUpdate('wamid.OUT3', 'failed'), db);
    assert.strictEqual(row().status, 'read', 'a message that was read cannot have failed');
    await ingestWebhook(statusUpdate('wamid.OUT3', 'played'), db);
    assert.strictEqual(row().status, 'played');
  });

  await test('a refusal keeps everything WhatsApp said: code, title and the detail line', async () => {
    const { failureText } = require('../lib/ingest');
    assert.strictEqual(
      failureText({ code: 131053, title: 'Media upload error', message: 'Media upload error', error_data: { details: 'Audio file is not a valid ogg' } }),
      'Media upload error (131053): Audio file is not a valid ogg',
    );
    assert.strictEqual(failureText({ code: 131047, title: 'Re-engagement message' }), 'Re-engagement message (131047)');
    assert.strictEqual(failureText({}), 'Delivery failed');
    db._tables.messages.push({
      id: 1002, wa_message_id: 'wamid.OUT4', wa_id: '201001234567',
      direction: 'out', type: 'audio', body: 'v', status: 'sent',
    });
    const payload = statusUpdate('wamid.OUT4', 'failed');
    payload.entry[0].changes[0].value.statuses[0].errors = [{ code: 131053, title: 'Media upload error', error_data: { details: 'Unsupported audio' } }];
    await ingestWebhook(payload, db);
    assert.strictEqual(db._tables.messages.find((m) => m.id === 1002).error, 'Media upload error (131053): Unsupported audio');
  });

  await test('a tapped template button or list choice arrives as the text the person chose', async () => {
    const btn = describeMessage({ type: 'button', button: { text: 'Yes, I will come', payload: 'yes' }, context: { id: 'wamid.TPL' } });
    assert.strictEqual(btn.body, 'Yes, I will come');
    assert.deepStrictEqual(btn.media_meta, { tapped: true, reply_to: 'wamid.TPL' });
    assert.strictEqual(describeMessage({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'a', title: 'Morning' } } }).body, 'Morning');
    assert.strictEqual(describeMessage({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'b', title: 'Sunday' } } }).body, 'Sunday');
    assert.strictEqual(describeMessage({ type: 'button' }).body, 'Tapped a button');
  });

  await test('a shared contact card keeps the name and the numbers', async () => {
    const d = describeMessage({ type: 'contacts', contacts: [
      { name: { formatted_name: 'Dr Mona Adel', first_name: 'Mona' }, phones: [{ phone: '+20 100 123 4567', wa_id: '201001234567', type: 'CELL' }] },
      { name: { first_name: 'Omar', last_name: 'Said' }, phones: [{ phone: '0100 000 0000' }] },
    ] });
    assert.strictEqual(d.body, '👤 Contact · Dr Mona Adel +1');
    assert.deepStrictEqual(d.media_meta.contacts, [
      { name: 'Dr Mona Adel', phones: [{ phone: '+20 100 123 4567', wa_id: '201001234567' }] },
      { name: 'Omar Said', phones: [{ phone: '0100 000 0000', wa_id: null }] },
    ]);
    assert.strictEqual(describeMessage({ type: 'contacts' }).body, '👤 Contact');
  });

  await test("a photo's pixel size is stored with it, so the inbox can hold its place", async () => {
    __setMediaFetcher(async (mediaId, waId, kind) => ({ path: `${waId}/${kind}/${mediaId}.jpg`, mime: 'image/jpeg', size: 1, pixels: { w: 1170, h: 2532 } }));
    await ingestWebhook(inboundImage('wamid.IMGSIZE'), db);
    const msg = db._tables.messages.find((m) => m.wa_message_id === 'wamid.IMGSIZE');
    assert.strictEqual(msg.media_meta.w, 1170);
    assert.strictEqual(msg.media_meta.h, 2532);
    assert.strictEqual(msg.media_meta.caption, 'a graph', 'the rest of media_meta is kept');
    __setMediaFetcher(async (mediaId, waId, kind) => ({ path: `${waId}/${kind}/${mediaId}.jpg`, mime: 'image/jpeg', size: 1 }));
  });

  await test('pixel size is read from JPEG (turned photos too), PNG, GIF and WebP headers', async () => {
    const { imageSize, parseVideoInfo } = require('../lib/dims');
    const u16 = (n) => [n >> 8, n & 255];
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 4, 0x92, 0, 0, 9, 0xe4, 8, 6, 0, 0, 0])]);
    assert.deepStrictEqual(imageSize(png), { w: 1170, h: 2532 });
    const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, ...u16(900), ...u16(1600), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    const app0 = Buffer.from([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
    assert.deepStrictEqual(imageSize(jpeg), { w: 1600, h: 900 });
    // Orientation 6: the camera was held upright, the file is stored on its side.
    const tiff = Buffer.concat([Buffer.from('MM'), Buffer.from([0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0])]);
    const exifBody = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, ...u16(exifBody.length + 2)]), exifBody]);
    const turned = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.from([0xff, 0xd9])]);
    assert.deepStrictEqual(imageSize(turned), { w: 900, h: 1600 });
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x40, 1, 0xf0, 0, 0, 0, 0])]);
    assert.deepStrictEqual(imageSize(gif), { w: 320, h: 240 });
    const riff = (kind, body) => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from(kind), Buffer.from([0, 0, 0, 0]), body]);
    assert.deepStrictEqual(imageSize(riff('VP8X', Buffer.from([0, 0, 0, 0, 0xff, 1, 0, 0xff, 1, 0]))), { w: 512, h: 512 });
    assert.deepStrictEqual(imageSize(riff('VP8 ', Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a, 0x00, 0x02, 0x00, 0x02]))), { w: 512, h: 512 });
    assert.strictEqual(imageSize(Buffer.from('not a picture at all, just some text')), null);
    assert.strictEqual(imageSize(Buffer.alloc(0)), null);
    assert.deepStrictEqual(parseVideoInfo('  Stream #0:0(und): Video: h264 (High), yuv420p, 720x1280 [SAR 1:1 DAR 9:16], 30 fps'), { w: 720, h: 1280 });
    assert.deepStrictEqual(parseVideoInfo('  Stream #0:0: Video: h264, yuv420p, 1920x1080, 30 fps\n    Side data:\n      displaymatrix: rotation of -90.00 degrees'), { w: 1080, h: 1920 });
    assert.strictEqual(parseVideoInfo('  Stream #0:0: Audio: opus, 48000 Hz, mono'), null);
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
  const loginRes = await req(srv2, 'POST', '/api/login', { body: ME });
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  const authed = (method, path, body) => req(srv2, method, path, { body, headers: { cookie } });
  const rowsForKey = (k) => fdb._tables.messages.filter((m) => m.client_key === k);
  // The suites below test sending itself; the window has its own tests here.
  const winMod = require('../lib/window');
  const realWindowCheck = winMod.check;
  winMod.check = async () => ({ open: true, last: null });

  await test('a closed 24-hour window: text, media, retry and forward are refused without calling WhatsApp', async () => {
    winMod.check = realWindowCheck;
    const calls = [];
    const was = { t: wa.sendText, m: wa.sendMedia, u: wa.uploadMedia };
    wa.sendText = async () => { calls.push('text'); return { ok: true, waMessageId: 'wamid.NO' }; };
    wa.sendMedia = async () => { calls.push('media'); return { ok: true, waMessageId: 'wamid.NO' }; };
    wa.uploadMedia = async () => { calls.push('upload'); return { ok: true, mediaId: 'M' }; };
    try {
      const OLD = '201000000041';
      const NEVER = '201000000042';
      const OPEN = '201000000043';
      const day = 24 * 3600 * 1000;
      fdb._tables.messages.push({ id: 7941, wa_id: OLD, direction: 'in', type: 'text', body: 'hi', status: 'received', created_at: new Date(Date.now() - day - 60000).toISOString() });
      fdb._tables.messages.push({ id: 7942, wa_id: OLD, direction: 'out', type: 'text', body: 'x', status: 'failed', error: 'e', created_at: new Date().toISOString() });
      fdb._tables.messages.push({ id: 7943, wa_id: OPEN, direction: 'in', type: 'text', body: 'hi', status: 'received', created_at: new Date(Date.now() - day + 60000).toISOString() });
      const t1 = await authed('POST', '/api/send', { wa_id: OLD, text: 'late' });
      assert.strictEqual(t1.status, 409);
      const j1 = JSON.parse(t1.text);
      assert.strictEqual(j1.code, 'WINDOW_CLOSED');
      assert.strictEqual(j1.error, 'The 24 hours are over. Only a template can be sent.');
      const t2 = await authed('POST', '/api/send', { wa_id: NEVER, text: 'first' });
      assert.strictEqual(t2.status, 409);
      assert.match(JSON.parse(t2.text).error, /not written to this number yet/);
      const m1 = await authed('POST', '/api/send-media', { wa_id: OLD, file_base64: Buffer.from('x').toString('base64'), mime: 'image/png', filename: 'a.png' });
      assert.strictEqual(m1.status, 409);
      const r1 = await authed('POST', '/api/retry/7942');
      assert.strictEqual(r1.status, 409);
      assert.strictEqual(fdb._tables.messages.find((m) => m.id === 7942).status, 'failed', 'a refused retry leaves the bubble failed');
      const f1 = JSON.parse((await authed('POST', '/api/forward', { message_id: 7943, wa_ids: [OLD, OPEN] })).text);
      assert.strictEqual(f1.sent, 1);
      assert.strictEqual(f1.results.find((r) => r.wa_id === OLD).code, 'WINDOW_CLOSED');
      assert.deepStrictEqual(calls, ['text'], 'only the open chat reached WhatsApp');
      const ok = await authed('POST', '/api/send', { wa_id: OPEN, text: 'in time' });
      assert.strictEqual(ok.status, 200);
      const msgs = JSON.parse((await authed('GET', `/api/messages?wa_id=${OLD}`)).text);
      assert.ok(msgs.server_now && Math.abs(Date.parse(msgs.server_now) - Date.now()) < 5000, 'the thread carries the server clock');
    } finally {
      wa.sendText = was.t; wa.sendMedia = was.m; wa.uploadMedia = was.u;
      winMod.check = async () => ({ open: true, last: null });
    }
  });

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

  console.log('\n\x1b[1mNOTIFICATIONS ON A PHONE OR CLOSED TAB (fake DB)\x1b[0m');
  const push = require('../lib/push');
  const pushed = [];
  push.__setSender(async (sub, payload, opts) => {
    if (sub.endpoint.endsWith('/gone')) throw Object.assign(new Error('gone'), { statusCode: 410 });
    pushed.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), opts });
  });
  const subKeys = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) };
  const APPLE = 'https://web.push.apple.com/QABCdevice1';

  await test('push routes are gated: no cookie → 401', async () => {
    assert.strictEqual((await req(srv2, 'GET', '/api/push/key')).status, 401);
    assert.strictEqual((await req(srv2, 'POST', '/api/push/subscribe', { body: { endpoint: APPLE, keys: subKeys } })).status, 401);
  });

  await test('the key route makes one key pair and keeps handing out the same one', async () => {
    const a = JSON.parse((await authed('GET', '/api/push/key')).text);
    const b = JSON.parse((await authed('GET', '/api/push/key')).text);
    assert.strictEqual(a.on, true);
    assert.ok(a.key.length > 80);
    assert.strictEqual(a.key, b.key);
    assert.strictEqual(fdb._tables.push_keys.length, 1);
    assert.match(fdb._tables.push_keys[0].subject, /^https:\/\//);
  });

  await test('subscribe stores a real push endpoint and refuses anything else', async () => {
    for (const endpoint of ['https://evil.example.com/x', 'http://web.push.apple.com/x', 'https://push.apple.com.evil.io/x', 'not a url']) {
      const r = await authed('POST', '/api/push/subscribe', { endpoint, keys: subKeys });
      assert.strictEqual(r.status, 400, endpoint);
    }
    assert.strictEqual((await authed('POST', '/api/push/subscribe', { endpoint: APPLE, keys: { p256dh: 'x', auth: 'y' } })).status, 400);
    assert.strictEqual((await authed('POST', '/api/push/subscribe', { endpoint: APPLE, keys: subKeys })).status, 200);
    assert.strictEqual((await authed('POST', '/api/push/subscribe', { endpoint: APPLE, keys: subKeys })).status, 200);
    assert.strictEqual(fdb._tables.push_subscriptions.length, 1);
  });

  await test('a new member message is pushed with the saved name, the text and the unread total', async () => {
    await authed('PATCH', '/api/conversations/201001234567', { name: 'Sara (NIS)' });
    pushed.length = 0;
    const n = await push.deliver('201001234567', 'Is my plan ready?');
    assert.strictEqual(n, 1);
    assert.strictEqual(pushed[0].endpoint, APPLE);
    assert.strictEqual(pushed[0].payload.title, 'Sara (NIS)');
    assert.strictEqual(pushed[0].payload.body, 'Is my plan ready?');
    assert.strictEqual(pushed[0].payload.wa_id, '201001234567');
    assert.ok(Number.isInteger(pushed[0].payload.unread));
    assert.ok(pushed[0].opts.vapidDetails.privateKey);
    await authed('PATCH', '/api/conversations/201001234567', { name: '' });
  });

  await test('an album from one member becomes one push, a second member gets their own', async () => {
    push.__reset(); // drop pushes still queued by the earlier ingest tests
    pushed.length = 0;
    const album = (id, type) => {
      const p = inboundImage(id);
      p.entry[0].changes[0].value.messages[0].type = type;
      if (type === 'unsupported') delete p.entry[0].changes[0].value.messages[0].image;
      return p;
    };
    await ingestWebhook(album('wamid.ALB0', 'unsupported'), fdb);
    await ingestWebhook(album('wamid.ALB1', 'image'), fdb);
    await ingestWebhook(album('wamid.ALB1', 'image'), fdb); // Meta retry: no second push
    const other = inboundText('hello from someone else', 'wamid.OTHER1');
    other.entry[0].changes[0].value.messages[0].from = '201119998877';
    other.entry[0].changes[0].value.contacts[0].wa_id = '201119998877';
    await ingestWebhook(other, fdb);
    await new Promise((r) => setTimeout(r, push.COALESCE_MS + 300));
    assert.strictEqual(pushed.length, 2);
    const mine = pushed.find((p) => p.payload.wa_id === '201001234567');
    assert.match(mine.payload.body, /Image/);
    assert.ok(pushed.some((p) => p.payload.wa_id === '201119998877' && p.payload.body === 'hello from someone else'));
  });

  await test('a device the push service says is gone is forgotten, one not seen for the length of a session is skipped', async () => {
    await authed('POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/gone', keys: subKeys });
    await authed('POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/stale', keys: subKeys });
    fdb._tables.push_subscriptions.find((s) => s.endpoint.endsWith('/stale')).seen_at = new Date(Date.now() - 31 * 86400000).toISOString();
    pushed.length = 0;
    const n = await push.deliver('201001234567', 'ping');
    assert.strictEqual(n, 1);
    assert.deepStrictEqual(pushed.map((p) => p.endpoint), [APPLE]);
    assert.ok(!fdb._tables.push_subscriptions.some((s) => s.endpoint.endsWith('/gone')));
  });

  await test('unsubscribe removes the device', async () => {
    assert.strictEqual((await authed('POST', '/api/push/unsubscribe', { endpoint: APPLE })).status, 200);
    assert.ok(!fdb._tables.push_subscriptions.some((s) => s.endpoint === APPLE));
    pushed.length = 0;
    await push.deliver('201001234567', 'ping');
    assert.strictEqual(pushed.length, 0);
  });

  {
    const vm = require('vm');
    const swSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'web', 'sw.js'), 'utf8');
    const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
    const IPHONE_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
    const loadWorker = (userAgent, wins) => {
      const out = { handlers: {}, shown: [], badge: [], opened: [] };
      const self = {
        navigator: { userAgent, setAppBadge: async (n) => out.badge.push(n), clearAppBadge: async () => out.badge.push(0) },
        addEventListener: (type, fn) => { out.handlers[type] = fn; },
        skipWaiting() {},
        clients: { matchAll: async () => wins, claim: async () => {}, openWindow: async (u) => { out.opened.push(u); } },
        registration: { showNotification: async (title, opts) => { out.shown.push({ title, ...opts }); } },
      };
      vm.runInNewContext(swSrc, { self, URL });
      out.fire = async (type, event) => {
        const waits = [];
        out.handlers[type]({ ...event, waitUntil: (pr) => waits.push(pr) });
        await Promise.all(waits);
      };
      return out;
    };
    const payload = { title: 'Sara (NIS)', body: 'Is my plan ready?', wa_id: '201001234567', unread: 3 };
    const pushEvent = { data: { json: () => payload } };
    const front = { focused: true, visibilityState: 'visible', url: 'https://inbox.example/app' };
    const behind = { focused: false, visibilityState: 'hidden', url: 'https://inbox.example/app' };

    await test('worker: with the inbox behind another window a push shows the name, the text, one per chat', async () => {
      const w = loadWorker(CHROME, [behind]);
      await w.fire('push', pushEvent);
      assert.strictEqual(w.shown.length, 1);
      assert.strictEqual(w.shown[0].title, 'Sara (NIS)');
      assert.strictEqual(w.shown[0].body, 'Is my plan ready?');
      assert.strictEqual(w.shown[0].tag, 'wa-201001234567');
      assert.deepStrictEqual(w.badge, [3]);
    });

    await test('worker: on a desktop browser the inbox in front is not notified twice', async () => {
      const w = loadWorker(CHROME, [front]);
      await w.fire('push', pushEvent);
      assert.strictEqual(w.shown.length, 0);
    });

    await test('worker: an iPhone always shows it, or iOS drops the subscription', async () => {
      const w = loadWorker(IPHONE_APP, [front]);
      await w.fire('push', pushEvent);
      assert.strictEqual(w.shown.length, 1);
    });

    await test('worker: a push it cannot read still shows a notification', async () => {
      const w = loadWorker(IPHONE_APP, []);
      await w.fire('push', { data: { json: () => { throw new Error('bad'); } } });
      assert.strictEqual(w.shown.length, 1);
      assert.strictEqual(w.shown[0].title, 'New message');
    });

    await test('worker: tapping it opens the chat in the open inbox, or opens the inbox on that chat', async () => {
      const posted = [];
      const win = { ...behind, focus: async () => {}, postMessage: (m) => posted.push(m) };
      const note = { close() {}, data: { wa_id: '201001234567' } };
      const open = loadWorker(CHROME, [win]);
      await open.fire('notificationclick', { notification: note });
      assert.strictEqual(JSON.stringify(posted), JSON.stringify([{ type: 'open-chat', wa_id: '201001234567' }]));
      assert.strictEqual(open.opened.length, 0);
      const closed = loadWorker(CHROME, []);
      await closed.fire('notificationclick', { notification: note });
      assert.strictEqual(closed.opened.join(), '/app#chat=201001234567');
    });
  }

  await test('before migration 010 the key route says off and a new message is still stored', async () => {
    const realFrom = fdb.from;
    const missing = { code: '42P01', message: 'relation "wa.push_keys" does not exist' };
    const gone = () => {
      const f = {
        eq: () => f, gte: () => f, gt: () => f, select: () => f, delete: () => f,
        upsert: () => f,
        maybeSingle: () => Promise.resolve({ data: null, error: missing }),
        then: (res) => res({ data: null, error: missing }),
      };
      return f;
    };
    fdb.from = (table) => (table.startsWith('push_') ? gone() : realFrom(table));
    push.__reset();
    try {
      const k = JSON.parse((await authed('GET', '/api/push/key')).text);
      assert.strictEqual(k.on, false);
      assert.strictEqual((await authed('POST', '/api/push/subscribe', { endpoint: APPLE, keys: subKeys })).status, 503);
      const before = fdb._tables.messages.length;
      await ingestWebhook(inboundText('still works', 'wamid.NOPUSH1'), fdb);
      assert.strictEqual(fdb._tables.messages.length, before + 1);
      assert.strictEqual(await push.deliver('201001234567', 'x'), 0);
    } finally {
      fdb.from = realFrom;
      push.__reset();
    }
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
    assert.deepStrictEqual(row('201000000020').member, { name: 'Mohamed Ali Hassan', company: 'Nawy Degla', kind: 'member', active: true, more: 0, image: null, image_bg: null });
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
    assert.deepStrictEqual(m, { name: 'Moved Person', company: 'Nawy Degla', kind: 'member', active: true, more: 1, image: null, image_bg: null });
  });
  await test("members: the picture from the Byte+ app comes with the member, and only from our own storage", async () => {
    const app = (image, image_bg) => ({ source: 'app', kind: 'member', name: 'A', company: 'C', active: true, image, image_bg });
    assert.deepStrictEqual(members.pictureOf([app('https://storage.bytepluslife.com/uploads/profiles/2165', '#00FFFFFF')]),
      { image: 'https://storage.bytepluslife.com/uploads/profiles/2165', image_bg: null });
    assert.deepStrictEqual(members.pictureOf([app('https://storage.bytepluslife.com/individual_avatars_png/Number=7.png?', '#FFE8F4D9')]),
      { image: 'https://storage.bytepluslife.com/individual_avatars_png/Number=7.png', image_bg: '#E8F4D9' });
    assert.deepStrictEqual(members.pictureOf([app('no image', '#00FFFFFF')]), { image: null, image_bg: null });
    assert.deepStrictEqual(members.pictureOf([app('https://evil.example/x.png', null)]), { image: null, image_bg: null });
    assert.deepStrictEqual(members.pictureOf([app('http://storage.bytepluslife.com/x.png', null)]), { image: null, image_bg: null });
    const picked = members.pick([
      { source: 'roster', kind: 'member', name: 'Sara Roster', company: 'NIS', active: true },
      app('https://storage.bytepluslife.com/uploads/profiles/9', '#00FFFFFF'),
    ]);
    assert.strictEqual(picked.name, 'Sara Roster');
    assert.strictEqual(picked.image, 'https://storage.bytepluslife.com/uploads/profiles/9');
  });
  members.__setLookupForTesting(async () => []);

  // --- who answered, what needs a reply, paging and search, saved replies ---
  console.log('\n\x1b[1mTEAMWORK: NEEDS REPLY, AGENT NAMES, SEARCH, SAVED REPLIES (fake DB)\x1b[0m');
  {
    const features = require('../lib/features');
    const inbox = require('../lib/inbox');
    const auth = require('../lib/auth');
    const cookies = {};
    const signIn = async (email) => {
      if (!cookies[email]) cookies[email] = ((await req(srv2, 'POST', '/api/login', { body: { email, password: 'demo' } })).headers.get('set-cookie') || '').split(';')[0];
      return cookies[email];
    };
    const as = (email) => async (method, path, body, headers) => req(srv2, method, path, { body, headers: { cookie: await signIn(email), ...(headers || {}) } });
    const list = async (query = '') => JSON.parse((await authed('GET', `/api/conversations${query}`)).text);
    const conv = (id) => fdb._tables.conversations.find((c) => c.wa_id === id);
    const T = '201000007001';
    const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
    fdb._tables.conversations.push({ wa_id: T, profile_name: 'Team Chat', last_message_text: 'help please', last_message_at: minsAgo(5), last_message_direction: 'in', unread_count: 2 });

    await test('opening a chat does not clear it for the other agents', async () => {
      assert.strictEqual((await authed('POST', '/api/mark-read', { wa_id: T })).status, 200);
      assert.strictEqual(conv(T).unread_count, 2);
      const j = await list('?view=needs_reply');
      assert.ok(j.conversations.some((c) => c.wa_id === T && c.needs_reply));
      assert.strictEqual(j.teamwork, true);
    });

    await test('a reply clears it, and the message carries the name on the account that sent it', async () => {
      wa.sendText = async () => ({ ok: true, waMessageId: 'wamid.TEAM1' });
      const r = await as('arabic@byte.test')('POST', '/api/send', { wa_id: T, text: 'on it', client_key: 'team-1' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(JSON.parse(r.text).message.agent, 'Naglaa ناجلاء');
      assert.strictEqual(conv(T).unread_count, 0);
      assert.ok(!(await list('?view=needs_reply')).conversations.some((c) => c.wa_id === T));
      const thread = JSON.parse((await authed('GET', `/api/messages?wa_id=${T}`)).text);
      assert.strictEqual(thread.messages.find((m) => m.wa_message_id === 'wamid.TEAM1').agent, 'Naglaa ناجلاء');
      const keyless = await as('youssef@byte.test')('POST', '/api/send', { wa_id: T, text: 'and again' });
      assert.strictEqual(JSON.parse(keyless.text).message.agent, 'Youssef');
      const posing = await as('youssef@byte.test')('POST', '/api/send', { wa_id: T, text: 'not me' }, { 'x-agent-name': 'Naglaa' });
      assert.strictEqual(JSON.parse(posing.text).message.agent, 'Youssef', 'a name sent by the browser must not be believed');
    });

    await test('photos, templates and forwards carry the name too', async () => {
      wa.uploadMedia = async () => ({ ok: true, mediaId: 'M' });
      wa.sendMedia = async () => ({ ok: true, waMessageId: 'wamid.TEAMPIC' });
      const pic = await as('naglaa@byte.test')('POST', '/api/send-media', { wa_id: T, file_base64: Buffer.from('x').toString('base64'), mime: 'image/png', filename: 'a.png', client_key: 'team-pic' });
      assert.strictEqual(JSON.parse(pic.text).message.agent, 'Naglaa');
      wa.sendTemplate = async () => ({ ok: true, waMessageId: 'wamid.TEAMTPL' });
      await as('naglaa@byte.test')('POST', '/api/send-template', { wa_id: T, template: 'ops_support_followup', language: 'en', params: ['Sara', 'the plan'], client_key: 'team-tpl' });
      assert.strictEqual(rowsForKey('team-tpl')[0].agent, 'Naglaa');
      wa.sendText = async () => ({ ok: true, waMessageId: 'wamid.TEAMFWD' });
      const src = fdb._tables.messages.find((m) => m.wa_message_id === 'wamid.TEAM1');
      const fwd = JSON.parse((await as('oufa@byte.test')('POST', '/api/forward', { message_id: src.id, wa_ids: ['201000000012'] })).text);
      assert.strictEqual(fwd.results[0].message.agent, 'Oufa');
    });

    await test('a new message from the member needs a reply again; "done" takes it off the list until they write', async () => {
      Object.assign(conv(T), { last_message_direction: 'in', last_message_at: minsAgo(2), unread_count: 1 });
      assert.ok((await list('?view=needs_reply')).conversations.some((c) => c.wa_id === T));
      const done = JSON.parse((await authed('POST', `/api/conversations/${T}/read`, { read: true })).text);
      assert.strictEqual(done.unread_count, 0);
      assert.ok(done.done_at);
      assert.ok(!(await list('?view=needs_reply')).conversations.some((c) => c.wa_id === T), 'done, though the member wrote last');
      Object.assign(conv(T), { last_message_at: new Date(Date.now() + 1000).toISOString() });
      assert.ok((await list('?view=needs_reply')).conversations.some((c) => c.wa_id === T), 'they wrote after it was marked done');
      await authed('POST', `/api/conversations/${T}/read`, { read: true });
      const flagged = JSON.parse((await authed('POST', `/api/conversations/${T}/read`, { read: false })).text);
      assert.strictEqual(flagged.unread_count, 1);
      assert.strictEqual(conv(T).done_at, null);
      assert.ok((await list('?view=needs_reply')).conversations.some((c) => c.wa_id === T), 'flagged by hand');
      await authed('POST', `/api/conversations/${T}/read`, { read: true });
    });

    await test('needsReply: answered, done, flagged and never-written chats', async () => {
      const at = '2026-11-23T10:00:00Z';
      assert.strictEqual(inbox.needsReply({ last_message_direction: 'in', last_message_at: at, unread_count: 0 }), true);
      assert.strictEqual(inbox.needsReply({ last_message_direction: 'out', last_message_at: at, unread_count: 0 }), false);
      assert.strictEqual(inbox.needsReply({ last_message_direction: 'out', last_message_at: at, unread_count: 1 }), true);
      assert.strictEqual(inbox.needsReply({ last_message_direction: 'in', last_message_at: at, unread_count: 0, done_at: '2026-11-23T10:05:00Z' }), false);
      assert.strictEqual(inbox.needsReply({ last_message_direction: 'in', last_message_at: at, unread_count: 0, done_at: '2026-11-23T09:00:00Z' }), true);
      assert.strictEqual(inbox.needsReply({ last_message_direction: null, last_message_at: null, unread_count: 0 }), false);
    });

    await test('a chat that holds only our templates is in the main list like any other', async () => {
      const A = '201000007101';
      fdb._tables.conversations.push(
        { wa_id: A, profile_name: 'Bulk One', last_message_text: '📋 hello', last_message_at: minsAgo(1), last_message_direction: 'out', unread_count: 0 },
      );
      const chats = await list();
      assert.ok(chats.conversations.some((c) => c.wa_id === A));
      assert.strictEqual(chats.counts.templates, undefined);
      assert.ok((await list('?view=templates')).conversations.some((c) => c.wa_id === A), 'an old tab asking for the removed view gets the main list');
    });

    await test('the list comes a page at a time, and search covers the chats beyond the first page', async () => {
      const made = [];
      for (let i = 0; i < 130; i++) {
        const wa_id = `2010099${String(i).padStart(5, '0')}`;
        made.push(wa_id);
        fdb._tables.conversations.push({ wa_id, profile_name: i === 129 ? 'Zeinab Far Away' : `Page Person ${i}`, last_message_text: 'x', last_message_at: new Date(Date.UTC(2020, 0, 1, 0, i)).toISOString(), last_message_direction: 'out', unread_count: 0 });
      }
      const first = await list();
      assert.strictEqual(first.conversations.length, 60);
      assert.strictEqual(first.next, 60);
      assert.ok(first.total >= 130);
      const second = await list('?offset=60&limit=60');
      assert.strictEqual(second.conversations.length, 60);
      assert.ok(!second.conversations.some((c) => first.conversations.some((d) => d.wa_id === c.wa_id)), 'pages overlap');
      const big = await list('?limit=1000');
      assert.ok(big.conversations.length <= 300, 'one request is capped');
      const far = await list('?q=zeinab');
      assert.deepStrictEqual(far.conversations.map((c) => c.profile_name), ['Zeinab Far Away']);
      assert.ok((await list('?q=0100 9900 129')).conversations.some((c) => c.wa_id === '201009900129'), 'a number typed the local way');
      fdb._tables.conversations = fdb._tables.conversations.filter((c) => !made.includes(c.wa_id));
    });

    await test('search also finds words inside messages and says where', async () => {
      inbox.__setForTesting({ messageSearch: async (q) => (q === 'refund' ? [{ wa_id: T, id: 4242, body: 'Hello, I asked about the refund for my watch last week and nobody answered yet', direction: 'in', at: minsAgo(30) }] : []) });
      const j = await list('?q=refund');
      assert.strictEqual(j.conversations.length, 0);
      assert.strictEqual(j.message_hits.length, 1);
      assert.strictEqual(j.message_hits[0].wa_id, T);
      assert.strictEqual(j.message_hits[0].hit.message_id, 4242);
      assert.ok(/refund/.test(j.message_hits[0].hit.text));
      assert.strictEqual((await list('?q=r')).message_hits.length, 0, 'one letter does not search every message');
      assert.strictEqual(inbox.snippet('a'.repeat(200) + ' the refund is late ' + 'b'.repeat(200), 'refund').length <= 92, true);
      inbox.__setForTesting();
    });

    await test('a long chat opens on its newest 500 messages and says when the member last wrote', async () => {
      const L = '201000007201';
      fdb._tables.conversations.push({ wa_id: L, profile_name: 'Long Chat', last_message_at: minsAgo(1), last_message_direction: 'out', unread_count: 0 });
      for (let i = 0; i < 520; i++) {
        fdb._tables.messages.push({ id: 900000 + i, wa_id: L, direction: i === 510 ? 'in' : 'out', type: 'text', body: `m${i}`, status: 'sent', created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), wa_timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
      }
      const j = JSON.parse((await authed('GET', `/api/messages?wa_id=${L}`)).text);
      assert.strictEqual(j.messages.length, 500);
      assert.strictEqual(j.messages[0].body, 'm20');
      assert.strictEqual(j.messages[499].body, 'm519');
      assert.strictEqual(j.more, true);
      assert.strictEqual(j.last_inbound_at, new Date(Date.UTC(2026, 0, 1, 0, 0, 510)).toISOString());
      fdb._tables.messages = fdb._tables.messages.filter((m) => m.wa_id !== L);
      fdb._tables.conversations = fdb._tables.conversations.filter((c) => c.wa_id !== L);
    });

    await test('saved replies: add, change, remove, and refuse an empty one', async () => {
      const made = JSON.parse((await as('naglaa@byte.test')('POST', '/api/saved-replies', { title: 'Sync steps', body: 'Open the app and pull down to sync.' })).text).reply;
      assert.ok(made.id);
      assert.strictEqual(made.created_by, 'Naglaa');
      assert.strictEqual((await authed('POST', '/api/saved-replies', { title: '', body: 'x' })).status, 400);
      assert.strictEqual((await authed('POST', '/api/saved-replies', { title: 'x', body: '   ' })).status, 400);
      const changed = JSON.parse((await authed('PATCH', `/api/saved-replies/${made.id}`, { title: 'Sync steps', body: 'Pull down on Home to sync.' })).text).reply;
      assert.strictEqual(changed.body, 'Pull down on Home to sync.');
      let all = JSON.parse((await authed('GET', '/api/saved-replies')).text);
      assert.strictEqual(all.on, true);
      assert.strictEqual(all.replies.length, 1);
      assert.strictEqual((await authed('PATCH', '/api/saved-replies/999999', { title: 'a', body: 'b' })).status, 404);
      assert.strictEqual((await authed('DELETE', `/api/saved-replies/${made.id}`)).status, 200);
      all = JSON.parse((await authed('GET', '/api/saved-replies')).text);
      assert.strictEqual(all.replies.length, 0);
      assert.strictEqual((await req(srv2, 'GET', '/api/saved-replies')).status, 401);
    });

    await test("reacting to a member's message sends the reaction and shows it; our own messages cannot be reacted to", async () => {
      const sent = [];
      wa.sendReaction = async (to, id, emoji) => { sent.push({ to, id, emoji }); return { ok: true }; };
      fdb._tables.messages.push({ id: 7950, wa_id: T, wa_message_id: 'wamid.THEIRS', direction: 'in', type: 'text', body: 'thanks!', status: 'received' });
      const r = await authed('POST', '/api/react', { message_id: 7950, emoji: '❤️' });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(sent, [{ to: T, id: 'wamid.THEIRS', emoji: '❤️' }]);
      assert.strictEqual(fdb._tables.messages.find((m) => m.id === 7950).reaction, '❤️');
      await authed('POST', '/api/react', { message_id: 7950, emoji: '' });
      assert.strictEqual(fdb._tables.messages.find((m) => m.id === 7950).reaction, null);
      const ours = fdb._tables.messages.find((m) => m.wa_message_id === 'wamid.TEAM1');
      assert.strictEqual((await authed('POST', '/api/react', { message_id: ours.id, emoji: '👍' })).status, 400);
      assert.strictEqual((await authed('POST', '/api/react', { message_id: 7950, emoji: 'lol' })).status, 400);
      wa.sendReaction = async () => ({ ok: false, error: 'Outside the 24-hour reply window' });
      assert.strictEqual((await authed('POST', '/api/react', { message_id: 7950, emoji: '👍' })).status, 502);
    });

    await test('removing a person ends their session at the next re-check and stops their notifications', async () => {
      const youssef = as('youssef@byte.test');
      const account = backend.accounts['youssef@byte.test'];
      const DEVICE = 'https://fcm.googleapis.com/fcm/send/youssef-phone';
      assert.strictEqual((await youssef('GET', '/api/conversations')).status, 200);
      await youssef('POST', '/api/push/subscribe', { endpoint: DEVICE, keys: subKeys });
      assert.strictEqual(fdb._tables.push_subscriptions.find((x) => x.endpoint === DEVICE).admin_id, account.admin_id);
      for (const change of [{ active: false }, { opsRole: 'viewer' }, { opsRole: null }]) {
        const was = { ...account };
        Object.assign(account, change);
        try {
          assert.strictEqual((await youssef('GET', '/api/conversations')).status, 200, 'asked again before the re-check was due');
          staff.__forget(); // the re-check falls due
          const r = await youssef('GET', '/api/conversations');
          assert.strictEqual(r.status, 401);
          assert.deepStrictEqual(JSON.parse(r.text), { error: staff.SENTENCES.ended, ended: true });
          assert.match(r.headers.get('set-cookie') || '', /wa_session=;.*Max-Age=0/);
          const session = JSON.parse((await youssef('GET', '/api/session')).text);
          assert.strictEqual(session.authed, false);
          assert.strictEqual(session.ended, staff.SENTENCES.ended);
          assert.strictEqual((await authed('GET', '/api/conversations')).status, 200, 'everyone else stays in');
        } finally {
          for (const k of Object.keys(change)) { if (k in was) account[k] = was[k]; else delete account[k]; }
          staff.__forget();
        }
        assert.strictEqual((await youssef('GET', '/api/conversations')).status, 200);
      }
      account.active = false;
      staff.__forget();
      try {
        pushed.length = 0;
        await push.deliver(T, 'after they left');
        assert.ok(!pushed.some((x) => x.endpoint === DEVICE), 'a removed person was notified');
        assert.ok(!fdb._tables.push_subscriptions.some((x) => x.endpoint === DEVICE), 'and their device is forgotten');
      } finally {
        delete account.active;
        staff.__forget();
      }
    });

    await test('the staff lookup is asked once per person per re-check, and nobody is thrown out when it cannot answer', async () => {
      let asked = 0;
      staff.__setLookupForTesting(async (id) => { asked += 1; return backend.lookup(id); });
      try {
        await Promise.all([1, 2, 3, 4, 5].map(() => authed('GET', '/api/conversations')));
        await authed('GET', '/api/conversations');
        assert.strictEqual(asked, 1);
        staff.__setLookupForTesting(async () => { throw Object.assign(new Error('function wa_lookup.staff(integer) does not exist'), { code: '42883' }); });
        assert.strictEqual((await authed('GET', '/api/conversations')).status, 200, 'migration 013 not run yet');
      } finally {
        staff.__setLookupForTesting(backend.lookup);
      }
    });

    await test('a device from the passcode days gets nothing until someone signs in on it', async () => {
      const OLD = 'https://fcm.googleapis.com/fcm/send/passcode-days';
      fdb._tables.push_subscriptions.push({ endpoint: OLD, p256dh: subKeys.p256dh, auth: subKeys.auth, seen_at: new Date().toISOString(), pass_mark: 'abc' });
      pushed.length = 0;
      await push.deliver(T, 'nobody signed in there');
      assert.ok(!pushed.some((x) => x.endpoint === OLD));
      assert.ok(fdb._tables.push_subscriptions.some((x) => x.endpoint === OLD), 'kept for the sign-in');
      await authed('POST', '/api/push/subscribe', { endpoint: OLD, keys: subKeys });
      assert.strictEqual(fdb._tables.push_subscriptions.find((x) => x.endpoint === OLD).admin_id, 19);
      pushed.length = 0;
      await push.deliver(T, 'now it is tied');
      assert.ok(pushed.some((x) => x.endpoint === OLD));
      fdb._tables.push_subscriptions = fdb._tables.push_subscriptions.filter((x) => x.endpoint !== OLD);
    });

    await test('a cookie from the passcode days, a forged one and a changed one do not open the inbox', async () => {
      const crypto = require('crypto');
      const mac = (v) => crypto.createHmac('sha256', process.env.SESSION_SECRET).update(v).digest('hex');
      const get = (token) => req(srv2, 'GET', '/api/conversations', { headers: { cookie: `wa_session=${encodeURIComponent(token)}` } });
      const expires = Date.now() + 3600 * 1000;
      assert.strictEqual((await get(`${expires}.${mac(String(expires))}`)).status, 401, 'first passcode shape');
      assert.strictEqual((await get(`${expires}.abcdef0123456789.${mac(`${expires}.abcdef0123456789`)}`)).status, 401, 'second passcode shape');
      const good = auth.issueToken({ adminId: 19, email: ME.email, name: 'Naglaa' });
      assert.strictEqual((await get(good)).status, 200);
      const [kind, body, sig] = good.split('.');
      const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), a: 22, n: 'Oufa' })).toString('base64url');
      assert.strictEqual((await get(`${kind}.${other}.${sig}`)).status, 401, 'changed who it is');
      assert.strictEqual((await get(`${kind}.${body}.${'0'.repeat(64)}`)).status, 401);
      assert.strictEqual((await get(auth.issueToken({ adminId: 19, email: ME.email, name: 'Naglaa' }, Date.now() - 1000))).status, 401, 'expired');
      assert.strictEqual((await get(auth.issueToken({ adminId: 999, email: 'x@y.z', name: 'Ghost' }))).status, 401, 'an account that does not exist');
    });

    await test('a session in use is renewed once a day, not on every request', async () => {
      assert.strictEqual((await authed('GET', '/api/conversations')).headers.get('set-cookie'), null, 'a fresh session is left alone');
      const aging = auth.issueToken({ adminId: 19, email: ME.email, name: 'Naglaa' }, Date.now() + auth.SESSION_TTL_MS - 2 * 86400000);
      const r = await req(srv2, 'GET', '/api/conversations', { headers: { cookie: `wa_session=${encodeURIComponent(aging)}` } });
      assert.strictEqual(r.status, 200);
      const fresh = auth.verifyToken(decodeURIComponent((r.headers.get('set-cookie') || '').split(';')[0].split('=')[1]));
      assert.ok(fresh && fresh.expires > Date.now() + auth.SESSION_TTL_MS - 60000, 'not renewed');
      assert.strictEqual(fresh.adminId, 19);
      assert.strictEqual(fresh.name, 'Naglaa');
    });

    await test('before migrations 011 and 013 the inbox works as it did: opening clears the count, no names, no saved replies, every device notified', async () => {
      features.__setForTesting({ agent: false, done: false, replies: false, staff: false });
      try {
        Object.assign(conv(T), { unread_count: 3, last_message_direction: 'in' });
        await authed('POST', '/api/mark-read', { wa_id: T });
        assert.strictEqual(conv(T).unread_count, 0);
        wa.sendText = async () => ({ ok: true, waMessageId: 'wamid.PRE011' });
        const sent = JSON.parse((await as('naglaa@byte.test')('POST', '/api/send', { wa_id: T, text: 'before', client_key: 'pre-011' })).text).message;
        assert.ok(!('agent' in sent), 'wrote a column that is not there yet');
        const j = await list();
        assert.strictEqual(j.teamwork, false);
        assert.ok(j.conversations.length > 0);
        assert.deepStrictEqual(JSON.parse((await authed('GET', '/api/saved-replies')).text), { on: false, replies: [] });
        assert.strictEqual((await authed('POST', '/api/saved-replies', { title: 'a', body: 'b' })).status, 503);
        const read = JSON.parse((await authed('POST', `/api/conversations/${T}/read`, { read: false })).text);
        assert.strictEqual(read.unread_count, 1);
        await authed('POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/pre-011', keys: subKeys });
        assert.ok(!('admin_id' in fdb._tables.push_subscriptions.find((s) => s.endpoint.endsWith('/pre-011'))));
        pushed.length = 0;
        await push.deliver(T, 'before 013');
        assert.ok(pushed.some((x) => x.endpoint.endsWith('/pre-011')));
      } finally {
        features.__setForTesting(null);
        fdb._tables.push_subscriptions = fdb._tables.push_subscriptions.filter((s) => !s.endpoint.endsWith('/pre-011'));
      }
    });
  }

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

  // --- inbox send-template (behind sign-in + narrower human allow-list) ---
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

    await test('two agents pressing Retry on one bubble: only the first sends', async () => {
      let sends = 0;
      let release;
      const gate = new Promise((r) => { release = r; });
      wa.sendText = async () => { sends++; await gate; return { ok: true, waMessageId: 'wamid.ONCE' }; };
      fdb._tables.messages.push({ id: 7910, wa_id: '201000000011', direction: 'out', type: 'text', body: 'once', status: 'failed', error: 'x' });
      const first = authed('POST', '/api/retry/7910');
      await new Promise((r) => setTimeout(r, 60));
      const second = await authed('POST', '/api/retry/7910');
      assert.strictEqual(second.status, 409);
      release();
      assert.strictEqual((await first).status, 200);
      assert.strictEqual(sends, 1, `WhatsApp was called ${sends} times`);
      const row = fdb._tables.messages.find((m) => m.id === 7910);
      assert.strictEqual(row.status, 'sent');
      assert.strictEqual((await authed('POST', '/api/retry/7910')).status, 409, 'a message that went through is not sent again');
    });

    await test('a retry WhatsApp refuses again goes back to failed with the new reason', async () => {
      wa.sendText = async () => ({ ok: false, error: 'Outside the 24-hour reply window' });
      fdb._tables.messages.push({ id: 7911, wa_id: '201000000011', direction: 'out', type: 'text', body: 'late', status: 'failed', error: 'old' });
      const r = await authed('POST', '/api/retry/7911');
      assert.strictEqual(r.status, 502);
      const row = fdb._tables.messages.find((m) => m.id === 7911);
      assert.strictEqual(row.status, 'failed');
      assert.strictEqual(row.error, 'Outside the 24-hour reply window');
    });

    await test('a resend that died half way can be taken again after two minutes, not before', async () => {
      wa.sendText = async () => ({ ok: true, waMessageId: 'wamid.STALE' });
      fdb._tables.messages.push({ id: 7912, wa_id: '201000000011', direction: 'out', type: 'text', body: 's', status: 'pending', updated_at: new Date(Date.now() - 30 * 1000).toISOString() });
      assert.strictEqual((await authed('POST', '/api/retry/7912')).status, 409);
      fdb._tables.messages.find((m) => m.id === 7912).updated_at = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      assert.strictEqual((await authed('POST', '/api/retry/7912')).status, 200);
    });

    await test('a voice note WhatsApp refused is sent again as an ordinary audio file', async () => {
      const transcode = require('../lib/transcode');
      const realM4a = transcode.toM4a;
      transcode.toM4a = async () => ({ ok: true, buffer: Buffer.from('aac-bytes'), mime: 'audio/mp4', ext: 'm4a' });
      const calls = [];
      wa.uploadMedia = async (buf, mime, name) => { calls.push({ mime, name, bytes: buf.toString() }); return { ok: true, mediaId: 'MEDIA_AAC' }; };
      wa.sendMedia = async (to, cat, id, opts) => { calls.push({ cat, voice: opts.voice }); return { ok: true, waMessageId: 'wamid.ASAUDIO' }; };
      fdb._tables.messages.push({
        id: 7913, wa_id: '201000000011', direction: 'out', type: 'audio', body: '🎤 Voice message', status: 'failed',
        error: 'Media upload error', media_path: '201000000011/out/k7913.ogg', media_status: 'stored',
        media_meta: { voice: true, mime_type: 'audio/ogg', filename: 'voice-note.ogg', caption: null },
      });
      const r = await authed('POST', '/api/retry/7913');
      transcode.toM4a = realM4a;
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(calls, [{ mime: 'audio/mp4', name: 'voice-note.m4a', bytes: 'aac-bytes' }, { cat: 'audio', voice: false }]);
      const row = fdb._tables.messages.find((m) => m.id === 7913);
      assert.strictEqual(row.status, 'sent');
      assert.strictEqual(row.media_meta.sent_as_audio, true);
      assert.strictEqual(row.media_meta.voice, null);
      assert.strictEqual(row.media_meta.mime_type, 'audio/mp4');
      assert.strictEqual(row.media_path, '201000000011/out/k7913.ogg.m4a');
      assert.strictEqual(row.body, '🎵 Audio');
    });

    const refusedStatus = (wamid, details) => {
      const payload = statusUpdate(wamid, 'failed');
      payload.entry[0].changes[0].value.statuses[0].errors = [{ code: 131053, title: 'Media upload error', error_data: details ? { details } : undefined }];
      return payload;
    };
    const voiceRow = (id, wamid, extra = {}) => ({
      id, wa_message_id: wamid, wa_id: '201000000011', direction: 'out', type: 'audio', body: '🎤 Voice message', status: 'sent',
      error: null, media_path: `201000000011/out/k${id}.ogg`, media_status: 'stored',
      media_meta: { voice: true, mime_type: 'audio/ogg', filename: 'voice-note.ogg', caption: null },
      created_at: new Date().toISOString(), ...extra,
    });
    const withAudioStubs = async (stubs, run) => {
      const transcode = require('../lib/transcode');
      const realM4a = transcode.toM4a;
      transcode.toM4a = stubs.toM4a || (async () => ({ ok: true, buffer: Buffer.from('aac-bytes'), mime: 'audio/mp4', ext: 'm4a' }));
      try { await run(); } finally { transcode.toM4a = realM4a; }
    };

    await test('a refused voice note from an hour ago does not re-send itself', async () => {
      const calls = [];
      wa.uploadMedia = async () => { calls.push('upload'); return { ok: true, mediaId: 'MEDIA_OLD' }; };
      wa.sendMedia = async () => { calls.push('send'); return { ok: true, waMessageId: 'wamid.OLD_AUDIO' }; };
      fdb._tables.messages.push(voiceRow(7919, 'wamid.REFUSED_OLD', { created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }));
      await withAudioStubs({}, async () => {
        const summary = await ingestWebhook(refusedStatus('wamid.REFUSED_OLD', 'Unsupported audio'), fdb);
        assert.ok(!summary.resent);
      });
      assert.deepStrictEqual(calls, []);
      const row = fdb._tables.messages.find((m) => m.id === 7919);
      assert.strictEqual(row.status, 'failed');
      assert.strictEqual(row.wa_message_id, 'wamid.REFUSED_OLD');
    });

    await test('a voice note WhatsApp refuses goes out again by itself, once, as an audio file in the same bubble', async () => {
      const calls = [];
      wa.uploadMedia = async (buf, mime, name) => { calls.push({ mime, name }); return { ok: true, mediaId: 'MEDIA_AUTO' }; };
      wa.sendMedia = async (to, cat, id, opts) => { calls.push({ to, cat, voice: opts.voice }); return { ok: true, waMessageId: 'wamid.AUTO_AUDIO' }; };
      fdb._tables.messages.push(voiceRow(7920, 'wamid.REFUSED1'));
      const before = fdb._tables.messages.length;
      await withAudioStubs({}, async () => {
        const summary = await ingestWebhook(refusedStatus('wamid.REFUSED1', 'Unsupported audio'), fdb);
        assert.strictEqual(summary.resent, 1);
        await ingestWebhook(refusedStatus('wamid.REFUSED1', 'Unsupported audio'), fdb);
        await Promise.all([
          ingestWebhook(refusedStatus('wamid.REFUSED1', 'Unsupported audio'), fdb),
          ingestWebhook(refusedStatus('wamid.REFUSED1', 'Unsupported audio'), fdb),
        ]);
      });
      assert.deepStrictEqual(calls, [{ mime: 'audio/mp4', name: 'voice-note.m4a' }, { to: '201000000011', cat: 'audio', voice: false }]);
      assert.strictEqual(fdb._tables.messages.length, before, 'no second bubble');
      const row = fdb._tables.messages.find((m) => m.id === 7920);
      assert.strictEqual(row.status, 'sent');
      assert.strictEqual(row.wa_message_id, 'wamid.AUTO_AUDIO');
      assert.strictEqual(row.error, null);
      assert.strictEqual(row.media_meta.sent_as_audio, true);
      assert.strictEqual(row.media_meta.voice, null);
      assert.strictEqual(row.media_meta.first_error, 'Media upload error (131053): Unsupported audio');
      assert.ok(row.media_meta.auto_resend);
      assert.strictEqual(row.media_path, '201000000011/out/k7920.ogg.m4a');
      await ingestWebhook(statusUpdate('wamid.AUTO_AUDIO', 'delivered'), fdb);
      assert.strictEqual(row.status, 'delivered');
    });

    await test('two deliveries of the refusal at the same instant still send one audio file', async () => {
      let sends = 0;
      let release;
      const gate = new Promise((r) => { release = r; });
      wa.uploadMedia = async () => { await gate; return { ok: true, mediaId: 'MEDIA_RACE' }; };
      wa.sendMedia = async () => { sends++; return { ok: true, waMessageId: 'wamid.RACE_AUDIO' }; };
      fdb._tables.messages.push(voiceRow(7921, 'wamid.REFUSED2'));
      await withAudioStubs({}, async () => {
        const both = Promise.all([
          ingestWebhook(refusedStatus('wamid.REFUSED2'), fdb),
          ingestWebhook(refusedStatus('wamid.REFUSED2'), fdb),
        ]);
        await new Promise((r) => setTimeout(r, 30));
        release();
        await both;
      });
      assert.strictEqual(sends, 1, `WhatsApp was called ${sends} times`);
      assert.strictEqual(fdb._tables.messages.find((m) => m.id === 7921).status, 'sent');
    });

    await test('when the audio file is refused too, the bubble fails with both reasons and no third send', async () => {
      let sends = 0;
      wa.uploadMedia = async () => ({ ok: true, mediaId: 'MEDIA_AGAIN' });
      wa.sendMedia = async () => { sends++; return { ok: true, waMessageId: 'wamid.AUDIO_REFUSED' }; };
      fdb._tables.messages.push(voiceRow(7922, 'wamid.REFUSED3'));
      await withAudioStubs({}, async () => {
        await ingestWebhook(refusedStatus('wamid.REFUSED3', 'Unsupported audio'), fdb);
        await ingestWebhook(refusedStatus('wamid.AUDIO_REFUSED', 'Still unsupported'), fdb);
        await ingestWebhook(refusedStatus('wamid.AUDIO_REFUSED', 'Still unsupported'), fdb);
      });
      assert.strictEqual(sends, 1);
      const row = fdb._tables.messages.find((m) => m.id === 7922);
      assert.strictEqual(row.status, 'failed');
      assert.strictEqual(row.error, 'Media upload error (131053): Still unsupported');
      assert.strictEqual(row.media_meta.first_error, 'Media upload error (131053): Unsupported audio');
    });

    await test('an automatic re-send that cannot go out leaves a failed bubble that Retry sends as audio', async () => {
      const calls = [];
      wa.uploadMedia = async () => ({ ok: false, error: 'WhatsApp is not answering' });
      wa.sendMedia = async (to, cat, id, opts) => { calls.push(opts.voice); return { ok: true, waMessageId: 'wamid.LATER_AUDIO' }; };
      fdb._tables.messages.push(voiceRow(7923, 'wamid.REFUSED4'));
      await withAudioStubs({}, async () => {
        await ingestWebhook(refusedStatus('wamid.REFUSED4'), fdb);
        const row = fdb._tables.messages.find((m) => m.id === 7923);
        assert.strictEqual(row.status, 'failed');
        assert.strictEqual(row.error, 'Media upload error (131053). Sent again as an audio file, which failed too: WhatsApp is not answering');
        assert.strictEqual(row.media_meta.voice, true);
        await ingestWebhook(refusedStatus('wamid.REFUSED4'), fdb);
        assert.strictEqual(calls.length, 0, 'the webhook does not try twice');
        wa.uploadMedia = async () => ({ ok: true, mediaId: 'MEDIA_LATER' });
        assert.strictEqual((await authed('POST', '/api/retry/7923')).status, 200);
        assert.deepStrictEqual(calls, [false]);
        assert.strictEqual(row.media_meta.sent_as_audio, true);
      });
    });

    await test('only a refused voice note is sent again: not a photo, not a voice note that failed another way', async () => {
      let sends = 0;
      wa.uploadMedia = async () => ({ ok: true, mediaId: 'X' });
      wa.sendMedia = async () => { sends++; return { ok: true, waMessageId: 'wamid.NOPE' }; };
      fdb._tables.messages.push(
        { ...voiceRow(7924, 'wamid.PHOTO_REFUSED'), type: 'image', body: '📷 Image', media_meta: { mime_type: 'image/jpeg' } },
        voiceRow(7925, 'wamid.VOICE_LATE'),
        voiceRow(7926, 'wamid.VOICE_READ', { status: 'read' }),
      );
      await withAudioStubs({ toM4a: async () => { throw new Error('should not transcode'); } }, async () => {
        await ingestWebhook(refusedStatus('wamid.PHOTO_REFUSED'), fdb);
        await ingestWebhook(statusUpdate('wamid.VOICE_LATE', 'failed'), fdb);
        await ingestWebhook(refusedStatus('wamid.VOICE_READ'), fdb);
      });
      assert.strictEqual(sends, 0);
      assert.strictEqual(fdb._tables.messages.find((m) => m.id === 7924).status, 'failed');
      assert.strictEqual(fdb._tables.messages.find((m) => m.id === 7925).error, 'Re-engagement message (131047)');
      assert.strictEqual(fdb._tables.messages.find((m) => m.id === 7926).status, 'read');
    });

    await test('an OGG upload is named with its codec, as Meta asks', async () => {
      assert.strictEqual(wa.uploadType('audio/ogg'), 'audio/ogg; codecs=opus');
      assert.strictEqual(wa.uploadType('Audio/OGG'), 'audio/ogg; codecs=opus');
      assert.strictEqual(wa.uploadType('audio/ogg; codecs=opus'), 'audio/ogg; codecs=opus');
      assert.strictEqual(wa.uploadType('audio/mp4'), 'audio/mp4');
      assert.strictEqual(wa.uploadType('image/jpeg'), 'image/jpeg');
      assert.strictEqual(wa.uploadType(''), 'application/octet-stream');
    });

    await test('a voice note that failed for any other reason is retried as a voice note', async () => {
      const calls = [];
      wa.uploadMedia = async (buf, mime) => { calls.push(mime); return { ok: true, mediaId: 'MEDIA_V' }; };
      wa.sendMedia = async (to, cat, id, opts) => { calls.push(opts.voice); return { ok: true, waMessageId: 'wamid.VOICE2' }; };
      fdb._tables.messages.push({
        id: 7914, wa_id: '201000000011', direction: 'out', type: 'audio', body: '🎤 Voice message', status: 'failed',
        error: 'Network error reaching WhatsApp: timeout', media_path: 'x/out/k7914.ogg', media_status: 'stored',
        media_meta: { voice: true, mime_type: 'audio/ogg', filename: 'voice-note.ogg' },
      });
      assert.strictEqual((await authed('POST', '/api/retry/7914')).status, 200);
      assert.deepStrictEqual(calls, ['audio/ogg', true]);
      assert.strictEqual(fdb._tables.messages.find((m) => m.id === 7914).media_meta.voice, true);
    });

    await test('a photo sent from the inbox is stored with its pixel size', async () => {
      wa.uploadMedia = async () => ({ ok: true, mediaId: 'MEDIA_PX' });
      wa.sendMedia = async () => ({ ok: true, waMessageId: 'wamid.PX' });
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 3, 0x20, 0, 0, 2, 0x58, 8, 6, 0, 0, 0])]);
      const r = await sendMedia({ client_key: 'px-1', file_base64: png.toString('base64') });
      assert.strictEqual(r.status, 200);
      const meta = rowsForKey('px-1')[0].media_meta;
      assert.strictEqual(meta.w, 800);
      assert.strictEqual(meta.h, 600);
    });

    await test('a forwarded button tap goes out as its text', async () => {
      let sentText;
      wa.sendText = async (to, text) => { sentText = text; return { ok: true, waMessageId: 'wamid.FWDTAP' }; };
      fdb._tables.messages.push({ id: 7915, wa_id: '201000000011', direction: 'in', type: 'button', body: 'Yes, I will come', status: 'received', media_meta: { tapped: true } });
      const r = await authed('POST', '/api/forward', { message_id: 7915, wa_ids: ['201000000012'] });
      assert.strictEqual(JSON.parse(r.text).sent, 1);
      assert.strictEqual(sentText, 'Yes, I will come');
    });

    await test('voice notes go out with voice:true, uploaded OGG files as AAC', async () => {
      const calls = [];
      const uploads = [];
      wa.uploadMedia = async (buf, mime, name) => { uploads.push({ mime, name }); return { ok: true, mediaId: 'MEDIA_V' }; };
      wa.sendMedia = async (to, cat, id, opts) => { calls.push(opts); return { ok: true, waMessageId: `wamid.V${calls.length}` }; };
      const transcode = require('../lib/transcode');
      const real = { ogg: transcode.toOggOpus, m4a: transcode.toM4a };
      transcode.toOggOpus = async () => ({ ok: true, buffer: Buffer.from('ogg'), mime: 'audio/ogg', ext: 'ogg' });
      transcode.toM4a = async () => ({ ok: true, buffer: Buffer.from('aac'), mime: 'audio/mp4', ext: 'm4a' });
      try {
        const audio = { file_base64: Buffer.from('x').toString('base64') };
        assert.strictEqual((await sendMedia({ ...audio, mime: 'audio/webm', filename: 'voice-note.webm', voice: true, client_key: 'voice-1' })).status, 200);
        assert.strictEqual((await sendMedia({ ...audio, mime: 'audio/ogg', filename: 'song.ogg', client_key: 'voice-2' })).status, 200);
        assert.strictEqual((await sendMedia({ ...audio, mime: 'audio/mpeg', filename: 'song.mp3', client_key: 'voice-3' })).status, 200);
      } finally {
        transcode.toOggOpus = real.ogg;
        transcode.toM4a = real.m4a;
      }
      assert.deepStrictEqual(calls.map((c) => c.voice), [true, false, false]);
      assert.deepStrictEqual(uploads.map((u) => u.mime), ['audio/ogg', 'audio/mp4', 'audio/mpeg']);
      assert.strictEqual(uploads[1].name, 'song.m4a');
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
        await freshWa.sendMedia('201', 'audio', 'M2', { voice: true });
        await freshWa.sendMedia('201', 'image', 'M3', { voice: true });
      } finally {
        global.fetch = realFetch;
        process.env.WHATSAPP_TOKEN = env.t || '';
        process.env.PHONE_NUMBER_ID = env.p || '';
        delete require.cache[require.resolve('../lib/whatsapp')];
      }
      assert.deepStrictEqual(bodies[0].context, { message_id: 'wamid.Q' });
      assert.strictEqual(bodies[1].context, undefined);
      assert.deepStrictEqual(bodies[2].context, { message_id: 'wamid.Q2' });
      assert.strictEqual(bodies[2].audio.voice, undefined, 'plain audio marked as voice');
      assert.deepStrictEqual(bodies[3].audio, { id: 'M2', voice: true });
      assert.strictEqual(bodies[4].image.voice, undefined);
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
      process.env.MEDIA_RETENTION_DAYS = '90';
      const res = { status() { return this; }, json(b) { this.body = b; return this; } };
      try {
        await maintenance({ headers: { authorization: 'Bearer cron-test' }, query: {} }, res);
      } finally {
        fdb.storage.from = realFrom;
        if (env === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = env;
        delete process.env.MEDIA_RETENTION_DAYS;
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
      ${src.split('\n').find((l) => l.startsWith('const TICK_RANK ='))}
      ${src.split('\n').find((l) => l.startsWith('const REFUSED_VOICE ='))}
      ${lift('resendingVoice')}
      ${lift('shownStatus')}
      ${lift('mergeMessages')}
      ${lift('takeOver')}
      ${lift('threadMessages')}
      ${lift('isAlbumWrapper')}
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

    await test('the saved row keeps the place, photo and newer tick of the bubble drawn before it', async () => {
      ui.state.threads = {};
      const opt = ui.addOptimistic(WA, { type: 'image', body: '📷 Image', _localUrl: 'data:image/png;base64,AA' });
      opt.client_key = 'key-1';
      const t = ui.thread(WA);
      ui.mergeMessages(t, [{ ...srvRow(700, 'a different label'), type: 'image', client_key: 'key-1', status: 'delivered' }]);
      assert.strictEqual(ui.threadMessages(t).length, 1, 'matched by its key even when the label differs');
      ui.settleOptimistic(WA, opt, null, { ...srvRow(700, 'a different label'), type: 'image', client_key: 'key-1', status: 'sent' });
      const row = t.byId.get(700);
      assert.strictEqual(row._key, opt._key, 'same bubble on screen');
      assert.strictEqual(row._localUrl, 'data:image/png;base64,AA', 'the photo is not loaded again');
      assert.strictEqual(row.status, 'delivered', 'the send answer does not take a tick back');
      assert.strictEqual(ui.threadMessages(t).length, 1);
    });

    await test('send: POST resolves before the poll -> ONE bubble', async () => {
      ui.state.threads = {};
      const opt = ui.addOptimistic(WA, { type: 'text', body: 'yo' });
      const t = ui.thread(WA);
      ui.settleOptimistic(WA, opt, null, srvRow(587, 'yo'));
      ui.mergeMessages(t, [srvRow(587, 'yo')]);
      assert.strictEqual(ui.threadMessages(t).length, 1);
    });

    await test('ticks only move forward on screen, and played shows as read', async () => {
      ui.state.threads = {};
      const t = ui.thread(WA);
      ui.mergeMessages(t, [{ ...srvRow(601, 'a'), status: 'delivered' }]);
      ui.mergeMessages(t, [{ ...srvRow(601, 'a'), status: 'sent' }]);
      assert.strictEqual(t.byId.get(601).status, 'delivered', 'an older answer arriving late does not take a tick back');
      ui.mergeMessages(t, [{ ...srvRow(601, 'a'), status: 'read' }]);
      assert.strictEqual(t.byId.get(601).status, 'read');
      ui.mergeMessages(t, [{ ...srvRow(601, 'a'), status: 'failed', error: 'Message undeliverable (131026)' }]);
      assert.strictEqual(t.byId.get(601).status, 'failed', 'a real failure still shows');
      const glyph = new Function(`${lift('tickGlyph')}; return tickGlyph;`)();
      assert.strictEqual(glyph('played'), glyph('read'), 'a played voice note shows blue ticks, not a clock');
    });

    await test('a voice note re-sending itself keeps its ticks until it settles', async () => {
      ui.state.threads = {};
      const t = ui.thread(WA);
      const now = new Date().toISOString();
      const voice = { ...srvRow(602, '🎤 Voice message'), type: 'audio', created_at: now, wa_timestamp: now, media_meta: { voice: true } };
      ui.mergeMessages(t, [{ ...voice, status: 'delivered' }]);
      ui.mergeMessages(t, [{ ...voice, status: 'failed', error: 'Media upload error (131053): scrutiny' }]);
      assert.strictEqual(t.byId.get(602).status, 'delivered', 'no red flash');
      ui.mergeMessages(t, [{ ...voice, status: 'pending', media_meta: { voice: true, auto_resend: now } }]);
      assert.strictEqual(t.byId.get(602).status, 'delivered', 'no clock after ticks');
      ui.mergeMessages(t, [{ ...voice, status: 'sent', body: '🎵 Audio', media_meta: { voice: null, auto_resend: now, sent_as_audio: true } }]);
      assert.strictEqual(t.byId.get(602).body, '🎵 Audio');
      ui.mergeMessages(t, [{ ...voice, status: 'read', body: '🎵 Audio', media_meta: { voice: null, auto_resend: now, sent_as_audio: true } }]);
      assert.strictEqual(t.byId.get(602).status, 'read');
      ui.mergeMessages(t, [{ ...srvRow(603, 'x'), type: 'audio', created_at: now, status: 'sent', media_meta: { voice: true } }]);
      ui.mergeMessages(t, [{ ...srvRow(603, 'x'), type: 'audio', created_at: now, status: 'failed', error: 'Media upload error (131053)', media_meta: { voice: true, auto_resend: now } }]);
      assert.strictEqual(t.byId.get(603).status, 'failed', 'when the re-send fails too, it shows');
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

    await test('album: the extra "unsupported" message WhatsApp sends with several photos is left out', async () => {
      ui.state.threads = {};
      const t = ui.thread(WA);
      const inRow = (id, type, at) => ({ id, wa_id: WA, direction: 'in', type, body: 'x', wa_timestamp: at });
      const rows = [
        inRow(4175, 'unsupported', '2026-11-22T11:28:53.000000Z'),
        inRow(4176, 'image', '2026-11-22T11:28:53.000000Z'),
        inRow(4177, 'image', '2026-11-22T11:28:53.000000Z'),
        inRow(4179, 'unsupported', '2026-11-22T13:52:10.000000Z'),
        inRow(4180, 'text', '2026-11-22T13:52:11.000000Z'),
      ];
      for (const r of rows) { t.byId.set(r.id, r); t.order.push(r.id); }
      assert.deepStrictEqual(ui.threadMessages(t).map((m) => m.id), [4176, 4177, 4179, 4180],
        'the one that came with the photos is gone; the one on its own stays, text beside it does not hide it');
    });

    await test('album: photos that take a minute to arrive still hide their marker, later or unrelated ones do not', async () => {
      const inRow = (id, type, at) => ({ id, wa_id: WA, direction: 'in', type, body: 'x', wa_timestamp: at });
      const shown = (rows) => {
        ui.state.threads = {};
        const t = ui.thread(WA);
        for (const r of rows) { t.byId.set(r.id, r); t.order.push(r.id); }
        return ui.threadMessages(t).map((m) => m.id);
      };
      // nine screenshots, the first 68 seconds after the marker (a real case)
      assert.deepStrictEqual(shown([
        inRow(1, 'text', '2026-11-22T11:02:19Z'),
        { id: 2, wa_id: WA, direction: 'out', type: 'text', body: 'can you take a screen shot', wa_timestamp: '2026-11-22T13:45:47Z' },
        inRow(3, 'unsupported', '2026-11-22T13:52:46Z'),
        inRow(4, 'image', '2026-11-22T13:53:54Z'),
        inRow(5, 'image', '2026-11-22T13:53:55Z'),
      ]), [1, 2, 4, 5]);
      // their next message is text: it was something else, keep the notice
      assert.deepStrictEqual(shown([
        inRow(3, 'unsupported', '2026-11-22T13:52:46Z'),
        inRow(4, 'text', '2026-11-22T13:53:00Z'),
        inRow(5, 'image', '2026-11-22T13:53:55Z'),
      ]), [3, 4, 5]);
      // a photo five minutes later is not that album
      assert.deepStrictEqual(shown([
        inRow(3, 'unsupported', '2026-11-22T13:52:46Z'),
        inRow(4, 'image', '2026-11-22T13:57:50Z'),
      ]), [3, 4]);
      // an agent's own photo in between does not count as the member's
      assert.deepStrictEqual(shown([
        inRow(3, 'unsupported', '2026-11-22T13:52:46Z'),
        { id: 4, wa_id: WA, direction: 'out', type: 'image', body: 'x', wa_timestamp: '2026-11-22T13:53:00Z' },
      ]), [3, 4]);
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
      assert.strictEqual(names.memberLabel(member), 'Nawy Degla', 'everyone is a member, so the word is not shown');
      assert.strictEqual(names.memberLabel({ ...member, active: false, company: 'Oasis' }), 'Former member · Oasis');
      assert.strictEqual(names.memberLabel({ ...member, kind: 'hr' }), 'HR · Nawy Degla');
      assert.strictEqual(names.memberLabel({ ...member, kind: 'coordinator' }), 'Coordinator · Nawy Degla');
      assert.strictEqual(names.memberLabel({ ...member, more: 1 }), 'Nawy Degla +1');
      assert.strictEqual(names.memberLabel({ ...member, company: null }), '');
      assert.strictEqual(names.memberTag(member), 'Nawy Degla');
      assert.strictEqual(names.memberTag(null), '');
    });

    const cut = (from, to) => {
      const a = src.indexOf(from);
      const b = src.indexOf(to, a);
      assert.ok(a > -1 && b > a, `web/app.js no longer has ${from}`);
      return src.slice(a, b);
    };

    await test('a photo keeps its own shape in the bubble, and its space is known before it loads', async () => {
      const { frameBox } = new Function(`${liftConst('MEDIA_MAX_W')}\n${liftConst('MEDIA_MAX_H')}\n${liftConst('STICKER_MAX')}\n${lift('frameBox')}\nreturn { frameBox };`)();
      const shape = (w, h, sticker) => { const b = frameBox(w, h, sticker); return b && { width: b.width, height: Math.round(b.width / b.ratio) }; };
      assert.deepStrictEqual(shape(1170, 2532), { width: 194, height: 420 }, 'a phone screenshot is shown whole');
      assert.deepStrictEqual(shape(1600, 900), { width: 340, height: 191 });
      assert.deepStrictEqual(shape(1080, 1080), { width: 340, height: 340 });
      assert.deepStrictEqual(shape(200, 120), { width: 200, height: 120 }, 'a small picture is not blown up');
      assert.deepStrictEqual(shape(512, 512, true), { width: 150, height: 150 }, 'a sticker stays small');
      assert.strictEqual(frameBox(600, 6000).ratio, 0.45, 'a very long screenshot is cropped, not shrunk to a sliver');
      assert.strictEqual(frameBox(6000, 600).ratio, 3);
      assert.strictEqual(frameBox(0, 0), null);
      assert.strictEqual(frameBox(undefined, 5), null);
    });

    await test('a refused message says why in plain words and keeps what WhatsApp said', async () => {
      const { failureWords } = new Function(`${cut('const REFUSED_MEDIA =', 'function actionButton(')}\nreturn { failureWords };`)();
      const voice = failureWords({ error: 'Media upload error (131053): Unsupported audio', media_meta: { voice: true } });
      assert.ok(/could not process this file/.test(voice.text) && /audio file/.test(voice.text), voice.text);
      assert.strictEqual(voice.said, 'Media upload error (131053): Unsupported audio');
      assert.ok(/could not process/.test(failureWords({ error: 'Media upload error', media_meta: { voice: true } }).text), 'rows stored before the code was kept');
      assert.ok(!/audio file instead/.test(failureWords({ error: 'Media upload error (131053)', media_meta: {} }).text), 'a photo is not offered as audio');
      assert.ok(/24 hours/.test(failureWords({ error: 'Re-engagement message' }).text));
      assert.ok(/24 hours/.test(failureWords({ error: 'Outside the 24-hour reply window — only approved templates can be sent now.' }).text));
      assert.ok(/blocked|not be on WhatsApp/.test(failureWords({ error: 'Message undeliverable (131026)' }).text));
      assert.deepStrictEqual(failureWords({ error: 'Something new from Meta' }), { text: 'Something new from Meta', said: '' });
      assert.deepStrictEqual(failureWords({}), { text: 'Failed to send.', said: '' });
    });

    await test('a web address in a message becomes a link, and nothing else does', async () => {
      const { linkify, escapeHtml } = new Function(`${lift('escapeHtml')}\n${lift('linkify')}\nreturn { linkify, escapeHtml };`)();
      const out = (text) => linkify(escapeHtml(text));
      assert.strictEqual(out('see https://bytepluslife.com/help.'),
        'see <a class="msg-link" href="https://bytepluslife.com/help" target="_blank" rel="noopener noreferrer">https://bytepluslife.com/help</a>.');
      assert.ok(out('a http://x.io/a?b=1&c=2 b').includes('href="http://x.io/a?b=1&amp;c=2"'), 'the & stays escaped inside the link');
      assert.strictEqual(out('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
      assert.strictEqual(out('javascript:alert(1) and ftp://x'), 'javascript:alert(1) and ftp://x');
      assert.ok(!out('"https://x.io/a" onmouseover="x').includes('onmouseover="'), 'a quote cannot break out of the link');
      assert.strictEqual((out('https://a.io and https://b.io').match(/<a /g) || []).length, 2);
    });

    await test('the 24-hour window is said in plain words before a send', async () => {
      const { windowWords } = new Function(`
        ${liftConst('WINDOW_SOON_MS')}
        function fmtTime() { return '14:35'; }
        ${lift('windowWords')}
        return { windowWords };`)();
      assert.strictEqual(windowWords(null), '');
      assert.ok(/not written to this number yet/.test(windowWords({ open: false, never: true })));
      assert.strictEqual(windowWords({ open: false, left: -5 }), 'The 24 hours are over. Only a template can be sent.');
      assert.strictEqual(windowWords({ open: true, left: 5 * 60 * 60 * 1000, until: 0 }), '', 'plenty of time: nothing to say');
      assert.ok(/until 14:35 \(1 h 20 min left\)/.test(windowWords({ open: true, left: 80 * 60 * 1000, until: 0 })), windowWords({ open: true, left: 80 * 60 * 1000, until: 0 }));
      assert.ok(/\(9 min left\)/.test(windowWords({ open: true, left: 9 * 60 * 1000, until: 0 })));
    });

    await test('a chat opened here but not answered is shown as waiting, not as new', async () => {
      const ui = new Function(`
        const state = { teamwork: true };
        const seenHere = { A: '2026-11-23T10:00:00Z' };
        ${src.split('\n').find((l) => l.startsWith('const waiting ='))}
        ${src.split('\n').find((l) => l.startsWith('const newHere ='))}
        return { state, waiting, newHere };`)();
      const opened = { wa_id: 'A', unread_count: 2, needs_reply: true, last_message_at: '2026-11-23T10:00:00Z' };
      assert.strictEqual(ui.waiting(opened), true);
      assert.strictEqual(ui.newHere(opened), false);
      assert.strictEqual(ui.newHere({ ...opened, last_message_at: '2026-11-23T10:05:00Z' }), true, 'they wrote again after it was seen here');
      assert.strictEqual(ui.newHere({ wa_id: 'B', unread_count: 1, last_message_at: 'x' }), true);
      assert.strictEqual(ui.waiting({ wa_id: 'C', unread_count: 0, needs_reply: false }), false);
      ui.state.teamwork = false;
      assert.strictEqual(ui.newHere(opened), true, 'before migration 011 unread means unread');
      assert.strictEqual(ui.waiting({ wa_id: 'D', unread_count: 3 }), true, 'an older server sends no needs_reply');
    });

    await test('a request that never reaches the server answers as a failure instead of throwing', async () => {
      const make = (fetchImpl) => new Function('fetch', `let endedNote = '';\n${cut('async function api(', '// Who is signed in on this device')}\nreturn Object.assign(api, { note: () => endedNote });`)(fetchImpl);
      const down = await make(async () => { throw new TypeError('Failed to fetch'); })('/api/send', { method: 'POST' });
      assert.strictEqual(down.ok, false);
      assert.strictEqual(down.status, 0);
      assert.ok(/No connection/.test(down.data.error));
      const up = await make(async () => ({ status: 200, ok: true, json: async () => ({ a: 1 }) }))('/api/x');
      assert.deepStrictEqual(up, { status: 200, ok: true, data: { a: 1 } });
      const ended = make(async () => ({ status: 401, ok: false, json: async () => ({ error: 'Your account no longer has access to the inbox.', ended: true }) }));
      await ended('/api/conversations');
      assert.strictEqual(ended.note(), 'Your account no longer has access to the inbox.', 'the reason must reach the login screen');
      const plain = make(async () => ({ status: 401, ok: false, json: async () => ({ error: 'Not authenticated.' }) }));
      await plain('/api/conversations');
      assert.strictEqual(plain.note(), '');
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
    const ui = new Function('WaTpl', `
      const toasts = [];
      const state = { threads: {}, conversations: [{ wa_id: 'W', profile_name: 'Sara' }], activeWaId: 'W', forward: null, templates: [] };
      const els = { forwardError: {}, forwardSearch: { focus() {} }, forwardModal: {} };
      function thread(waId) {
        if (!state.threads[waId]) state.threads[waId] = { byId: new Map(), order: [] };
        return state.threads[waId];
      }
      function toast(msg) { toasts.push(msg); }
      function renderForwardList() {}
      function loadForwardRows() {}
      function updateForwardSubmit() {}
      function setTimeout() {}
      function displayName(c) { return c.profile_name; }
      function formatPhone(w) { return '+' + w; }
      function escapeHtml(s) { return String(s); }
      ${lift('stripCaption')}
      ${src.split('\n').find((l) => l.startsWith('const TEXT_TYPES ='))}
      ${src.split('\n').find((l) => l.startsWith('const isTextLike ='))}
      const UNSUPPORTED_LABEL = "can't be shown";
      ${lift('labelForType')}
      ${lift('replyToOf')}
      ${lift('quotedMessage')}
      ${lift('convOf')}
      ${lift('senderName')}
      ${lift('snippetOf')}
      ${constBlock('NOT_FORWARDABLE')}
      ${lift('openForwardModal')}
      return { state, thread, toasts, quotedMessage, senderName, snippetOf, openForwardModal };
    `)(require('../web/tpl'));

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

  console.log('\n\x1b[1mTEMPLATE COPY\x1b[0m');
  {
    const WaTpl = require('../web/tpl');
    const templates = require('../lib/templates');
    const list = [
      { name: 'ops_station_call', language: 'en', header: '', body: "Hi {{1}}, you're up. Please go to {{2}} ({{3}}). {{4}} is expecting you now.", footer: '', buttons: [] },
      { name: 'ops_station_call', language: 'ar', header: '', body: 'أهلاً {{1}}، دورك. روح {{2}} ({{3}}). {{4}} مستنيك.', footer: '', buttons: [] },
      { name: 'ops_app_open', language: 'en', header: '', body: 'Hi {{1}}, open the app for {{2}}.', footer: '', buttons: ['Open app'] },
    ];
    const comps = (...p) => [{ type: 'body', parameters: p.map((text) => ({ type: 'text', text })) }];

    await test('a stored template renders the approved copy in its language', async () => {
      const m = { type: 'text', body: 'x', media_meta: { template: { name: 'ops_station_call', language: 'ar', components: comps('سارة', 'InBody', 'الدور 2', 'ندى') } } };
      assert.strictEqual(WaTpl.render(WaTpl.sentTemplate(m), list).body, 'أهلاً سارة، دورك. روح InBody (الدور 2). ندى مستنيك.');
    });

    await test('legacy "📋 [name] a · b" rows render, language guessed from the text', async () => {
      const en = WaTpl.render(WaTpl.sentTemplate({ body: '📋 [ops_station_call] Yassin · Blood test · Quantum · Nada' }), list);
      assert.strictEqual(en.body, "Hi Yassin, you're up. Please go to Blood test (Quantum). Nada is expecting you now.");
      const ar = WaTpl.render(WaTpl.sentTemplate({ body: '📋 [ops_station_call] Mohamed · تحليل الدم · الاستقبال · ندى' }), list);
      assert.strictEqual(ar.language, 'ar');
      assert.strictEqual(WaTpl.previewText('📋 [ops_app_open] Ali · Nawy · extra', list), '📋 Hi Ali, open the app for Nawy · extra.');
    });

    await test('unknown templates and plain text fall back to the stored body', async () => {
      assert.strictEqual(WaTpl.messageText({ body: '📋 [gone_template] a · b' }, list), '📋 [gone_template] a · b');
      assert.strictEqual(WaTpl.messageText({ body: 'hello' }, list), 'hello');
      assert.strictEqual(WaTpl.render(WaTpl.sentTemplate({ body: 'hello' }), list), null);
    });

    await test('buttons come through, and the send preview uses the cached copy', async () => {
      const r = WaTpl.render(WaTpl.sentTemplate({ media_meta: { template: { name: 'ops_app_open', language: 'en', components: comps('Ali', 'Nawy') } } }), list);
      assert.deepStrictEqual(r.buttons, ['Open app']);
      templates.__setCacheForTesting(list);
      assert.strictEqual(templates.renderCached('ops_app_open', 'en', comps('Ali', 'Nawy')), 'Hi Ali, open the app for Nawy.');
      templates.__setCacheForTesting(null);
    });
  }

  // ---- voice note file ----
  {
    const transcode = require('../lib/transcode');
    if (transcode.isAvailable()) {
      await test('a voice note made from an Opus recording has an exact first page count', async () => {
        const { execFileSync } = require('child_process');
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const src = path.join(os.tmpdir(), `wa-test-rec-${process.pid}.webm`);
        execFileSync(transcode.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'libopus', src]);
        const recording = fs.readFileSync(src);
        fs.unlinkSync(src);
        const out = await transcode.toOggOpus(recording, 'webm');
        assert.strictEqual(out.ok, true);
        const pages = [];
        for (let i = out.buffer.indexOf('OggS'); i >= 0; i = out.buffer.indexOf('OggS', i + 4)) pages.push(out.buffer.readBigInt64LE(i + 6));
        assert.ok(pages.length >= 4, 'header, tags and audio pages');
        assert.strictEqual(pages[2], 48000n, 'the first second counts 48000 samples');
        assert.strictEqual(out.buffer.indexOf('OpusHead') > 0, true);
      });
    } else {
      console.log('  (voice note file test skipped: no ffmpeg here)');
    }
  }

  // ---- summary ----
  console.log(`\n\x1b[1mRESULT:\x1b[0m ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
