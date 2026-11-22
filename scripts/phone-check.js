// Drives the inbox in headless Chromium at phone size (in-memory DB) and checks
// what a phone needs: the Home Screen app files, no zoom on the fields, the
// back gesture, the layout following the keyboard, the bell and the worker
// that shows a notification. Desktop is checked for staying as it was.
// npm run phone-check
const http = require('http');

Object.assign(process.env, {
  WHATSAPP_TOKEN: '', PHONE_NUMBER_ID: '', APP_SECRET: '', DATABASE_URL: '',
  VERIFY_TOKEN: 'x', SESSION_SECRET: 'demo_session_secret_0123456789',
  DASHBOARD_PASSCODE: 'demo', NODE_ENV: 'test',
});

const { chromium } = require('playwright');
const { makeFakeDb } = require('./fake-db');
const db = require('../lib/db');
const fake = makeFakeDb();
db.__setDbForTesting(fake);

const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
const A = '201001234567';
const B = '447700900123';
fake._tables.conversations.push(
  { wa_id: A, profile_name: 'Ada Lovelace', last_message_text: 'hi', last_message_at: iso(2), last_message_direction: 'in', unread_count: 0, created_at: iso(999) },
  { wa_id: B, profile_name: 'Marcus Chen', last_message_text: 'yo', last_message_at: iso(18), last_message_direction: 'in', unread_count: 0, created_at: iso(999) },
);
for (let i = 1; i <= 30; i++) {
  const photo = i % 4 === 0;
  fake._tables.messages.push({ id: i, wa_message_id: `m${i}`, wa_id: A, direction: i % 2 ? 'in' : 'out', type: photo ? 'image' : 'text', body: photo ? '📷 Image' : `message ${i}`, status: 'received', wa_timestamp: iso(60 - i), created_at: iso(60 - i), media_meta: photo ? { id: `p${i}`, mime_type: 'image/png' } : null, media_status: photo ? 'stored' : null, media_path: photo ? `x/image/p${i}.png` : null, error: null, forwarded: false });
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

async function login(page, url) {
  await page.goto(url, { waitUntil: 'networkidle' });
  if (await page.isVisible('#passcode')) {
    await page.fill('#passcode', 'demo');
    await page.click('#login-btn');
  }
  await page.waitForSelector('.conv-row', { state: 'visible', timeout: 5000 });
}

(async () => {
  const app = require('../api/index');
  // The media route redirects here. Each photo takes a moment and is tall, as
  // real ones are, so the chat grows after it first opens.
  app.get('/_sample.svg', (_req, res) => setTimeout(() => {
    res.set('Content-Type', 'image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="300"><rect width="360" height="300" fill="#8fd0ba"/></svg>');
  }, 350));
  const srv = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch();
  const pageErrors = [];

  // ------------------------------------------------------------- phone
  const phone = await browser.newContext({
    viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true,
    permissions: ['notifications'],
  });
  await phone.addInitScript(() => {
    // Headless Chromium has no push service, so the subscription is faked.
    // and it reports notifications as not yet asked whatever the context grants
    try { Object.defineProperty(Notification, 'permission', { get: () => 'granted' }); } catch (_) {}
    if (!('PushManager' in window)) return;
    let sub = null;
    const make = () => ({
      endpoint: 'https://fcm.googleapis.com/fcm/send/phone-check',
      options: {},
      toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } }; },
      unsubscribe: async () => { sub = null; return true; },
    });
    PushManager.prototype.subscribe = async () => { sub = make(); return sub; };
    PushManager.prototype.getSubscription = async () => sub;
  });
  const page = await phone.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await login(page, `${base}/app`);

  const head = await page.evaluate(() => ({
    manifest: document.querySelector('link[rel="manifest"]').getAttribute('href'),
    touchIcon: document.querySelector('link[rel="apple-touch-icon"]').getAttribute('href'),
    capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]').content,
  }));
  const manifestRes = await fetch(base + head.manifest);
  const manifest = await manifestRes.json();
  check('the Home Screen app file is served and opens the inbox full screen',
    manifestRes.status === 200 && manifest.display === 'standalone' && manifest.start_url === '/app' && head.capable === 'yes');
  const icons = await Promise.all([head.touchIcon, ...manifest.icons.map((i) => i.src)].map((src) => fetch(base + src)));
  check('every icon it names is a PNG that loads', icons.every((r) => r.status === 200 && r.headers.get('content-type') === 'image/png'));
  const sw = await fetch(`${base}/static/sw.js`);
  check('the worker is served fresh and may cover /app',
    sw.status === 200 && sw.headers.get('service-worker-allowed') === '/' && sw.headers.get('cache-control') === 'no-cache');

  const sizes = await page.evaluate(() => ['#search', '#composer-input', '#new-chat-number', '#rename-input', '#forward-search']
    .map((s) => parseFloat(getComputedStyle(document.querySelector(s)).fontSize)));
  check('no field is under 16px, so an iPhone does not zoom in on focus', sizes.every((n) => n >= 16), sizes.join(','));

  await page.waitForFunction(() => !document.querySelector('#notify-btn').hidden, null, { timeout: 5000 }).catch(() => {});
  check('the bell shows once the server says notifications are available', await page.isVisible('#notify-btn'));
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  check('the worker registers for the whole inbox', scope === `${base}/`, scope);

  await page.waitForFunction(() => document.querySelector('#notify-btn').classList.contains('is-on'), null, { timeout: 5000 }).catch(() => {});
  check('notifications already allowed: the device is signed up without a tap on the bell',
    fake._tables.push_subscriptions.length === 1 && await page.evaluate(() => document.querySelector('#notify-btn').getAttribute('aria-pressed') === 'true'));
  // chat as its own screen + back gesture
  await page.click('.conv-row');
  await page.waitForSelector('.bubble');
  await page.waitForTimeout(2500); // let every photo arrive
  const land = await page.evaluate(() => {
    const m = document.querySelector('#messages');
    const last = [...m.querySelectorAll('.bubble')].pop().getBoundingClientRect();
    const box = m.getBoundingClientRect();
    return { gap: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight), lastVisible: last.bottom <= box.bottom + 1 && last.top >= box.top, photos: m.querySelectorAll('img').length };
  });
  check('a chat with photos opens at its newest message and stays there as they load',
    land.gap <= 2 && land.lastVisible && land.photos > 0, JSON.stringify(land));
  await page.evaluate(() => { const m = document.querySelector('#messages'); m.style.scrollBehavior = 'auto'; m.scrollTop = 0; m.style.scrollBehavior = ''; });
  await page.waitForTimeout(1200);
  check('scrolling up to read is not pulled back down',
    await page.evaluate(() => document.querySelector('#messages').scrollTop < 200));
  await page.evaluate(() => { const m = document.querySelector('#messages'); m.scrollTop = m.scrollHeight; });
  const opened = await page.evaluate(() => ({ view: document.querySelector('#app').dataset.view, chat: Boolean(history.state && history.state.chat) }));
  check('opening a chat on a phone adds a step the back gesture can undo', opened.view === 'thread' && opened.chat);
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('#app').dataset.view === 'list');
  check('the back gesture returns to the list and stays in the inbox',
    await page.evaluate(() => document.querySelector('#thread').hidden && location.pathname === '/app'));
  await page.click('.conv-row');
  await page.waitForSelector('.bubble');
  await page.click('#back-btn');
  await page.waitForFunction(() => document.querySelector('#app').dataset.view === 'list');
  check('the back arrow does the same', await page.evaluate(() => document.querySelector('#thread').hidden));

  // keyboard: the visible area shrinks, the chat must follow it
  await page.click('.conv-row');
  await page.waitForSelector('.bubble');
  await page.waitForTimeout(500);
  const before = await page.evaluate(() => {
    const m = document.querySelector('#messages');
    return { gap: m.scrollHeight - m.scrollTop - m.clientHeight };
  });
  await page.setViewportSize({ width: 390, height: 440 });
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--app-h').trim() === '440px', null, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(600);
  const kb = await page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const m = document.querySelector('#messages');
    return {
      appH: getComputedStyle(document.documentElement).getPropertyValue('--app-h').trim(),
      headerTop: r('.thread-header').top, composerBottom: r('.composer').bottom,
      gap: m.scrollHeight - m.scrollTop - m.clientHeight,
    };
  });
  check('with the keyboard up the header stays on screen and the composer sits above the keyboard',
    kb.appH === '440px' && kb.headerTop >= 0 && kb.composerBottom <= 440.5, JSON.stringify(kb));
  check('and the latest messages stay in view', kb.gap <= before.gap + 4, `gap ${before.gap} -> ${kb.gap}`);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.click('#back-btn');
  await page.waitForFunction(() => document.querySelector('#app').dataset.view === 'list');

  // a tapped notification opens its chat
  await page.evaluate((waId) => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'open-chat', wa_id: waId } })), B);
  await page.waitForFunction(() => document.querySelector('#thread-name').textContent.includes('Marcus'), null, { timeout: 3000 }).catch(() => {});
  check('a tapped notification opens that chat when the inbox is already open',
    (await page.textContent('#thread-name')).includes('Marcus'));
  const page2 = await phone.newPage();
  page2.on('pageerror', (e) => pageErrors.push(e.message));
  await page2.goto(`${base}/app#chat=${A}`, { waitUntil: 'load' });
  await page2.waitForFunction(() => document.querySelector('#thread-name').textContent.includes('Ada'), null, { timeout: 5000 }).catch(() => {});
  check('and when the inbox had to be opened for it',
    (await page2.textContent('#thread-name')).includes('Ada') && await page2.evaluate(() => location.hash === ''));
  await page2.close();

  // bell off + logout
  await page.click('#back-btn').catch(() => {});
  await page.evaluate(() => document.querySelector('#notify-btn').click());
  await page.waitForFunction(() => !document.querySelector('#notify-btn').classList.contains('is-on'), null, { timeout: 5000 }).catch(() => {});
  check('tapping the bell removes this device', fake._tables.push_subscriptions.length === 0);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.conv-row');
  await page.waitForTimeout(1500);
  check('and it stays off after a reload, because the agent chose off',
    fake._tables.push_subscriptions.length === 0 && await page.evaluate(() => !document.querySelector('#notify-btn').classList.contains('is-on')));
  await page.evaluate(() => document.querySelector('#notify-btn').click());
  await page.waitForFunction(() => document.querySelector('#notify-btn').classList.contains('is-on'), null, { timeout: 5000 }).catch(() => {});
  check('tapping it again signs the device up', fake._tables.push_subscriptions.length === 1);
  await phone.close();

  // ----------------------------------------------------------- desktop
  const desk = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const d = await desk.newPage();
  d.on('pageerror', (e) => pageErrors.push(e.message));
  await login(d, `${base}/app`);
  await d.click('.conv-row');
  await d.waitForSelector('.bubble');
  await d.waitForTimeout(2500);
  const dland = await d.evaluate(() => { const m = document.querySelector('#messages'); return Math.round(m.scrollHeight - m.scrollTop - m.clientHeight); });
  check('on desktop too the chat opens at its newest message', dland <= 2, `gap ${dland}`);
  const dk = await d.evaluate(() => ({
    appH: document.documentElement.style.getPropertyValue('--app-h'),
    chat: Boolean(history.state && history.state.chat),
    search: parseFloat(getComputedStyle(document.querySelector('#search')).fontSize),
    panes: [...document.querySelectorAll('.pane')].map((p) => Math.round(p.getBoundingClientRect().width)),
    height: Math.round(document.querySelector('#app').getBoundingClientRect().height),
  }));
  check('desktop is as it was: two panes, full height, same text size, no extra back step',
    dk.appH === '' && !dk.chat && dk.search === 14 && dk.panes[0] === 372 && dk.panes[1] === 908 && dk.height === 832, JSON.stringify(dk));
  await desk.close();

  check('no script errors on any page', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  srv.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
