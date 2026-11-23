// Drives the inbox in headless Chromium at phone size (in-memory DB) and checks
// what a phone needs: the Home Screen app files, no zoom on the fields, the
// back gesture, the layout following the keyboard, the bell and the worker
// that shows a notification. Desktop is checked for staying as it was.
// npm run phone-check
const http = require('http');

Object.assign(process.env, {
  WHATSAPP_TOKEN: '', PHONE_NUMBER_ID: '', APP_SECRET: '', DATABASE_URL: '',
  VERIFY_TOKEN: 'x', SESSION_SECRET: 'demo_session_secret_0123456789',
  NODE_ENV: 'test',
});

const { chromium, webkit } = require('playwright');
const { makeFakeDb } = require('./fake-db');
const db = require('../lib/db');
const fake = makeFakeDb();
db.__setDbForTesting(fake);
require('./fake-backend').install();

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
// Members with long names and companies, one with a picture from the app,
// a chat whose 24-hour window has closed, and two saved replies.
const members = require('../lib/members');
const PICTURE = 'https://storage.bytepluslife.com/uploads/profiles/7';
members.__setLookupForTesting(async (ids) => [
  { wa_id: A, source: 'app', kind: 'member', name: 'Ada Lovelace Abdelrahman Mostafa', company: 'Nasaym International School (NIS)', active: true, image: PICTURE, image_bg: '#00FFFFFF' },
  { wa_id: B, source: 'contact', kind: 'hr', name: 'Marcus Chen', company: 'Granite Financial Holding', active: true, image: null, image_bg: null },
].filter((r) => ids.includes(r.wa_id)));
fake._tables.messages.push({ id: 60, wa_message_id: 'b1', wa_id: B, direction: 'in', type: 'text', body: 'Is the refund done? See https://bytepluslife.com/help.', status: 'received', wa_timestamp: iso(60 * 30), created_at: iso(60 * 30), media_meta: null, media_status: null, media_path: null, error: null, forwarded: false });
fake._tables.saved_replies.push(
  { id: 1, title: 'How to sync', body: 'Open the app and pull down on Home to sync.' },
  { id: 2, title: 'Points question', body: 'I am checking your points and will get back to you today.' },
);
Object.assign(fake._tables.conversations.find((c) => c.wa_id === A), { unread_count: 2 });
const storage = fake.storage.from();
fake.storage.from = () => ({ ...storage, createSignedUrl: async (p) => ({ data: { signedUrl: `/_photo/${p}?n=${Math.random()}` }, error: null }) });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

