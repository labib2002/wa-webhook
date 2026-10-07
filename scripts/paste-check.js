// Drives the inbox in headless Chromium (in-memory DB, Meta creds blanked, sends
// intercepted) and checks paste, drag-drop and the clip button. npm run paste-check
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
[
  { wa_message_id: 'm1', wa_id: A, direction: 'in', type: 'text', body: 'hi', status: 'received', wa_timestamp: iso(5), created_at: iso(5) },
  { wa_message_id: 'm2', wa_id: A, direction: 'in', type: 'image', body: '📷 Image', media_status: 'stored', media_path: 'x/image/m2.png', media_meta: {}, status: 'received', wa_timestamp: iso(3), created_at: iso(3) },
  { wa_message_id: 'm3', wa_id: B, direction: 'in', type: 'text', body: 'yo', status: 'received', wa_timestamp: iso(18), created_at: iso(18) },
].forEach((m, i) => fake._tables.messages.push({ id: i + 1, media_meta: null, error: null, forwarded: false, ...m }));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

(async () => {
  const app = require('../api/index');
  app.get('/_sample.svg', (_req, res) => res.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#8fd0ba"/></svg>'));
  const srv = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const sent = [];
  await page.route('**/api/send-media', async (route) => {
    const body = JSON.parse(route.request().postData());
    sent.push(body);
    const now = new Date().toISOString();
    await route.fulfill({ json: { message: {
      id: 1000 + sent.length, wa_id: body.wa_id, direction: 'out', type: 'document', body: '📄 Document',
      media_status: null, media_meta: { filename: body.filename, mime_type: body.mime, caption: body.caption || null },
      status: 'sent', wa_timestamp: now, created_at: now, updated_at: now,
    } } });
  });
  await page.route('**/api/mark-read', (route) => route.fulfill({ json: { ok: true } }));

  await page.goto(base + '/app');
  await page.fill('#passcode', 'demo');
  await page.click('#login-btn');
  await page.waitForSelector('.conv-row');
  await page.click(`.conv-row >> text=Ada Lovelace`);
  await page.waitForSelector('.bubble');

  await page.evaluate(() => {
    window.__t = {
      async png(w, h, noisy) {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const x = c.getContext('2d');
        if (noisy) {
          const img = x.createImageData(w, h);
          for (let i = 0; i < img.data.length; i++) img.data[i] = (Math.random() * 256) | 0;
          x.putImageData(img, 0, 0);
        } else {
          x.fillStyle = '#c33'; x.fillRect(0, 0, w, h);
          x.fillStyle = '#fff'; x.font = '24px sans-serif'; x.fillText('cropped', 20, 40);
        }
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        return new File([blob], 'image.png', { type: 'image/png' });
      },
      async webp() {
        const c = document.createElement('canvas'); c.width = 300; c.height = 200;
        const x = c.getContext('2d'); x.fillStyle = '#36c'; x.fillRect(0, 0, 300, 200);
        const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.8));
        return new File([blob], 'pic.webp', { type: blob.type });
      },
      pdf() { return new File(['%PDF-1.4 fake'], 'invoice.pdf', { type: 'application/pdf' }); },
      paste(target, files, strings = {}) {
        const dt = new DataTransfer();
        files.forEach((f) => dt.items.add(f));
        Object.entries(strings).forEach(([k, v]) => dt.setData(k, v));
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        target.dispatchEvent(ev);
        return ev.defaultPrevented;
      },
      drag(type, target, files) {
        const dt = new DataTransfer();
        files.forEach((f) => dt.items.add(f));
        let effect = 'unset';
        Object.defineProperty(dt, 'dropEffect', { get: () => effect, set: (v) => { effect = v; } });
        const ev = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true });
        target.dispatchEvent(ev);
        return { prevented: ev.defaultPrevented, effect };
      },
      staged() {
        const p = document.querySelector('#attach-preview');
        if (p.hidden) return null;
        const img = document.querySelector('#attach-thumb-img');
        return {
          name: document.querySelector('#attach-name').textContent,
          size: document.querySelector('#attach-size').textContent,
          thumb: img.hidden ? null : (img.getAttribute('src') || '').split(',')[0],
          ico: document.querySelector('#attach-thumb-ico').textContent,
        };
      },
      clear() { if (!document.querySelector('#attach-preview').hidden) document.querySelector('#attach-remove').click(); },
    };
  });

  const staged = () => page.evaluate(() => __t.staged());
  const settle = (ms = 400) => page.waitForTimeout(ms);
  const clear = () => page.evaluate(() => __t.clear());

  let prevented = await page.evaluate(async () => __t.paste(document.querySelector('#composer-input'), [await __t.png(320, 200)]));
  await settle();
  let s = await staged();
  check('paste PNG into composer stages it', prevented && s && s.name === 'image.png' && s.thumb === 'data:image/png;base64', JSON.stringify({ prevented, s }));

  await page.fill('#composer-input', 'here is the crop');
  await page.press('#composer-input', 'Enter');
  await settle(600);
  const last = sent[sent.length - 1];
  const bytes = last ? Buffer.from(last.file_base64, 'base64') : Buffer.alloc(0);
  check('Enter sends pasted image with caption', !!last && last.mime === 'image/png' && last.filename === 'image.png'
    && last.caption === 'here is the crop' && bytes.slice(1, 4).toString() === 'PNG' && last.wa_id === A,
    last ? `mime=${last.mime} bytes=${bytes.length} caption=${last.caption}` : 'nothing sent');
  check('composer resets after send', (await staged()) === null && (await page.inputValue('#composer-input')) === '');

  await page.evaluate(async () => {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': await __t.png(400, 260) })]);
  });
  await page.focus('#composer-input');
  await page.keyboard.press('Control+V');
  await settle();
  s = await staged();
  check('real Ctrl+V of a clipboard image stages it', !!s && s.thumb === 'data:image/png;base64', JSON.stringify(s));
  await clear();

  await page.evaluate(() => navigator.clipboard.writeText('hello paste'));
  await page.fill('#composer-input', '');
  await page.focus('#composer-input');
  await page.keyboard.press('Control+V');
  await settle(200);
  check('real Ctrl+V of text pastes text, no attachment', (await page.inputValue('#composer-input')) === 'hello paste' && (await staged()) === null);
  await page.fill('#composer-input', '');

  prevented = await page.evaluate(async () => __t.paste(document.querySelector('#composer-input'), [await __t.png(200, 100)],
    { 'text/plain': 'Name\tPhone\nAda\t0100', 'text/html': '<table><tr><td>Ada</td></tr></table>', 'text/rtf': '{\\rtf1 Ada}' }));
  await settle();
  check('Office copy pastes as text, not image', !prevented && (await staged()) === null);

  prevented = await page.evaluate(async () => __t.paste(document.querySelector('#composer-input'), [await __t.png(200, 100)],
    { 'text/plain': ' ', 'text/rtf': '{\\rtf1 {\\pict}}' }));
  await settle();
  check('Word picture-only copy stages the image', prevented && !!(await staged()));
  await clear();

  prevented = await page.evaluate(async () => __t.paste(document.querySelector('#composer-input'), [await __t.png(200, 100)],
    { 'text/plain': 'https://example.com/a.png', 'text/html': '<img src="https://example.com/a.png">' }));
  await settle();
  check('browser Copy Image (URL text + picture) stages the image', prevented && !!(await staged()));
  await clear();

  prevented = await page.evaluate(async () => __t.paste(document.querySelector('#messages'), [await __t.png(200, 100)]));
  await settle();
  check('paste with focus on the thread stages it', prevented && !!(await staged()));
  await clear();

  prevented = await page.evaluate(async () => __t.paste(document.querySelector('#search'), [await __t.png(200, 100)]));
  await settle();
  check('paste into the search box is left alone', !prevented && (await staged()) === null);

  await page.click('#rename-btn');
  await page.waitForSelector('#rename-modal:not([hidden])');
  prevented = await page.evaluate(async () => __t.paste(document.body, [await __t.png(200, 100)]));
  await settle();
  check('paste while a modal is open is ignored', !prevented && (await staged()) === null);
  await page.keyboard.press('Escape');

  await page.click('.bubble [data-view]');
  await page.waitForSelector('#viewer:not([hidden])');
  prevented = await page.evaluate(async () => __t.paste(document.body, [await __t.png(200, 100)]));
  await settle();
  check('paste while the media viewer is open is ignored', !prevented && (await staged()) === null);
  await page.keyboard.press('Escape');

  prevented = await page.evaluate(async () => __t.paste(document.querySelector('#composer-input'), [__t.pdf(), await __t.png(200, 100)]));
  await settle();
  s = await staged();
  const toastText = await page.textContent('#toast');
  check('two files: first staged, toast shown', prevented && s && s.name === 'invoice.pdf' && s.ico === '📄' && /One file at a time/.test(toastText), JSON.stringify({ s, toastText }));
  await clear();

  await page.evaluate(async () => __t.paste(document.querySelector('#composer-input'), [await __t.webp()]));
  await settle(800);
  s = await staged();
  check('WebP is re-encoded as JPEG', !!s && s.name === 'pic.jpg' && s.thumb === 'data:image/jpeg;base64', JSON.stringify(s));
  await clear();

  const bigSize = await page.evaluate(async () => {
    const f = await __t.png(2400, 2400, true);
    window.__big = f;
    return f.size;
  });
  await page.evaluate(() => __t.paste(document.querySelector('#composer-input'), [window.__big]));
  await page.waitForFunction(() => !document.querySelector('#attach-preview').hidden, null, { timeout: 20000 }).catch(() => {});
  await page.press('#composer-input', 'Enter');
  await settle(800);
  const big = sent[sent.length - 1];
  const bigBytes = big ? Buffer.from(big.file_base64, 'base64') : Buffer.alloc(0);
  check(`oversized PNG (${(bigSize / 1048576).toFixed(1)} MB) goes out as JPEG <= 5 MB`,
    !!big && big.mime === 'image/jpeg' && big.filename === 'image.jpg' && bigBytes.length <= 5e6 && bigBytes[0] === 0xff && bigBytes[1] === 0xd8,
    big ? `mime=${big.mime} bytes=${bigBytes.length}` : 'nothing sent');

  let r = await page.evaluate(async () => __t.drag('dragover', document.querySelector('#messages'), [await __t.png(50, 50)]));
  check('dragover on the thread allows a copy drop', r.prevented && r.effect === 'copy', JSON.stringify(r));
  r = await page.evaluate(async () => __t.drag('dragover', document.querySelector('#conv-list'), [await __t.png(50, 50)]));
  check('dragover on the chat list refuses the drop', r.prevented && r.effect === 'none', JSON.stringify(r));
  r = await page.evaluate(async () => __t.drag('drop', document.querySelector('#conv-list'), [await __t.png(50, 50)]));
  await settle();
  check('drop on the chat list is swallowed, nothing staged', r.prevented && (await staged()) === null, JSON.stringify(r));
  r = await page.evaluate(async () => __t.drag('drop', document.querySelector('#messages'), [await __t.png(50, 50)]));
  await settle();
  check('drop on the thread stages the file', r.prevented && !!(await staged()), JSON.stringify(r));
  await clear();

  await page.setInputFiles('#file-input', { name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 x') });
  await settle();
  s = await staged();
  check('clip-button picker still stages files', !!s && s.name === 'report.pdf' && s.ico === '📄', JSON.stringify(s));
  await clear();

  await page.evaluate(() => __t.paste(document.querySelector('#composer-input'), [window.__big]));
  await page.click(`.conv-row >> text=Marcus Chen`);
  await settle(4000);
  check('file staged in one chat never lands in another', (await staged()) === null);

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  srv.close();
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
