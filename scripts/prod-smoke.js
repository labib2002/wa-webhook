// Browser smoke test against the LIVE production dashboard.
// Seeds one conversation in the live DB, logs in through the real UI, captures
// a screenshot, then removes the seeded row. Throwaway verification tool.
require('dotenv').config();
const path = require('path');
const { chromium } = require('playwright');
const { getDb } = require('../lib/db');

const URL = 'https://wa-webhook-dun.vercel.app/app';
const PASSCODE = process.env.DASHBOARD_PASSCODE;
const WA = '15551230099';

(async () => {
  const db = getDb();
  // seed
  await db.from('conversations').upsert({
    wa_id: WA, profile_name: 'Production Smoke', last_message_text: 'Live dashboard check ✅',
    last_message_at: new Date().toISOString(), last_message_direction: 'in', unread_count: 1,
  }, { onConflict: 'wa_id' });
  await db.from('messages').upsert({
    wa_message_id: 'wamid.SMOKE1', wa_id: WA, direction: 'in', type: 'text',
    body: 'Live dashboard check ✅', status: 'received', wa_timestamp: new Date().toISOString(),
  }, { onConflict: 'wa_message_id', ignoreDuplicates: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#login-screen', { state: 'visible', timeout: 8000 });
  console.log('login screen shown:', await page.isVisible('#login-screen'));

  await page.fill('#passcode', PASSCODE);
  await page.click('#login-btn');
  await page.waitForSelector('.conv-row', { state: 'visible', timeout: 8000 });
  const rows = await page.$$eval('.conv-row', (els) => els.map((e) => e.querySelector('.row-name')?.textContent));
  console.log('conversations visible after login:', rows);

  // open the thread
  await page.click('.conv-row');
  await page.waitForSelector('.bubble', { timeout: 8000 });
  const bubbles = await page.$$eval('.bubble', (els) => els.map((e) => e.textContent.trim().slice(0, 40)));
  console.log('thread bubbles:', bubbles);

  const out = path.join(__dirname, '..', 'screenshots', 'prod-live.png');
  await page.waitForTimeout(500);
  await page.screenshot({ path: out });
  console.log('screenshot:', out);

  console.log('console errors:', errors.length ? errors : 'none');

  await browser.close();
  // cleanup
  await db.from('conversations').delete().eq('wa_id', WA);
  console.log('cleaned up seeded row.');
})().catch((e) => { console.error('SMOKE FAILED:', e.message); process.exit(1); });
