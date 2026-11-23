// Sends a text, a photo, a voice note and a template in a phone-sized
// browser and counts what the page rebuilds on the way: bubbles thrown away,
// photos and players made again, day chips redrawn, chat rows redrawn. Each
// send then gets the usual status webhooks (sent, delivered, read).
// npm run smooth-check   (SMOOTH_VIDEO=<dir> also records a video)
const http = require('http');
Object.assign(process.env, {
  WHATSAPP_TOKEN: 'x', PHONE_NUMBER_ID: '1', APP_SECRET: '', DATABASE_URL: '',
  VERIFY_TOKEN: 'x', SESSION_SECRET: 'demo_session_secret_0123456789', NODE_ENV: 'test',
});
const { chromium } = require('playwright');
const { makeFakeDb } = require('./fake-db');
const db = require('../lib/db');
const fake = makeFakeDb();
db.__setDbForTesting(fake);
require('./fake-backend').install();
const wa = require('../lib/whatsapp');
const { ingestWebhook } = require('../lib/ingest');
const live = require('../lib/live');

let seq = 0;
wa.sendText = async () => ({ ok: true, waMessageId: `wamid.T${++seq}` });
wa.sendMedia = async () => ({ ok: true, waMessageId: `wamid.M${++seq}` });
wa.uploadMedia = async () => ({ ok: true, mediaId: `media${++seq}` });
wa.sendTemplate = async () => ({ ok: true, waMessageId: `wamid.P${++seq}` });

const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
const A = '201001234567';
fake._tables.conversations.push(
  { wa_id: A, profile_name: 'Ada Lovelace', last_message_text: 'hi', last_message_at: iso(2), last_message_direction: 'in', unread_count: 0, created_at: iso(999) },
  { wa_id: '447700900123', profile_name: 'Marcus Chen', last_message_text: 'yo', last_message_at: iso(18), last_message_direction: 'in', unread_count: 0, created_at: iso(999) },
);
for (let i = 1; i <= 12; i++) {
  fake._tables.messages.push({ id: 900 + i, wa_message_id: `m${i}`, wa_id: A, direction: i % 2 ? 'in' : 'out', type: 'text', body: `message ${i}`, status: i % 2 ? 'received' : 'read', wa_timestamp: iso(60 - i), created_at: iso(60 - i), updated_at: iso(60 - i), media_meta: null, media_status: null, media_path: null, error: null, forwarded: false });
}

