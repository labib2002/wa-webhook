/* =============================================================================
   Responsive proof: drive a headless Chromium over the real dashboard
   (backed by an in-memory seeded DB) and save PNGs at desktop + mobile widths.
   Run: npm run shots   →   screenshots/*.png
   ============================================================================= */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { makeFakeDb } = require('./fake-db');

// env so the gate + app are operational
process.env.VERIFY_TOKEN = 'vibecode123';
process.env.SESSION_SECRET = 'demo_session_secret_0123456789';
process.env.DASHBOARD_PASSCODE = 'demo';
process.env.NODE_ENV = 'test';

const db = require('../lib/db');
const fake = makeFakeDb();
db.__setDbForTesting(fake);

// ---- seed a realistic inbox ----
function iso(minAgo) { return new Date(Date.now() - minAgo * 60000).toISOString(); }
function seed() {
  const convs = [
    { wa_id: '201001234567', profile_name: 'Ada Lovelace',  last_message_text: 'Perfect, thank you! 🙏',          last_message_at: iso(2),    last_message_direction: 'in',  unread_count: 2 },
    { wa_id: '447700900123', profile_name: 'Marcus Chen',    last_message_text: '📷 Image · here is the receipt',  last_message_at: iso(18),   last_message_direction: 'in',  unread_count: 1 },
    { wa_id: '5511998877665',profile_name: 'Sofia Almeida',  last_message_text: 'Sounds good — talk tomorrow',     last_message_at: iso(95),   last_message_direction: 'out', unread_count: 0 },
    { wa_id: '919812345678', profile_name: null,             last_message_text: '📍 Location',                     last_message_at: iso(1450), last_message_direction: 'in',  unread_count: 0 },
    { wa_id: '14155552671',  profile_name: 'Jordan Patel',   last_message_text: 'Could you resend the invoice?',    last_message_at: iso(3000), last_message_direction: 'in',  unread_count: 0 },
  ];
  convs.forEach((c) => fake._tables.conversations.push({ phone_number_id: 'PNID', created_at: iso(9999), ...c }));

  const T = '201001234567';
  const msgs = [
    { wa_message_id: 'm1', wa_id: T, direction: 'in',  type: 'text', body: 'Hi! I wanted to ask about my order #4471.', status: 'received', wa_timestamp: iso(40), created_at: iso(40) },
    { wa_message_id: 'm2', wa_id: T, direction: 'out', type: 'text', body: 'Hello Ada! Of course — let me pull that up for you.', status: 'read', wa_timestamp: iso(38), created_at: iso(38) },
    { wa_message_id: 'm3', wa_id: T, direction: 'out', type: 'text', body: 'Your order shipped this morning and should arrive Thursday. 📦', status: 'read', reaction: '❤️', wa_timestamp: iso(37), created_at: iso(37) },
    { wa_message_id: 'm4', wa_id: T, direction: 'in',  type: 'text', body: 'Oh wonderful! Is there a tracking number?', status: 'received', wa_timestamp: iso(6), created_at: iso(6) },
    { wa_message_id: 'm5', wa_id: T, direction: 'out', type: 'text', body: 'Yes — it’s 1Z-998-ADA-2026. You’ll get email updates too.', status: 'delivered', wa_timestamp: iso(4), created_at: iso(4) },
    { wa_message_id: 'm6', wa_id: T, direction: 'in',  type: 'image', body: '📷 Image', media_status: 'stored', media_path: 'x/image/m6.png', media_meta: { caption: 'My delivery just arrived 🎉' }, status: 'received', wa_timestamp: iso(3), created_at: iso(3) },
    { wa_message_id: 'm7', wa_id: T, direction: 'in',  type: 'document', body: '📄 Document', media_status: 'stored', media_path: 'x/document/m7.pdf', media_meta: { filename: 'warranty-card.pdf' }, status: 'received', wa_timestamp: iso(2.5), created_at: iso(2.5) },
    { wa_message_id: 'm7b', wa_id: T, direction: 'in', type: 'audio', body: '🎤 Voice message', media_status: 'stored', media_path: 'x/out/m7b.ogg', media_meta: { voice: true, mime_type: 'audio/ogg' }, status: 'received', wa_timestamp: iso(2.3), created_at: iso(2.3) },
    { wa_message_id: 'm7c', wa_id: T, direction: 'in', type: 'text', body: 'Wait, ignore that last bit 😅', status: 'received', deleted: true, deleted_by: 'customer', wa_timestamp: iso(2.2), created_at: iso(2.2) },
    { wa_message_id: 'm7d', wa_id: T, direction: 'out', type: 'text', body: null, status: 'read', deleted: true, deleted_by: 'agent', wa_timestamp: iso(2.15), created_at: iso(2.15) },
    { wa_message_id: 'm8', wa_id: T, direction: 'in',  type: 'text', body: 'Perfect, thank you! 🙏', status: 'received', wa_timestamp: iso(2), created_at: iso(2) },
  ];
  msgs.forEach((m, i) => fake._tables.messages.push({ id: i + 1, media_meta: null, error: null, ...m }));
}
seed();

(async () => {
  const app = require('../api/index');

  // Harness-only: the media route 302-redirects to this local sample so image
  // bubbles render in the screenshot without any live storage call.
  const sampleSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="260">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#bfe6d6"/><stop offset="1" stop-color="#8fd0ba"/></linearGradient></defs>
    <rect width="360" height="260" fill="url(#g)"/>
    <rect x="56" y="150" width="248" height="78" rx="10" fill="#a9744f"/>
    <rect x="56" y="150" width="248" height="20" fill="#8a5d3f"/>
    <path d="M56 150 L180 96 L304 150 Z" fill="#c98a5e"/>
    <rect x="168" y="150" width="24" height="78" fill="#7c5236" opacity="0.5"/>
    <circle cx="300" cy="56" r="26" fill="#fff" opacity="0.85"/>
    <text x="300" y="63" font-size="26" text-anchor="middle">🎉</text>
  </svg>`;
  app.get('/_sample.svg', (_req, res) => {
    res.set('Content-Type', 'image/svg+xml').send(sampleSvg);
  });

  const srv = http.createServer(app).listen(0);
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}/app`;

  const outDir = path.join(__dirname, '..', 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();

  async function shot(name, width, height, after) {
    const ctx = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'networkidle' });
    // log in
    await page.fill('#passcode', 'demo');
    await page.click('#login-btn');
    // wait until the login screen is gone and the app + rows are visible
    await page.waitForSelector('#login-screen', { state: 'hidden', timeout: 5000 });
    await page.waitForSelector('.conv-row', { state: 'visible', timeout: 5000 });
    if (after) await after(page);
    await page.waitForTimeout(650); // let the reveal + bubble animations settle
    const file = path.join(outDir, name);
    await page.screenshot({ path: file });
    console.log('  saved', path.relative(process.cwd(), file));
    await ctx.close();
  }

  console.log('\nCapturing screenshots…');
  // Desktop: both panes; open the top conversation to show the thread.
  await shot('desktop-list.png', 1280, 832, null);
  await shot('desktop-thread.png', 1280, 832, async (p) => {
    await p.click('.conv-row');
    await p.waitForSelector('.bubble');
  });
  // Mobile: list view, then the open thread (single-pane + back arrow).
  await shot('mobile-list.png', 390, 780, null);
  await shot('mobile-thread.png', 390, 780, async (p) => {
    await p.click('.conv-row');
    await p.waitForSelector('.bubble');
  });

  await browser.close();
  srv.close();
  console.log('\nDone. Open the screenshots/ folder to view.\n');
})().catch((e) => { console.error(e); process.exit(1); });
