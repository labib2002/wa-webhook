// Boot-time assertions. Anything that fails here refuses to start the process
// rather than degrading silently, because every one of these failures is
// invisible at runtime.

const db = require('./db');

function assertEnv() {
  const prod = process.env.NODE_ENV === 'production';
  const problems = [];

  // lib/signature.js returns 'skipped' when APP_SECRET is empty and the webhook
  // then ACCEPTS the request. It is the only env var whose absence fails open.
  if (prod && !process.env.APP_SECRET) {
    problems.push('APP_SECRET is unset: webhook signature verification would fail OPEN');
  }

  // Vercel injected NODE_ENV; PM2 does not. lib/auth.js gates the Secure cookie
  // flag on it, so a missing NODE_ENV ships session cookies over plain HTTP.
  if (process.env.WA_DEPLOY_ENV === 'prod' && !prod) {
    problems.push(`WA_DEPLOY_ENV=prod but NODE_ENV is '${process.env.NODE_ENV || 'unset'}' (must be 'production')`);
  }

  if (prod && !process.env.SESSION_SECRET) problems.push('SESSION_SECRET is unset');
  if (prod && !process.env.DASHBOARD_PASSCODE) problems.push('DASHBOARD_PASSCODE is unset');

  if (problems.length) {
    for (const p of problems) console.error(`BOOT FAILED: ${p}`);
    throw new Error(`boot assertions failed (${problems.length})`);
  }
}

// The maintenance cron ran in UTC on Vercel; a box crontab inherits the box
// timezone, and this account already pins an AWS Backup plan to Africa/Cairo.
// Log what actually resolved so a skew is visible in the first log line.
function logTimezone() {
  let resolved = 'unknown';
  try {
    resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch { /* ignore */ }
  console.log(`timezone: TZ=${process.env.TZ || 'unset'} resolved=${resolved} now=${new Date().toISOString()}`);
  if (resolved && resolved !== 'UTC' && process.env.TZ !== 'UTC') {
    console.warn(`timezone is ${resolved}, not UTC. The crontab entry must set CRON_TZ=UTC.`);
  }
}

// RLS with zero policies does not error. It makes SELECT return 0 rows with a
// null error, and makes UPDATE match 0 rows and report success. Both are
// invisible: the inbox just goes empty and delivery ticks stop moving. So the
// probe checks BEHAVIOUR as the app's own role, not pg_class flags, and it runs
// inside a transaction that is always rolled back.
const PROBE_WA_ID = '__healthcheck__';

async function probeDatabase() {
  return db.withClient(async (c) => {
    try {
      await c.query('BEGIN');
      const schema = db.SCHEMA();
      const conv = `"${schema}"."conversations"`;
      const msgs = `"${schema}"."messages"`;

      await c.query(`INSERT INTO ${conv} (wa_id) VALUES ($1) ON CONFLICT (wa_id) DO NOTHING`, [PROBE_WA_ID]);
      await c.query(
        `INSERT INTO ${msgs} (wa_id, direction, type, body) VALUES ($1, 'in', 'text', 'probe')`,
        [PROBE_WA_ID],
      );

      const seen = await c.query(`SELECT count(*)::int AS n FROM ${msgs} WHERE wa_id = $1`, [PROBE_WA_ID]);
      if (seen.rows[0].n !== 1) {
        throw new Error(`inserted 1 row but SELECT sees ${seen.rows[0].n}: RLS is filtering reads silently`);
      }

      const upd = await c.query(`UPDATE ${msgs} SET status = 'received' WHERE wa_id = $1`, [PROBE_WA_ID]);
      if (upd.rowCount !== 1) {
        throw new Error(`UPDATE matched ${upd.rowCount} rows, expected 1: RLS is filtering writes silently`);
      }

      return true;
    } finally {
      await c.query('ROLLBACK').catch(() => {});
    }
  });
}

async function run() {
  assertEnv();
  logTimezone();
  if (db.isConfigured()) {
    await probeDatabase();
    console.log('db probe ok: reads and writes both visible to the app role');
  } else {
    console.warn('DATABASE_URL is unset; skipping the db probe.');
  }
}

module.exports = { run, assertEnv, probeDatabase, logTimezone };