const statusHook = (wamid, status) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1' }, statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: A }] } }] }],
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const app = require('../api/index');
  const srv = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const ctx = await browser.newContext({
    viewport: { width: Number(process.env.SMOOTH_W) || 412, height: Number(process.env.SMOOTH_H) || 915 }, deviceScaleFactor: 2, hasTouch: Number(process.env.SMOOTH_W || 412) < 900, isMobile: Number(process.env.SMOOTH_W || 412) < 900,
    permissions: ['microphone'],
    ...(process.env.SMOOTH_VIDEO ? { recordVideo: { dir: process.env.SMOOTH_VIDEO, size: { width: 412, height: 915 } } } : {}),
  });
  const page = await ctx.newPage();
  await page.goto(base + '/app', { waitUntil: 'networkidle' });
  if (await page.isVisible('#login-email')) {
    await page.fill('#login-email', 'naglaa@byte.test');
    await page.fill('#login-password', 'demo');
    await page.click('#login-btn');
  }
  await page.waitForSelector('.conv-row', { timeout: 8000 });
  await page.evaluate(() => {
    window.__count = { bubbleAfterMs: -1, bubblesRemoved: 0, bubblesAdded: 0, mediaMade: 0, chipsRedrawn: 0, rowsRedrawn: 0, mutations: 0 };
    const tag = (n, k) => { if (n.nodeType !== 1) return; if (n.classList.contains('bubble')) { window.__count[k === 'add' ? 'bubblesAdded' : 'bubblesRemoved']++; if (k === 'add' && window.__count.bubbleAfterMs < 0 && window.__t0) window.__count.bubbleAfterMs = Math.round(performance.now() - window.__t0); } if (k === 'add') { if (n.classList.contains('day-sep')) window.__count.chipsRedrawn++; if (n.classList.contains('conv-row')) window.__count.rowsRedrawn++; window.__count.mediaMade += n.matches('img,audio,video') ? 1 : n.querySelectorAll('img,audio,video').length; } };
    const obs = new MutationObserver((list) => {
      for (const r of list) {
        window.__count.mutations++;
        r.addedNodes.forEach((n) => tag(n, 'add'));
        r.removedNodes.forEach((n) => tag(n, 'rm'));
      }
    });
    obs.observe(document.querySelector('#messages'), { childList: true, subtree: true, attributes: true, characterData: true });
    obs.observe(document.querySelector('#conv-list'), { childList: true, subtree: true, attributes: true, characterData: true });
  });
  const shots = process.env.SMOOTH_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}-list.png` });
  await page.click(`.conv-row[data-wa="${A}"]`);
  await page.waitForSelector('.bubble');
  await page.waitForTimeout(800);

  const reset = () => page.evaluate(() => { window.__t0 = 0; for (const k of Object.keys(window.__count)) window.__count[k] = 0; window.__count.bubbleAfterMs = -1; });
  const read = () => page.evaluate(() => ({ ...window.__count }));
  const lastOutRow = () => [...fake._tables.messages].filter((m) => m.direction === 'out' && m.wa_id === A).filter((m) => m.id < 900).sort((a, b) => b.id - a.id)[0];
  const statuses = async () => {
    const row = lastOutRow();
    for (const s of ['sent', 'delivered', 'read']) {
      await ingestWebhook(statusHook(row.wa_message_id, s), fake);
      row.updated_at = new Date().toISOString();
      live.publish('messages');
      await page.waitForTimeout(450);
    }
  };
  const results = [];
  const run = async (name, act) => {
    await reset();
    const before = await page.evaluate(() => document.querySelectorAll('#messages .bubble').length);
    const savedBefore = fake._tables.messages.filter((m) => m.id < 900 && m.wa_message_id).length;
    const t0 = Date.now();
    await act();
    await page.waitForFunction((n) => document.querySelectorAll('#messages .bubble').length > n, before, { timeout: 5000 });
    const shownMs = Date.now() - t0;
    for (let i = 0; i < 100 && fake._tables.messages.filter((m) => m.id < 900 && m.wa_message_id).length === savedBefore; i++) await page.waitForTimeout(100);
    await page.waitForTimeout(600);
    await statuses();
    await page.waitForTimeout(600);
    const c = await read();
    const ticks = await page.evaluate(() => { const b = [...document.querySelectorAll('#messages .bubble.out')].pop(); return b && b.querySelector('.tick') ? b.querySelector('.tick').className + ' ' + b.querySelector('.tick').textContent : ''; });
    const bubblesNow = await page.evaluate(() => document.querySelectorAll('#messages .bubble').length);
    results.push({ name, shownMs, ...c, extraBubbles: bubblesNow - before - 1, lastTick: ticks });
  };

  await run('text', async () => {
    await page.fill('#composer-input', 'hello from the smooth check');
    await page.evaluate(() => { window.__t0 = performance.now(); document.querySelector('#send-btn').click(); });
  });
  await run('photo', async () => {
    await page.evaluate(() => { window.__t0 = performance.now(); });
    await page.setInputFiles('#file-input', { name: 'dot.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForTimeout(300);
    if (await page.isVisible('#send-btn')) await page.click('#send-btn');
  });
  await run('voice', async () => {
    await page.click('#mic-btn');
    await page.waitForTimeout(900);
    await page.evaluate(() => { window.__t0 = performance.now(); document.querySelector('#rec-send').click(); });
  });

  if (shots) await page.screenshot({ path: `${shots}-chat.png` });
  console.log(JSON.stringify(results, null, 1));
  let failed = 0;
  for (const r of results) {
    const ok = r.bubblesRemoved === 0 && r.bubblesAdded === 1 && r.mediaMade <= 1 && r.chipsRedrawn === 0 && r.rowsRedrawn <= 1 && r.extraBubbles === 0 && /read/.test(r.lastTick);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.name}: drawn once, kept through the send and every tick, ${r.bubbleAfterMs} ms to the bubble`);
  }
  console.log(`${results.length - failed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
  await ctx.close();
  await browser.close();
  srv.close();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
