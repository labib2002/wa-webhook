// Drives the inbox in WebKit with an iPhone profile (in-memory DB) and checks
// what Safari on an iPhone needs: every text box takes typing and keeps its
// caret, the time and the sender's name never sit on a message's text, in
// either direction, and the voice note player works by touch.
// npm run iphone-check
const http = require('http');

Object.assign(process.env, {
  WHATSAPP_TOKEN: '', PHONE_NUMBER_ID: '', APP_SECRET: '', DATABASE_URL: '',
  VERIFY_TOKEN: 'x', SESSION_SECRET: 'demo_session_secret_0123456789',
  NODE_ENV: 'test',
});

const { webkit, chromium, devices } = require('playwright');
const { makeFakeDb } = require('./fake-db');
const db = require('../lib/db');
const fake = makeFakeDb();
db.__setDbForTesting(fake);
require('./fake-backend').install();

const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
const C = '201555464744';
fake._tables.conversations.push(
  { wa_id: C, profile_name: 'Labib', last_message_text: 'تمت', last_message_at: iso(1), last_message_direction: 'in', unread_count: 0, created_at: iso(999) },
);
const rows = [
  ['in', 'Yo yoyo', null],
  ['out', 'Hello there', 'Naglaa Mohamed'],
  ['out', 'استاذ لبيب', 'Labib'],
  ['out', 'ازي حضرتك', 'Labib'],
  ['out', 'استاذ لبيب', 'Naglaa Mohamed'],
  ['in', 'تمت', null],
  ['in', 'ن', null],
  ['out', 'U', 'Labib'],
  ['out', '👍', 'Labib'],
  ['out', 'تمام ok هبعتلك الملف دلوقتي', 'Labib'],
  ['out', 'This is a long message that wraps across several lines so the time has to find room on the last one without sitting on the words', 'Naglaa Mohamed'],
  ['out', 'رسالة طويلة بالعربي بتلف على كذا سطر عشان نتأكد إن الوقت واسم اللي بعت ميقعدوش فوق الكلام في آخر سطر خالص', 'Naglaa Mohamed'],
  ['in', 'Hdhdhdhdhd', null],
];
rows.forEach(([direction, body, agent], i) => {
  fake._tables.messages.push({ id: 200 + i, wa_message_id: `w${i}`, wa_id: C, direction, type: 'text', body, status: direction === 'out' ? 'read' : 'received', agent, wa_timestamp: iso(60 - i), created_at: iso(60 - i), media_meta: null, media_status: null, media_path: null, error: null, forwarded: false });
});
fake._tables.messages.push(
  { id: 300, wa_message_id: 'v1', wa_id: C, direction: 'in', type: 'audio', body: '🎤 Voice message', status: 'received', wa_timestamp: iso(5), created_at: iso(5), media_meta: { voice: true, mime_type: 'audio/wav' }, media_status: 'stored', media_path: 'note.wav', error: null, forwarded: false },
  { id: 301, wa_message_id: 'v2', wa_id: C, direction: 'out', type: 'audio', body: '🎵 Audio', status: 'read', agent: 'Labib', wa_timestamp: iso(4), created_at: iso(4), media_meta: { mime_type: 'audio/wav' }, media_status: 'stored', media_path: 'note.wav', error: null, forwarded: false },
  { id: 302, wa_message_id: 'v3', wa_id: C, direction: 'in', type: 'text', body: 'تمت', status: 'received', wa_timestamp: iso(1), created_at: iso(1), media_meta: null, media_status: null, media_path: null, error: null, forwarded: false },
);
const storage = fake.storage.from();
fake.storage.from = () => ({ ...storage, createSignedUrl: async (p) => ({ data: { signedUrl: `/_media/${p}` }, error: null }) });

// Two seconds of a quiet tone as a WAV, so the player has something real to play.
function wav(seconds = 2, rate = 8000) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 8) * 2000), 44 + i * 2);
  return buf;
}

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
  await page.waitForSelector('.conv-row', { state: 'visible', timeout: 8000 });
}