async function login(page, url) {
  await page.goto(url, { waitUntil: 'networkidle' });
  if (await page.isVisible('#login-email')) {
    await page.fill('#login-email', 'naglaa@byte.test');
    await page.fill('#login-password', 'demo');
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
    permissions: ['notifications', 'clipboard-read', 'clipboard-write'],
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
  const picture = { contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#c9b"/></svg>' };
  await phone.route('https://storage.bytepluslife.com/**', (route) => route.fulfill(picture));
  const page = await phone.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await login(page, `${base}/app`);

  // ---- the list on a phone
  const fits = async (pg) => pg.evaluate(() => ({ page: document.documentElement.scrollWidth, screen: document.documentElement.clientWidth, inner: window.innerWidth }));
  const w390 = await fits(page);
  check('the page is exactly as wide as the screen (the chat waiting off to the side used to double it)',
    w390.page === w390.screen && w390.inner === w390.screen, JSON.stringify(w390));
  const row = await page.evaluate(() => {
    const r = document.querySelector('.conv-row');
    const cut = (el) => el && el.scrollWidth > el.clientWidth + 1;
    return {
      name: r.querySelector('.row-name-text').textContent, nameCut: cut(r.querySelector('.row-name-text')),
      company: r.querySelector('.row-co').textContent, companyTitle: r.querySelector('.row-co').title,
      underTime: r.querySelector('.row-co').getBoundingClientRect().top >= r.querySelector('.row-time').getBoundingClientRect().bottom - 2,
      besideMessage: r.querySelector('.row-co').getBoundingClientRect().left >= r.querySelector('.row-preview').getBoundingClientRect().right - 1,
      insideRow: r.querySelector('.row-co').getBoundingClientRect().right <= r.getBoundingClientRect().right,
      badge: r.querySelector('.row-badge').textContent, unread: r.classList.contains('has-unread'),
      photo: Boolean(r.querySelector('.avatar img')),
    };
  });
  check('a long name is shown whole in the list, with the company under the time, beside the last message',
    row.name === 'Ada Lovelace Abdelrahman Mostafa' && !row.nameCut && row.company === 'Nasaym International School (NIS)'
      && row.companyTitle === 'Nasaym International School (NIS)' && row.underTime && row.besideMessage && row.insideRow, JSON.stringify(row));
  const filters = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('.list-filters .filter-chip')].filter((c) => !c.hidden);
    return { names: chips.map((c) => c.dataset.view), rows: new Set(chips.map((c) => Math.round(c.getBoundingClientRect().top))).size, scrolls: getComputedStyle(document.querySelector('.list-filters')).overflowX };
  });
  check('the filters are one row that scrolls sideways, and "Templates only" is gone',
    filters.rows === 1 && filters.scrolls === 'auto' && filters.names.join() === 'chats,needs_reply', JSON.stringify(filters));
  check("the member's picture from the app stands in for the initials", row.photo);
  const top = await page.evaluate(() => {
    const search = document.querySelector('#search').getBoundingClientRect();
    const me = document.querySelector('#me-btn').getBoundingClientRect();
    return { noHeader: !document.querySelector('.list-header') && !document.querySelector('#notify-btn'), sameRow: Math.abs((search.top + search.height / 2) - (me.top + me.height / 2)) < 4, meRight: me.left > search.right, top: Math.round(search.top) };
  });
  check('no top row: the search is first, with one round menu button beside it', top.noHeader && top.sameRow && top.meRight && top.top < 24, JSON.stringify(top));
  for (const width of [360, 390, 412]) {
    await page.setViewportSize({ width, height: 780 });
    await page.waitForTimeout(150);
    const fit = await page.evaluate(() => {
      const me = document.querySelector('#me-btn .me-initials').getBoundingClientRect();
      return { gutter: Math.round(window.innerWidth - me.right), sideways: document.documentElement.scrollWidth > window.innerWidth };
    });
    check(`the menu button sits fully inside the screen at ${width} wide`, fit.gutter >= 10 && !fit.sideways, JSON.stringify(fit));
  }
  await page.setViewportSize({ width: 390, height: 780 });
  await page.click('#me-btn');
  const meMenu = await page.evaluate(() => ({
    open: !document.querySelector('#me-menu').hidden,
    items: [...document.querySelectorAll('#me-menu .me-item')].filter((b) => !b.hidden).map((b) => b.textContent.trim()),
    name: document.querySelector('#me-name').textContent,
  }));
  check('the menu holds who is signed in, a new conversation, saved replies and sign out',
    meMenu.open && meMenu.items.join('|') === 'New conversation|Saved replies|Sign out' && meMenu.name.length > 0, JSON.stringify(meMenu));
  const itemSizes = await page.evaluate(() => [...document.querySelectorAll('#me-menu .me-item')].map((b) => Math.round(b.getBoundingClientRect().height)));
  check('menu rows are big enough for a thumb', itemSizes.every((h) => h >= 44), itemSizes.join(','));
  await page.mouse.click(5, 400);
  check('a tap outside closes the menu', await page.evaluate(() => document.querySelector('#me-menu').hidden));
  const targets = await page.evaluate(() => ['#me-btn', '.filter-chip']
    .map((s) => { const b = document.querySelector(s).getBoundingClientRect(); return `${s} ${Math.round(b.width)}x${Math.round(b.height)}`; }));
  check('the buttons are big enough for a thumb (40px high at least, 44 wide)',
    targets.every((s) => { const [w, h] = s.split(' ')[1].split('x').map(Number); return h >= 40 && w >= 44; }), targets.join(', '));
  check('the list says how many chats still need a reply',
    (await page.textContent('.filter-chip[data-view="needs_reply"] .chip-count')) === '2', await page.textContent('.filter-chip[data-view="needs_reply"]'));

  // the filters are tucked away on a phone; a pull down at the very top brings them out
  await page.evaluate(() => {
    const pad = document.createElement('div');
    pad.id = 'tall-pad'; pad.style.height = '3000px';
    document.querySelector('#conv-list').appendChild(pad);
  });
  const scrollList = async (y) => { await page.evaluate((v) => { document.querySelector('#conv-list').scrollTop = v; }, y); await page.waitForTimeout(320); };
  const pullDown = async () => {
    await page.evaluate(() => {
      const list = document.querySelector('#conv-list');
      const t = (y) => new Touch({ identifier: 1, target: list, clientX: 150, clientY: y });
      list.dispatchEvent(new TouchEvent('touchstart', { touches: [t(200)], bubbles: true }));
      list.dispatchEvent(new TouchEvent('touchmove', { touches: [t(260)], bubbles: true }));
      list.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
    });
    await page.waitForTimeout(450);
  };
  const tucked = () => page.evaluate(() => {
    const pane = document.querySelector('.pane-list');
    const f = document.querySelector('#list-filters').getBoundingClientRect();
    const s = document.querySelector('.search-row').getBoundingClientRect();
    return { tucked: pane.classList.contains('filters-tucked'), hiddenUnderSearch: f.bottom <= s.bottom + 1 };
  });
  const shots = process.env.SHOTS_DIR;
  await scrollList(0);
  const start = await tucked();
  if (shots) await page.screenshot({ path: `${shots}/filters-top.png` });
  check('on a phone the filters start tucked away, even at the top of the list', start.tucked && start.hiddenUnderSearch, JSON.stringify(start));
  check('with "Chats" on, nothing extra shows in the search', await page.isHidden('#view-pill'));
  await scrollList(500);
  await scrollList(200);
  check('scrolling the list up and down never brings them out', (await tucked()).tucked);
  check('the list scrolls freely with them tucked', await page.evaluate(() => document.querySelector('#conv-list').scrollTop) === 200);
  await scrollList(0);
  await pullDown();
  const pulled = await tucked();
  if (shots) await page.screenshot({ path: `${shots}/filters-pulled.png` });
  check('a pull down at the very top brings the filters out', !pulled.tucked && !pulled.hiddenUnderSearch, JSON.stringify(pulled));
  await page.click('.filter-chip[data-view="needs_reply"]');
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    if (!document.querySelector('#tall-pad')) { const pad = document.createElement('div'); pad.id = 'tall-pad'; pad.style.height = '3000px'; document.querySelector('#conv-list').appendChild(pad); }
  });
  await scrollList(400);
  check('scrolling down tucks them away again', (await tucked()).tucked);
  if (shots) await page.screenshot({ path: `${shots}/filters-tucked-needs-reply.png` });
  const pill = await page.evaluate(() => ({ shown: !document.querySelector('#view-pill').hidden, text: document.querySelector('#view-pill').textContent }));
  check('with the filters tucked, the active one stays in the search bar', pill.shown && /^Needs reply/.test(pill.text), JSON.stringify(pill));
  await page.click('#view-pill');
  await page.waitForTimeout(320);
  check('tapping it brings the filters back', !(await tucked()).tucked && await page.isHidden('#view-pill'));
  await page.click('.filter-chip[data-view="chats"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => { const pad = document.querySelector('#tall-pad'); if (pad) pad.remove(); document.querySelector('#conv-list').scrollTop = 0; });
  await page.waitForTimeout(200);

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

  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  check('the worker registers for the whole inbox', scope === `${base}/`, scope);

  await page.waitForFunction(() => document.querySelector('#me-notify').textContent.includes('on for this device'), null, { timeout: 5000 }).catch(() => {});
  check('notifications are on by themselves: the device is signed up with nothing to press',
    fake._tables.push_subscriptions.length === 1 && await page.evaluate(() => document.querySelector('#me-notify').textContent === 'Notifications are on for this device.'));
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
  // ---- the chat on a phone
  // Back at the newest message and at rest: a finger landing mid-glide only stops the glide.
  await page.evaluate(() => { const m = document.querySelector('#messages'); m.style.scrollBehavior = 'auto'; m.scrollTop = m.scrollHeight; m.style.scrollBehavior = ''; });
  await page.waitForTimeout(900);
  const header = await page.evaluate(() => {
    const cut = (s) => { const el = document.querySelector(s); return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1; };
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    return {
      name: document.querySelector('#thread-name').textContent, nameCut: cut('#thread-name-text'),
      height: Math.round(r('.thread-header').height), parts: document.querySelector('.thread-peer').children.length,
      press: Math.round(r('#thread-peer').height), under: Math.round(window.innerHeight - r('#composer-form').bottom),
    };
  });
  check('the chat header is one row beside the photo and still shows the whole name',
    header.name === 'Ada Lovelace Abdelrahman Mostafa' && !header.nameCut && header.height <= 52 && header.parts === 2 && header.press >= 44, JSON.stringify(header));
  check('nothing but a thin edge is left under the message box', header.under <= 5, `${header.under}px`);
  await page.click('#thread-peer');
  await page.waitForSelector('#peer-sheet:not([hidden])', { timeout: 3000 }).catch(() => {});
  const facts = await page.evaluate(() => [...document.querySelectorAll('#peer-rows .peer-row')].map((row) => [row.querySelector('.peer-label').textContent, row.querySelector('.peer-value').textContent]));
  check('a tap on the header opens the phone, the WhatsApp name and the whole company, and no longer says "Member"',
    JSON.stringify(facts) === JSON.stringify([['Phone', '+20 10 0123 4567'], ['On WhatsApp', 'Ada Lovelace'], ['Company', 'Nasaym International School (NIS)']]), JSON.stringify(facts));
  await page.click('#peer-rows [data-peer="copy"]');
  await page.waitForTimeout(250);
  check('a tap on the phone number copies it', (await page.evaluate(() => navigator.clipboard.readText()).catch(() => '')) === '+201001234567');
  await page.goBack();
  await page.waitForTimeout(300);
  check('the back gesture closes that sheet and leaves the chat open',
    await page.isHidden('#peer-sheet') && await page.evaluate(() => document.querySelector('#app').dataset.view === 'thread'));
  await page.click('#thread-avatar');
  await page.click('#peer-sheet [data-peer="rename"]');
  check('the sheet leads to the rename box', await page.isHidden('#peer-sheet') && await page.isVisible('#rename-modal'));
  await page.click('#rename-cancel');
  check('on a phone the microphone and send share one place', await page.isVisible('#mic-btn') && !(await page.isVisible('#send-btn')));
  check('the small buttons beside a bubble are gone on a touch screen', await page.evaluate(() => getComputedStyle(document.querySelector('.bubble-actions')).display === 'none'));

  // touch gestures, sent the way a finger sends them
  const cdp = await phone.newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const centre = async (selector) => page.evaluate((s) => {
    const all = [...document.querySelectorAll(s)];
    const b = all[all.length - 1].getBoundingClientRect();
    return { x: Math.round(b.left + Math.min(b.width / 2, 60)), y: Math.round(b.top + b.height / 2) };
  }, selector);

  let at = await centre('.bubble.in');
  await touch('touchStart', at.x, at.y);
  await page.waitForTimeout(650);
  await touch('touchEnd');
  check('a long press on a message opens its actions', await page.isVisible('#sheet'));
  const held = await page.evaluate(() => {
    const bubble = [...document.querySelectorAll('.bubble.in')].pop();
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    bubble.dispatchEvent(ev);
    const rowEv = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.querySelector('.conv-row').dispatchEvent(rowEv);
    return { select: getComputedStyle(bubble).userSelect, selected: String(window.getSelection()), ownMenu: ev.defaultPrevented, rowMenu: rowEv.defaultPrevented };
  });
  check('and nothing else: no text selection, no menu from the phone, on a message or a chat row',
    held.select === 'none' && held.selected === '' && held.ownMenu && held.rowMenu, JSON.stringify(held));
  const menu = await page.evaluate(() => ({
    actions: [...document.querySelectorAll('#sheet .sheet-action')].map((b) => b.textContent),
    reactions: document.querySelectorAll('.sheet-react').length,
    height: Math.min(...[...document.querySelectorAll('#sheet .sheet-action, .sheet-react')].map((b) => b.getBoundingClientRect().height)),
  }));
  check('with reactions, Reply, Copy and Forward, each big enough to tap',
    ['Reply', 'Copy', 'Forward'].every((a) => menu.actions.includes(a)) && menu.reactions === 6 && menu.height >= 44, JSON.stringify(menu));
  const reacted = page.waitForRequest((r) => r.url().endsWith('/api/react'), { timeout: 3000 }).catch(() => null);
  await page.click('.sheet-react');
  const reactReq = await reacted;
  check('tapping a reaction sends it and closes the menu',
    Boolean(reactReq) && reactReq.postDataJSON().emoji === '👍' && !(await page.isVisible('#sheet')));

  at = await centre('.bubble.in');
  await touch('touchStart', at.x, at.y);
  for (let dx = 12; dx <= 96; dx += 12) { await touch('touchMove', at.x + dx, at.y); await page.waitForTimeout(16); }
  await touch('touchEnd');
  await page.waitForTimeout(150);
  check('swiping a message to the right starts a reply to it',
    await page.isVisible('#reply-bar') && (await page.textContent('#reply-text')).length > 0 && !(await page.isVisible('#sheet')));
  await page.click('#reply-cancel');

  {
    const beside = await page.evaluate(() => {
      const all = [...document.querySelectorAll('#messages > .bubble.in')];
      const b = all[all.length - 1];
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      const x = Math.round(r.right + 12), y = Math.round(r.top + r.height / 2);
      return { x, y };
    });
    await touch('touchStart', beside.x, beside.y);
    for (let dx = 12; dx <= 96; dx += 12) { await touch('touchMove', beside.x + dx, beside.y); await page.waitForTimeout(16); }
    await touch('touchEnd');
    await page.waitForTimeout(150);
    check('swiping right in the empty space beside a message replies to it too',
      await page.isVisible('#reply-bar') && (await page.textContent('#reply-text')).length > 0 && !(await page.isVisible('#sheet')));
    if (await page.isVisible('#reply-bar')) await page.click('#reply-cancel');
  }

  at = await centre('.bubble.in');
  await touch('touchStart', at.x, at.y);
  for (let dy = 12; dy <= 120; dy += 12) { await touch('touchMove', at.x + 3, at.y - dy); await page.waitForTimeout(16); }
  await touch('touchEnd');
  await page.waitForTimeout(600);
  check('scrolling with a finger on a message does neither', !(await page.isVisible('#reply-bar')) && !(await page.isVisible('#sheet')));
  await page.evaluate(() => { const m = document.querySelector('#messages'); m.scrollTop = m.scrollHeight; });
  {
    const openPhoto = async () => {
      await page.evaluate(() => { [...document.querySelectorAll('.bubble [data-view]')].pop().click(); });
      await page.waitForSelector('#viewer:not([hidden]) .viewer-img');
      await page.waitForTimeout(250);
    };
    const drag = async (dx, dy, steps) => {
      await touch('touchStart', 195, 380);
      for (let i = 1; i <= steps; i++) { await touch('touchMove', 195 + (dx * i) / steps, 380 + (dy * i) / steps); await page.waitForTimeout(30); }
      await touch('touchEnd');
      await page.waitForTimeout(250);
    };
    await openPhoto();
    await drag(2, 70, 5);
    const settled = await page.isVisible('#viewer');
    await drag(0, 180, 8);
    const closed = !(await page.isVisible('#viewer'));
    await openPhoto();
    await drag(-120, 3, 6);
    const sideways = await page.isVisible('#viewer');
    await page.click('#viewer-close');
    check('a photo dragged down closes, a short drag settles back, a sideways swipe keeps it open',
      settled && closed && sideways && !(await page.isVisible('#viewer')), JSON.stringify({ settled, closed, sideways }));
  }
  const opened = await page.evaluate(() => ({ view: document.querySelector('#app').dataset.view, chat: Boolean(history.state && history.state.chat) }));
  check('opening a chat on a phone adds a step the back gesture can undo', opened.view === 'thread' && opened.chat);
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('#app').dataset.view === 'list');
  check('the back gesture returns to the list and stays in the inbox',
    await page.evaluate(() => document.querySelector('#thread').hidden && location.pathname === '/app'));

  const waitingRow = await page.evaluate(() => {
    const r = document.querySelector('.conv-row');
    return { waiting: r.classList.contains('is-waiting'), bold: r.classList.contains('has-unread'), badge: r.querySelector('.row-badge').textContent };
  });
  check('a chat that was opened but not answered still shows its count, calmer, for everyone',
    waitingRow.waiting && !waitingRow.bold && waitingRow.badge === '2' && fake._tables.conversations.find((c) => c.wa_id === A).unread_count === 2, JSON.stringify(waitingRow));
  {
    const r = await page.evaluate(() => { const b = document.querySelector('.conv-row').getBoundingClientRect(); return { x: Math.round(b.right - 40), y: Math.round(b.top + b.height / 2) }; });
    const done = page.waitForRequest((q) => /\/api\/conversations\/\d+\/read$/.test(q.url()), { timeout: 3000 }).catch(() => null);
    await touch('touchStart', r.x, r.y);
    for (let dx = 15; dx <= 135; dx += 15) { await touch('touchMove', r.x - dx, r.y); await page.waitForTimeout(16); }
    await touch('touchEnd');
    const doneReq = await done;
    await page.waitForTimeout(400);
    check('swiping a chat to the left marks it done, without opening it',
      Boolean(doneReq) && doneReq.postDataJSON().read === true && await page.evaluate(() => document.querySelector('#thread').hidden)
      && fake._tables.conversations.find((c) => c.wa_id === A).unread_count === 0,
      JSON.stringify({ sent: Boolean(doneReq), body: doneReq && doneReq.postDataJSON(), unread: fake._tables.conversations.find((c) => c.wa_id === A).unread_count }));
  }
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
  check('and the composer keeps no room for the home bar while the keyboard covers it',
    await page.evaluate(() => document.documentElement.classList.contains('kb-open') && getComputedStyle(document.querySelector('.composer')).paddingBottom === '4px'));
  check('and the latest messages stay in view', kb.gap <= before.gap + 4, `gap ${before.gap} -> ${kb.gap}`);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForFunction(() => !document.documentElement.classList.contains('kb-open'), null, { timeout: 3000 }).catch(() => {});
  check('and gives it back when the keyboard goes', await page.evaluate(() => !document.documentElement.classList.contains('kb-open')));
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

  // sign out from the menu
  await page.click('#back-btn').catch(() => {});
  await page.click('#me-btn');
  await page.click('#logout-btn');
  await page.waitForFunction(() => !document.querySelector('#login-screen').hidden, null, { timeout: 5000 }).catch(() => {});
  check('Sign out in the menu signs out and takes this device off notifications',
    fake._tables.push_subscriptions.length === 0 && await page.isVisible('#login-screen'));
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
  const hover = await d.getAttribute('#thread-peer', 'title');
  check('on a computer the phone and the company show on hover',
    hover.includes('Phone: +20 10 0123 4567') && hover.includes('Company: Nasaym International School (NIS)'), hover);
  check('the pen icon is gone and the name opens the details, with the rename box one click on',
    await d.evaluate(() => !document.querySelector('#rename-btn')) && await (async () => {
      await d.click('#thread-name');
      const card = await d.evaluate(() => {
        const c = document.querySelector('.peer-card').getBoundingClientRect();
        const h = document.querySelector('.thread-header').getBoundingClientRect();
        return !document.querySelector('#peer-sheet').hidden && c.top >= h.bottom && c.top < h.bottom + 20 && c.left >= h.left;
      });
      await d.click('#peer-sheet [data-peer="rename"]');
      const open = await d.isVisible('#rename-modal');
      await d.click('#rename-cancel');
      return card && open;
    })());

  // saved replies with "/"
  await d.fill('#composer-input', '/poi');
  await d.waitForSelector('#reply-picker:not([hidden])', { timeout: 3000 }).catch(() => {});
  const offered = await d.evaluate(() => [...document.querySelectorAll('#reply-picker .reply-opt-title')].map((e) => e.textContent));
  await d.press('#composer-input', 'Enter');
  check('typing / offers the saved replies, narrowed by what follows, and Enter puts one in the box',
    JSON.stringify(offered) === '["Points question"]' && await d.inputValue('#composer-input') === 'I am checking your points and will get back to you today.'
    && !(await d.isVisible('#reply-picker')), JSON.stringify(offered));
  await d.fill('#composer-input', '');

  // the 24-hour window, a link, and search
  await d.click('.conv-row >> nth=1');
  await d.waitForFunction(() => document.querySelector('#thread-name').textContent.includes('Marcus'));
  await d.waitForSelector('#window-bar:not([hidden])', { timeout: 3000 }).catch(() => {});
  check('a chat whose 24 hours have passed says so before anything is sent, and offers the template',
    /24 hours/.test(await d.textContent('#window-text')) && await d.isVisible('#window-action'), await d.textContent('#window-text'));
  const locked = await d.evaluate(() => ({
    form: !document.querySelector('#composer-form').hidden,
    words: document.querySelector('#window-text').textContent,
    action: document.querySelector('#window-action').textContent,
  }));
  check('there is no box to type in: one row says why and sends a template instead',
    !locked.form && locked.words === 'The 24 hours are over. Only a template can be sent.' && locked.action === 'Send a template', JSON.stringify(locked));
  const pastedHere = await d.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'a.png', { type: 'image/png' }));
    document.querySelector('#messages').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    return !document.querySelector('#attach-preview').hidden;
  });
  check('a picture pasted into that chat is not staged either', !pastedHere);
  const link = await d.evaluate(() => { const a = document.querySelector('.bubble .msg-link'); return a && { href: a.getAttribute('href'), target: a.target, rel: a.rel }; });
  check('a web address in a message is a link that opens in a new tab',
    Boolean(link) && link.href === 'https://bytepluslife.com/help' && link.target === '_blank' && /noopener/.test(link.rel), JSON.stringify(link));
  check('an HR contact keeps its label', (await d.textContent('#thread-member')) === 'HR, Granite Financial Holding', await d.textContent('#thread-member'));
  await d.click('.conv-row >> nth=0');
  await d.waitForFunction(() => document.querySelector('#thread-name').textContent.includes('Ada'));
  check('a chat inside its 24 hours shows no warning', !(await d.isVisible('#window-bar')));

  const searched = d.waitForRequest((r) => /\/api\/conversations\?.*q=granite/.test(r.url()), { timeout: 3000 }).catch(() => null);
  await d.fill('#search', 'granite');
  const searchReq = await searched;
  await d.waitForFunction(() => document.querySelectorAll('.conv-row').length === 1, null, { timeout: 3000 }).catch(() => {});
  check('search asks the server and finds a chat by its company',
    Boolean(searchReq) && await d.evaluate(() => document.querySelectorAll('.conv-row').length === 1 && document.querySelector('.row-name-text').textContent === 'Marcus Chen'));
  await d.fill('#search', '');
  await d.waitForFunction(() => document.querySelectorAll('.conv-row').length === 2, null, { timeout: 3000 }).catch(() => {});

  // who sent it
  const named = d.waitForRequest((r) => r.url().endsWith('/api/send') && r.method() === 'POST', { timeout: 4000 }).catch(() => null);
  await d.fill('#composer-input', 'hello from the team');
  await d.click('#send-btn');
  const namedReq = await named;
  check('every message carries the name on the account that is signed in, and nobody is asked to type one',
    Boolean(namedReq) && !('x-agent-name' in namedReq.headers()) && !(await d.$('#agent-modal'))
    && await d.evaluate(() => [...document.querySelectorAll('.bubble.out .meta-agent')].some((e) => e.textContent === 'Naglaa'))
    && await d.evaluate(() => document.querySelector('#me-name').textContent === 'Naglaa' && document.querySelector('#me-initials').textContent === 'N'));

  // the message box never keeps a height measured while the chat was not laid out
  {
    const tall = await d.evaluate(() => document.querySelector('#composer-input').getBoundingClientRect().height);
    check('the message box opens at its normal height', tall >= 36, String(tall));
  }

  // on a touch screen nothing outside a text box can be selected, the menu included
  {
    const sel = await d.evaluate(() => {
      document.documentElement.classList.add('by-touch');
      const card = document.querySelector('.sheet-card') || document.body;
      const box = document.querySelector('#composer-input');
      let above = null;
      for (let a = box.parentElement; a; a = a.parentElement) if (getComputedStyle(a).userSelect === 'none') { above = a.className || a.tagName; break; }
      return { chat: getComputedStyle(document.querySelector('#messages')).userSelect, list: getComputedStyle(document.querySelector('#conv-list')).userSelect, card: getComputedStyle(card).userSelect, box: getComputedStyle(box).userSelect, above };
    });
    check('a long press selects nothing in the chat, the list or the menu, and nothing above a text box is switched off (iPhone would not type)',
      sel.chat === 'none' && sel.list === 'none' && sel.card === 'none' && sel.box !== 'none' && !sel.above, JSON.stringify(sel));
  }

  // a text box keeps its caret on a touch screen: the search and the message box
  {
    const kept = await d.evaluate(async () => {
      document.documentElement.classList.add('by-touch');
      const out = {};
      for (const id of ['search', 'composer-input']) {
        const el = document.getElementById(id);
        el.focus();
        el.value = 'abc';
        el.setSelectionRange(1, 1);
        await new Promise((r) => setTimeout(r, 150));
        out[id] = document.activeElement === el && el.selectionStart === 1;
        el.value = '';
      }
      return out;
    });
    check('tapping the search or the message box keeps the caret and the keyboard on a touch screen', kept.search && kept['composer-input'], JSON.stringify(kept));
  }

  // the keyboard stays up after a send, as in WhatsApp
  await d.focus('#composer-input');
  await d.fill('#composer-input', 'one more line');
  await d.click('#send-btn');
  await d.waitForTimeout(400);
  check('after a send the message box keeps the focus, so the keyboard stays open',
    await d.evaluate(() => document.activeElement && document.activeElement.id === 'composer-input'));

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

  // the chat list on a wide screen: drag to resize, hide with the button or Ctrl+B, remembered
  {
    const listW = () => d.evaluate(() => Math.round(document.querySelector('.pane-list').getBoundingClientRect().width));
    const handleBox = () => d.evaluate(() => { const r = document.querySelector('#list-handle').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const dragBy = async (dx) => {
      const h = await handleBox();
      await d.mouse.move(h.x, h.y);
      await d.mouse.down();
      for (let i = 1; i <= 6; i++) { await d.mouse.move(h.x + (dx * i) / 6, h.y); await d.waitForTimeout(20); }
      await d.mouse.up();
      await d.waitForTimeout(320);
    };
    await d.click('.conv-row >> nth=0');
    await d.waitForSelector('#thread:not([hidden])');
    const start = await listW();
    await dragBy(100);
    const wider = await listW();
    check('dragging the edge of the chat list makes it wider', wider >= start + 90 && wider <= start + 110, `${start} -> ${wider}`);
    const sel = await d.evaluate(() => String(window.getSelection()));
    check('dragging selects no text', sel === '', JSON.stringify(sel));
    await dragBy(-900);
    check('it never gets narrower than 260', (await listW()) === 260, String(await listW()));
    await dragBy(1200);
    check('or wider than 45% of the window, at most 560', (await listW()) === Math.min(560, Math.round(1280 * 0.45)), String(await listW()));
    const h = await handleBox();
    await d.mouse.dblclick(h.x, h.y);
    await d.waitForTimeout(320);
    check('a double click on the edge resets the width', (await listW()) === 372, String(await listW()));
    await d.focus('#list-handle');
    await d.keyboard.press('ArrowRight');
    await d.keyboard.press('ArrowRight');
    await d.waitForTimeout(320);
    check('the arrow keys resize it by 16px from the keyboard', (await listW()) === 404, String(await listW()));
    await d.reload();
    await d.waitForSelector('.conv-row');
    check('the width is remembered after a reload', (await listW()) === 404, String(await listW()));
    await d.click('.conv-row >> nth=0');
    await d.waitForSelector('#thread:not([hidden])');
    await d.click('#list-toggle');
    await d.waitForTimeout(320);
    const hidden = await d.evaluate(() => ({ cls: document.querySelector('#app').classList.contains('list-hidden'), list: Math.round(document.querySelector('.pane-list').getBoundingClientRect().width), chat: Math.round(document.querySelector('.pane-thread').getBoundingClientRect().width) }));
    check('the button in the chat header hides the list and the chat takes the whole width', hidden.cls && hidden.list === 0 && hidden.chat === 1280, JSON.stringify(hidden));
    await d.click('#messages');
    await d.keyboard.press('Control+b');
    await d.waitForTimeout(320);
    check('Ctrl+B brings it back', (await listW()) === 404, String(await listW()));
    await d.focus('#composer-input');
    await d.keyboard.press('Control+b');
    await d.waitForTimeout(320);
    check('Ctrl+B does nothing while typing', (await listW()) === 404, String(await listW()));
    await d.click('#messages');
    await d.keyboard.press('Control+b');
    await d.waitForTimeout(320);
    await d.reload();
    await d.waitForSelector('.conv-row');
    const afterReload = await d.evaluate(() => ({ cls: document.querySelector('#app').classList.contains('list-hidden'), list: Math.round(document.querySelector('.pane-list').getBoundingClientRect().width) }));
    check('with no chat open the list always shows, even if it was hidden', !afterReload.cls && afterReload.list === 404, JSON.stringify(afterReload));
    await d.click('.conv-row >> nth=0');
    await d.waitForTimeout(320);
    check('and the hidden choice comes back once a chat is open', await d.evaluate(() => document.querySelector('#app').classList.contains('list-hidden')));
    await d.click('#list-toggle');
    await d.waitForTimeout(320);
    await d.evaluate(() => { localStorage.removeItem('wa_list_w'); localStorage.removeItem('wa_list_hidden'); });
    await d.reload();
    await d.waitForSelector('.conv-row');
  }
  if (process.env.SHOTS_DIR) {
    for (const [w, h] of [[1366, 800], [1920, 1080]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const sp = await ctx.newPage();
      await login(sp, `${base}/app`);
      const shot = async (name, width, hidden) => {
        await sp.evaluate(([wd, hd]) => {
          if (wd) localStorage.setItem('wa_list_w', String(wd)); else localStorage.removeItem('wa_list_w');
          localStorage.setItem('wa_list_hidden', hd ? '1' : '0');
        }, [width, hidden]);
        await sp.reload();
        await sp.waitForSelector('.conv-row');
        await sp.click('.conv-row >> nth=0');
        await sp.waitForSelector('#thread:not([hidden])');
        await sp.waitForTimeout(500);
        await sp.screenshot({ path: `${process.env.SHOTS_DIR}/${w}x${h}-${name}.png` });
      };
      await shot('default', null, false);
      await shot('wide', 560, false);
      await shot('narrow', 260, false);
      await shot('hidden', null, true);
      await ctx.close();
    }
  }
  await desk.close();

  // ------------------------------------------------- a 360px phone
  const small = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await small.route('https://storage.bytepluslife.com/**', (route) => route.fulfill(picture));
  const n = await small.newPage();
  n.on('pageerror', (e) => pageErrors.push(e.message));
  await login(n, `${base}/app`);
  const w360 = await fits(n);
  await n.click('.conv-row');
  await n.waitForSelector('.bubble');
  await n.waitForTimeout(600);
  const narrow = await n.evaluate(() => {
    const inside = (s) => { const el = document.querySelector(s); const b = el.getBoundingClientRect(); return b.left >= 0 && b.right <= window.innerWidth + 0.5 && b.width > 0; };
    const cut = (s) => { const el = document.querySelector(s); return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1; };
    return {
      inside: ['#back-btn', '#thread-name', '#followup-btn', '#attach-btn', '#composer-input', '#mic-btn'].filter((s) => !inside(s)),
      cut: ['#thread-name-text'].filter(cut),
      header: Math.round(document.querySelector('.thread-header').getBoundingClientRect().height),
      bubbles: [...document.querySelectorAll('.bubble')].filter((b) => b.getBoundingClientRect().right > window.innerWidth).length,
      input: Math.round(document.querySelector('#composer-input').getBoundingClientRect().width),
    };
  });
  check('at 360px wide the page still fits the screen', w360.page === w360.screen && w360.inner === w360.screen, JSON.stringify(w360));
  check('and nothing in the chat is cut off or pushed off the edge',
    narrow.inside.length === 0 && narrow.cut.length === 0 && narrow.bubbles === 0 && narrow.input >= 150 && narrow.header <= 52, JSON.stringify(narrow));
  await small.close();

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
