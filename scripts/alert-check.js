// Drives the inbox in headless Chromium (in-memory DB) and checks the tab
// alerts: unread count in the title, favicon dot, chime, desktop notification,
// auto-read of the open chat, live push over /api/events, and the polling
// fallback when that stream is unavailable. npm run alert-check
const http = require('http');

Object.assign(process.env, {
  WHATSAPP_TOKEN: '', PHONE_NUMBER_ID: '', APP_SECRET: '', DATABASE_URL: '',
  VERIFY_TOKEN: 'x', SESSION_SECRET: 'demo_session_secret_0123456789',
  DASHBOARD_PASSCODE: 'demo', NODE_ENV: 'test',
});

const { chromium } = require('playwright');
const { makeFakeDb } = require('./fake-db');
const db = require('../lib/db');
const live = require('../lib/live');
const fake = makeFakeDb();
db.__setDbForTesting(fake);

const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
const A = '201001234567';
const B = '447700900123';
fake._tables.conversations.push(
  { wa_id: A, profile_name: 'Ada Lovelace', last_message_text: 'hi', last_message_at: iso(2), last_message_direction: 'in', unread_count: 0, created_at: iso(999) },
  { wa_id: B, profile_name: 'Marcus Chen', last_message_text: 'yo', last_message_at: iso(18), last_message_direction: 'in', unread_count: 0, created_at: iso(999) },
);
fake._tables.messages.push(
  { id: 1, wa_message_id: 'm1', wa_id: A, direction: 'in', type: 'text', body: 'hi', status: 'received', wa_timestamp: iso(2), created_at: iso(2), media_meta: null, error: null, forwarded: false },
);

function inbound(waId, text) {
  const c = fake._tables.conversations.find((r) => r.wa_id === waId);
  Object.assign(c, { last_message_text: text, last_message_at: new Date().toISOString(), last_message_direction: 'in', unread_count: (c.unread_count || 0) + 1 });
  live.publish('messages');
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

(async () => {
  const app = require('../api/index');
  const srv = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.addInitScript(() => {
    window.__front = true;
    window.__notes = [];
    window.__tones = 0;
    Object.defineProperty(Document.prototype, 'hidden', { get: () => !window.__front });
    Document.prototype.hasFocus = () => window.__front;
    window.Notification = class {
      constructor(title, opts) { window.__notes.push({ title, ...opts }); }
      close() {}
      static requestPermission() { return Promise.resolve('granted'); }
    };
    window.Notification.permission = 'granted';
    const Real = window.AudioContext;
    window.AudioContext = class extends Real {
      createOscillator() { window.__tones++; return super.createOscillator(); }
    };
  });

  const listCalls = [];
  page.on('request', (r) => { if (r.url().endsWith('/api/conversations')) listCalls.push(Date.now()); });

  const marked = [];
  await page.route('**/api/mark-read', (route) => {
    const waId = JSON.parse(route.request().postData()).wa_id;
    marked.push(waId);
    fake._tables.conversations.find((r) => r.wa_id === waId).unread_count = 0;
    route.fulfill({ json: { ok: true } });
  });

  await page.goto(base + '/app');
  await page.fill('#passcode', 'demo');
  await page.click('#login-btn');
  await page.waitForSelector('.conv-row');
  await page.click('.conv-row >> text=Ada Lovelace');
  await page.waitForSelector('.bubble');
  const icon = () => page.$eval('link[rel="icon"]', (l) => l.getAttribute('href'));
  const plainIcon = await icon();

  await page.waitForFunction(() => true);
  check('stream connected', live._clients.size === 1, `clients=${live._clients.size}`);
  const quietFrom = Date.now();
  await page.waitForTimeout(9000);
  const quietCalls = listCalls.filter((t) => t > quietFrom).length;
  check('no list polling while live', quietCalls === 0, `calls in 9s=${quietCalls}`);

  check('title plain with nothing unread', (await page.title()) === 'Inbox · WhatsApp Agent', await page.title());

  const pushedAt = Date.now();
  inbound(B, 'are you there?');
  await page.waitForFunction(() => document.title.startsWith('(1)'), null, { timeout: 8000 }).catch(() => {});
  const lag = Date.now() - pushedAt;
  check('pushed to the tab in under a second', lag < 1000, `${lag}ms`);
  check('title counts unread from another chat', (await page.title()) === '(1) Inbox · WhatsApp Agent', await page.title());
  check('favicon gets a dot', (await icon()) !== plainIcon && (await icon()).includes('circle'));
  check('chime played', (await page.evaluate(() => window.__tones)) === 2);
  check('no desktop notification while in front', (await page.evaluate(() => window.__notes.length)) === 0);

  marked.length = 0;
  inbound(A, 'open chat message');
  await page.waitForFunction(() => window.__tones > 2, null, { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(500);
  check('open chat in front: no chime', (await page.evaluate(() => window.__tones)) === 2);
  check('open chat in front: marked read', marked.includes(A));
  check('title unchanged', (await page.title()) === '(1) Inbox · WhatsApp Agent', await page.title());

  marked.length = 0;
  await page.evaluate(() => { window.__front = false; document.dispatchEvent(new Event('visibilitychange')); });
  inbound(A, 'while you were away');
  await page.waitForFunction(() => window.__notes.length > 0, null, { timeout: 15000 }).catch(() => {});
  const notes = await page.evaluate(() => window.__notes);
  check('background tab gets the push and notifies', notes.length === 1 && notes[0].title === 'Ada Lovelace' && notes[0].body === 'while you were away', JSON.stringify(notes));
  check('background chime', (await page.evaluate(() => window.__tones)) === 4);
  check('open chat not read while away', !marked.includes(A));
  check('title counts the open chat while away', (await page.title()) === '(2) Inbox · WhatsApp Agent', await page.title());

  await page.evaluate(() => { window.__front = true; window.dispatchEvent(new Event('focus')); });
  await page.waitForTimeout(300);
  check('coming back reads the open chat', marked.includes(A));
  check('title drops back', (await page.title()) === '(1) Inbox · WhatsApp Agent', await page.title());

  await page.click('.conv-row >> text=Marcus Chen');
  await page.waitForFunction(() => !document.title.startsWith('('), null, { timeout: 3000 }).catch(() => {});
  check('opening the last unread chat clears title', (await page.title()) === 'Inbox · WhatsApp Agent', await page.title());
  check('favicon back to plain', (await icon()) === plainIcon);

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

  // Fallback: the stream is refused, so the tab must poll as before.
  const page2 = await browser.newPage();
  await page2.route('**/api/events', (route) => route.fulfill({ status: 503, body: '' }));
  await page2.goto(base + '/app');
  await page2.fill('#passcode', 'demo');
  await page2.click('#login-btn');
  await page2.waitForSelector('.conv-row');
  inbound(B, 'fallback works');
  await page2.waitForFunction(() => document.body.innerText.includes('fallback works'), null, { timeout: 9000 }).catch(() => {});
  check('falls back to polling without the stream', (await page2.content()).includes('fallback works'));

  await browser.close();
  srv.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
