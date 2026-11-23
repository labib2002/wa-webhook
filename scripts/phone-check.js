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

const { chromium, webkit } = require('playwright');
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
// Photos of every shape members send: tall screenshots, wide ones, square,
// small. Half carry their pixel size (rows stored from now on), half do not
// (rows stored before it was kept); every third one has a caption.
const SHAPES = [[1170, 2532], [1600, 900], [1080, 1080], [200, 120], [900, 1600], [2000, 500]];
let photos = 0;
for (let i = 1; i <= 45; i++) {
  const photo = i % 3 === 0;
  const [w, h] = SHAPES[photos % SHAPES.length];
  const meta = photo ? { id: `p${i}`, mime_type: 'image/png', caption: photos % 3 === 0 ? 'I trained for 64 minutes but did not get the full score' : null, ...(photos % 2 ? { w, h } : {}) } : null;
  fake._tables.messages.push({ id: i, wa_message_id: `m${i}`, wa_id: A, direction: i % 2 ? 'in' : 'out', type: photo ? 'image' : 'text', body: photo ? '📷 Image' : `message ${i}`, status: 'received', wa_timestamp: iso(90 - i), created_at: iso(90 - i), media_meta: meta, media_status: photo ? 'stored' : null, media_path: photo ? `${w}x${h}` : null, error: null, forwarded: false });
  if (photo) photos++;
}
fake._tables.messages.push({ id: 46, wa_message_id: 'm46', wa_id: A, direction: 'in', type: 'text', body: 'تمام، هبعت screenshot من ال app دلوقتي', status: 'received', wa_timestamp: iso(1), created_at: iso(1), media_meta: null, media_status: null, media_path: null, error: null, forwarded: false });
const storage = fake.storage.from();
fake.storage.from = () => ({ ...storage, createSignedUrl: async (p) => ({ data: { signedUrl: `/_photo/${p}?n=${Math.random()}` }, error: null }) });

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
  // The media route redirects here. Nothing is cached, and the photos land
  // several at the same instant, the way a first open on a phone goes.
  const waiting = [];
  setInterval(() => { for (const send of waiting.splice(0)) send(); }, 330).unref();
  app.get('/_photo/:size', (req, res) => {
    const [w, h] = req.params.size.split('x').map(Number);
    waiting.push(() => res.set('Content-Type', 'image/svg+xml').set('Cache-Control', 'no-store')
      .send(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#8fd0ba"/><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 2 - 4}" fill="#235"/></svg>`));
  });
  const srv = http.createServer(app).listen(0);

  // Opens the first chat three times over and watches it while its photos
  // arrive. Whether a late photo knocks the chat off its end depends on how
  // the arrivals fall, so one open proves little.
  const openAndWatch = async (pg, leave) => {
    let worst = 0;
    for (let round = 0; round < 3; round++) {
      if (round) await leave();
      await pg.click('.conv-row');
      await pg.waitForSelector('.bubble');
      for (let i = 0; i < 28; i++) {
        await pg.waitForTimeout(100);
        const gap = await pg.evaluate(() => { const m = document.querySelector('#messages'); return Math.round(m.scrollHeight - m.scrollTop - m.clientHeight); });
        if (i >= 3) worst = Math.max(worst, gap);
      }
    }
    return pg.evaluate((worstGap) => {
      const m = document.querySelector('#messages');
      const last = [...m.querySelectorAll('.bubble')].pop().getBoundingClientRect();
      const box = m.getBoundingClientRect();
      const shapes = [...m.querySelectorAll('.media-frame img, .bubble img')].filter((i) => i.complete && i.naturalWidth).map((i) => {
        const r = i.getBoundingClientRect();
        const real = i.naturalWidth / i.naturalHeight;
        // only a panorama or something taller than a phone screen may be cropped
        const kept = Math.min(3, Math.max(0.45, real));
        return { real: +real.toFixed(2), shown: +(r.width / r.height).toFixed(2), off: Math.abs(r.width / r.height - kept) / kept };
      });
      return {
        gap: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight), worstGap,
        lastVisible: last.bottom <= box.bottom + 1 && last.top >= box.top,
        photos: shapes.length, bent: shapes.filter((s) => s.off > 0.03),
      };
    }, worst);
  };
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
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
  const land = await openAndWatch(page, async () => {
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('#app').dataset.view === 'list');
  });
  check('first open of a chat whose photos are not cached: it opens at the newest message and never leaves it while they load',
    land.gap <= 2 && land.worstGap <= 2 && land.lastVisible && land.photos > 0, JSON.stringify({ ...land, bent: land.bent.length }));
  check('no photo is stretched, squashed or cut to another shape', land.photos > 0 && land.bent.length === 0, JSON.stringify(land.bent));
  // The race itself, forced: a photo takes its height, the browser reports a
  // scroll, and only then does the photo's load event run.
  const raced = await page.evaluate(() => {
    const m = document.querySelector('#messages');
    const frame = [...m.querySelectorAll('.media-frame')].pop();
    frame.style.height = `${frame.getBoundingClientRect().height + 500}px`;
    m.dispatchEvent(new Event('scroll'));
    frame.querySelector('img').dispatchEvent(new Event('load'));
    const gap = Math.round(m.scrollHeight - m.scrollTop - m.clientHeight);
    frame.style.height = '';
    return gap;
  });
  check('a scroll event caused by the chat growing is not taken for the agent scrolling away', raced <= 2, `gap ${raced}`);
  const bidi = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.bubble')].pop();
    const cs = getComputedStyle(b);
    return { bidi: cs.unicodeBidi, align: cs.textAlign, composer: document.querySelector('#composer-input').getAttribute('dir') };
  });
  check('Arabic with English inside reads in its own direction, in bubbles and in the composer',
    bidi.bidi === 'plaintext' && bidi.align === 'start' && bidi.composer === 'auto', JSON.stringify(bidi));
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
  const desk = await browser.newContext({ viewport: { width: 1280, height: 832 }, permissions: ['microphone'] });
  const d = await desk.newPage();
  d.on('pageerror', (e) => pageErrors.push(e.message));
  await login(d, `${base}/app`);
  const dland = await openAndWatch(d, async () => {
    await d.click('.conv-row >> nth=1');
    await d.waitForFunction(() => document.querySelector('#thread-name').textContent.includes('Marcus'));
  });
  check('on desktop too the chat opens at its newest message and stays there',
    dland.gap <= 2 && dland.worstGap <= 2 && dland.lastVisible && dland.photos > 0, JSON.stringify({ ...dland, bent: dland.bent.length }));
  check('and photos keep their shape there', dland.photos > 0 && dland.bent.length === 0, JSON.stringify(dland.bent));

  // reading older messages while photos are still arriving
  await d.click('.conv-row >> nth=1');
  await d.waitForFunction(() => document.querySelector('#thread-name').textContent.includes('Marcus'));
  await d.click('.conv-row >> nth=0');
  await d.waitForSelector('.media-frame');
  await d.hover('#messages');
  await d.mouse.wheel(0, -1500);
  await d.waitForTimeout(2500);
  const up = await d.evaluate(() => { const m = document.querySelector('#messages'); return Math.round(m.scrollHeight - m.scrollTop - m.clientHeight); });
  check('an agent who scrolls up while photos are still arriving is left where they are', up > 400, `gap ${up}`);
  await d.evaluate(() => { const m = document.querySelector('#messages'); m.scrollTop = m.scrollHeight; });

  // the name is the way to rename; the pen is gone
  check('the pen icon is gone and the name opens the rename box',
    await d.evaluate(() => !document.querySelector('#rename-btn')) && await (async () => {
      await d.click('#thread-name');
      const open = await d.isVisible('#rename-modal');
      await d.click('#rename-cancel');
      return open;
    })());

  // one dropped request must not lock the composer
  await d.route('**/api/send', (route) => route.abort());
  await d.fill('#composer-input', 'first try');
  await d.click('#send-btn');
  await d.waitForSelector('.bubble.failed', { timeout: 4000 }).catch(() => {});
  await d.unroute('**/api/send');
  await d.fill('#composer-input', 'second try');
  const sendAgain = d.waitForRequest((r) => r.url().endsWith('/api/send') && r.method() === 'POST', { timeout: 4000 }).catch(() => null);
  const enabled = await d.isEnabled('#send-btn');
  if (enabled) await d.click('#send-btn');
  check('after a request that never reached the server the composer still sends', enabled && Boolean(await sendAgain));

  // a voice note belongs to the chat it was recorded in
  await d.fill('#composer-input', 'half typed');
  await d.click('#mic-btn');
  await d.waitForSelector('#rec-bar:not([hidden])', { timeout: 5000 }).catch(() => {});
  if (await d.isVisible('#rec-bar')) {
    await d.waitForTimeout(700);
    await d.click('.conv-row >> nth=1');
    await d.waitForFunction(() => document.querySelector('#thread-name').textContent.includes('Marcus'));
    const hint = await d.textContent('#rec-hint');
    const voice = d.waitForRequest((r) => r.url().endsWith('/api/send-media'), { timeout: 5000 }).catch(() => null);
    await d.click('#rec-send');
    const sentTo = await voice;
    check('a voice note recorded in one chat goes to that chat after the agent opens another',
      Boolean(sentTo) && sentTo.postDataJSON().wa_id === A && sentTo.postDataJSON().voice === true && /Ada/.test(hint), hint);
    await d.click('.conv-row >> nth=0');
    await d.waitForFunction(() => document.querySelector('#thread-name').textContent.includes('Ada'));
    check('and what was typed before recording is still in the composer',
      await d.inputValue('#composer-input') === 'half typed', await d.inputValue('#composer-input'));
  } else {
    check('a voice note recorded in one chat goes to that chat after the agent opens another', false, 'the recorder did not start');
  }
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

  // ------------------------------------------------- Safari's engine
  let safari = null;
  try { safari = await webkit.launch(); } catch (_) { console.log('SKIP  WebKit is not installed here (npx playwright install webkit)'); }
  if (safari) {
    const iphone = await safari.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 3, hasTouch: true });
    const s = await iphone.newPage();
    s.on('pageerror', (e) => pageErrors.push(e.message));
    await login(s, `${base}/app`);
    const sland = await openAndWatch(s, async () => {
      await s.goBack();
      await s.waitForFunction(() => document.querySelector('#app').dataset.view === 'list');
    });
    check("in Safari's engine at iPhone size the chat opens at its newest message and stays there",
      sland.gap <= 2 && sland.worstGap <= 2 && sland.lastVisible && sland.photos > 0, JSON.stringify({ ...sland, bent: sland.bent.length }));
    check('and photos keep their shape there', sland.photos > 0 && sland.bent.length === 0, JSON.stringify(sland.bent));
    await safari.close();
  }

  check('no script errors on any page', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  srv.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