// Text of a bubble (its own text, not the time line) that a time line covers.
const overlaps = (page) => page.evaluate(() => {
  const out = [];
  for (const b of document.querySelectorAll('.bubble:not(.has-media)')) {
    const meta = b.querySelector(':scope > .meta');
    if (!meta) continue;
    const m = meta.getBoundingClientRect();
    const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT, {
      acceptNode: (t) => (t.parentElement.closest('.meta, .meta-pad, .bubble-actions, .reaction-pill, .vplayer') || !t.textContent.trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let hit = false;
    while (walker.nextNode()) {
      const r = document.createRange();
      r.selectNodeContents(walker.currentNode);
      for (const t of r.getClientRects()) {
        const x = Math.min(t.right, m.right) - Math.max(t.left, m.left);
        const y = Math.min(t.bottom, m.bottom) - Math.max(t.top, m.top);
        if (x > 1 && y > 1) hit = true;
      }
    }
    if (hit) out.push(b.textContent.trim().slice(0, 30));
  }
  return out;
});

(async () => {
  const app = require('../api/index');
  const tone = wav();
  app.get('/_media/:p', (req, res) => {
    if (req.params.p.endsWith('.wav')) return res.set('Content-Type', 'audio/wav').send(tone);
    res.set('Content-Type', 'image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/>');
  });
  const srv = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const shots = process.env.SHOTS_DIR;
  const pageErrors = [];

  const runs = [['webkit', webkit, devices['iPhone 13']], ['chromium', chromium, devices['Pixel 7']]];
  for (const [label, engine, device] of runs) {
    const browser = await engine.launch();
    const ctx = await browser.newContext({ ...device });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => pageErrors.push(`${label}: ${e.message}`));
    await login(page, `${base}/app`);
    await page.click('.conv-row');
    await page.waitForSelector('.bubble');
    await page.waitForTimeout(700);
    if (shots) await page.screenshot({ path: `${shots}/${label}-chat.png` });

    const hits = await overlaps(page);
    check(`${label}: the time and the sender never sit on a message's text (Arabic, English, emoji, short and long)`, hits.length === 0, JSON.stringify(hits));
    const order = await page.evaluate(() => [...document.querySelectorAll('.bubble:not(.has-media)')].every((b) => {
      const meta = b.querySelector(':scope > .meta');
      if (!meta) return true;
      const m = meta.getBoundingClientRect();
      const r = b.getBoundingClientRect();
      return m.bottom <= r.bottom + 1 && m.right <= r.right + 1 && m.left >= r.left - 1;
    }));
    check(`${label}: the time line stays inside its bubble`, order);

    // every text box takes typing and keeps its caret, with nothing above it switched off for selection
    const fields = [
      ['#composer-input', null],
      ['#search', async () => { await page.click('#back-btn').catch(() => {}); await page.waitForTimeout(400); }],
    ];
    for (const [sel, before] of fields) {
      if (before) await before();
      await page.tap(sel).catch(() => page.click(sel));
      await page.keyboard.type('abc تمام');
      const got = await page.evaluate((s) => {
        const el = document.querySelector(s);
        let blocked = null;
        for (let a = el.parentElement; a; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if ((cs.webkitUserSelect || cs.userSelect) === 'none') { blocked = a.className || a.tagName; break; }
        }
        return { value: el.value, caret: el.selectionStart, focused: document.activeElement === el, blocked };
      }, sel);
      check(`${label}: ${sel} takes typing and keeps the caret`, got.value === 'abc تمام' && got.caret === got.value.length && got.focused && !got.blocked, JSON.stringify(got));
      await page.fill(sel, '');
    }
    await page.click('#me-btn');
    await page.click('#new-chat-btn');
    await page.waitForSelector('#new-chat-number', { state: 'visible' });
    for (const sel of ['#new-chat-number', '#new-chat-name']) {
      await page.tap(sel).catch(() => page.click(sel));
      await page.keyboard.type(sel === '#new-chat-number' ? '01012345678' : 'Sara');
      const v = await page.inputValue(sel);
      check(`${label}: ${sel} takes typing`, v === (sel === '#new-chat-number' ? '01012345678' : 'Sara'), v);
    }
    await page.click('#new-chat-cancel');

    // the player
    await page.click('.conv-row');
    await page.waitForSelector('.vplayer');
    const player = await page.evaluate(() => {
      const p = document.querySelector('.vplayer');
      return { native: Boolean(document.querySelector('.bubble audio[controls]')), play: Boolean(p.querySelector('.vp-play')), speed: p.querySelector('.vp-speed').textContent.trim(), time: p.querySelector('.vp-time').textContent.trim() };
    });
    check(`${label}: voice notes and audio files use our player, not the browser's bar`, !player.native && player.play && player.speed === '1x', JSON.stringify(player));
    if (shots) await page.screenshot({ path: `${shots}/${label}-player.png` });
    await page.tap('.vplayer .vp-speed').catch(() => page.click('.vplayer .vp-speed'));
    const speeds = await page.evaluate(() => [...document.querySelectorAll('.vplayer .vp-speed')].map((b) => b.textContent.trim()));
    check(`${label}: the speed chip goes to 1.5x and every player follows it`, speeds.every((s) => s === '1.5x'), JSON.stringify(speeds));
    for (let i = 0; i < 3; i++) await page.tap('.vplayer .vp-speed').catch(() => page.click('.vplayer .vp-speed'));
    const cycle = await page.evaluate(() => document.querySelector('.vplayer .vp-speed').textContent.trim());
    check(`${label}: the speed goes 1x, 1.5x, 2x, 0.5x and back to 1x`, cycle === '1x', cycle);
    await page.tap('.vplayer .vp-speed').catch(() => page.click('.vplayer .vp-speed'));
    await page.tap('.vplayer .vp-play').catch(() => page.click('.vplayer .vp-play'));
    await page.waitForTimeout(900);
    const playing = await page.evaluate(() => {
      const a = document.querySelector('.vplayer audio');
      return { paused: a.paused, rate: a.playbackRate, t: a.currentTime, state: document.querySelector('.vplayer').dataset.state };
    });
    const decodes = await page.evaluate(() => { const a = document.querySelector('.vplayer audio'); return !(a.error && a.error.code === 4) && a.canPlayType('audio/wav') !== ''; });
    if (decodes) check(`${label}: play starts the note at the chosen speed`, !playing.paused && playing.rate === 1.5 && playing.t > 0, JSON.stringify(playing));
    else {
      check(`${label}: an audio file this browser cannot decode shows "try again" instead of hanging`, playing.state === 'error', JSON.stringify(playing));
      console.log(`SKIP  ${label}: playback and seeking (this ${label} build cannot decode audio here)`);
    }
    const seek = await page.evaluate(() => {
      const t = document.querySelector('.vplayer .vp-track').getBoundingClientRect();
      return { x: t.left + t.width * 0.75, y: t.top + t.height / 2 };
    });
    await page.mouse.click(seek.x, seek.y);
    await page.waitForTimeout(200);
    const sought = await page.evaluate(() => { const a = document.querySelector('.vplayer audio'); return a.duration ? a.currentTime / a.duration : -1; });
    if (decodes) check(`${label}: tapping the bar jumps to that point`, sought > 0.6, String(sought));
    const second = await page.$$('.vplayer .vp-play');
    if (second.length > 1) {
      await second[1].tap().catch(() => second[1].click());
      await page.waitForTimeout(500);
      const both = await page.evaluate(() => [...document.querySelectorAll('.vplayer audio')].map((a) => a.paused));
      check(`${label}: starting another note pauses the first`, both[0] === true, JSON.stringify(both));
      await second[1].tap().catch(() => second[1].click());
    }

    // two quick taps on a message answer it
    const tapped = await page.evaluate(async () => {
      const el = [...document.querySelectorAll('.bubble.in')].find((b) => b.textContent.includes('Hdhdhdhdhd'));
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const x = r.left + 20; const y = r.top + r.height / 2;
      // WebKit here has no Touch constructor, so a plain event carries the touch lists.
      const fire = (type, list) => {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : list });
        Object.defineProperty(ev, 'changedTouches', { value: list });
        el.dispatchEvent(ev);
      };
      const tap = () => { const t = [{ clientX: x, clientY: y, identifier: 1, target: el }]; fire('touchstart', t); fire('touchend', t); };
      tap();
      await new Promise((ok) => setTimeout(ok, 90));
      tap();
      return 'touch';
    });
    await page.waitForTimeout(300);
    if (tapped !== 'touch') console.log(`SKIP  ${label}: double tap (${tapped})`);
    const reply = await page.evaluate(() => ({ bar: !document.querySelector('#reply-bar').hidden, text: document.querySelector('#reply-text').textContent }));
    if (tapped === 'touch') check(`${label}: two quick taps on a message start a reply to it`, reply.bar && reply.text.includes('Hdhdhdhdhd'), JSON.stringify(reply));
    await page.click('#reply-cancel').catch(() => {});
    if (shots) await page.screenshot({ path: `${shots}/${label}-after-player.png` });
    await ctx.close();
    await browser.close();
  }

  // a computer: a double click on a message, or beside it, answers it, and selects nothing
  {
    const browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1366, height: 820 } })).newPage();
    page.on('pageerror', (e) => pageErrors.push(`desktop: ${e.message}`));
    await login(page, `${base}/app`);
    await page.click('.conv-row');
    await page.waitForSelector('.bubble');
    await page.waitForTimeout(500);
    const bubble = page.locator('.bubble.in', { hasText: 'Hdhdhdhdhd' });
    await bubble.dblclick();
    await page.waitForTimeout(200);
    let r = await page.evaluate(() => ({ bar: !document.querySelector('#reply-bar').hidden, text: document.querySelector('#reply-text').textContent, selected: String(window.getSelection()) }));
    check('desktop: a double click on a message starts a reply and selects no text', r.bar && r.text.includes('Hdhdhdhdhd') && !r.selected, JSON.stringify(r));
    await page.click('#reply-cancel');
    const beside = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.bubble.out')].find((x) => x.textContent.includes('This is a long message'));
      b.scrollIntoView({ block: 'center' });
      const rb = b.getBoundingClientRect();
      const box = document.querySelector('#messages').getBoundingClientRect();
      return { x: box.left + 30, y: rb.top + rb.height / 2 };
    });
    await page.mouse.dblclick(beside.x, beside.y);
    await page.waitForTimeout(200);
    r = await page.evaluate(() => ({ bar: !document.querySelector('#reply-bar').hidden, text: document.querySelector('#reply-text').textContent }));
    check('desktop: a double click in the empty space beside a message answers that message', r.bar && r.text.includes('This is a long message'), JSON.stringify(r));
    if (shots) await page.screenshot({ path: `${shots}/desktop-player.png` });
    await browser.close();
  }

  check('no script errors', pageErrors.length === 0, pageErrors.join(' | '));
  srv.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
