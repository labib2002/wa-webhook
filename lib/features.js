// What this database has beyond the first ten migrations. Migration 011 adds
// the pieces below; until it has run the inbox works as it did before, and
// each feature switches itself on within five minutes of the migration.

const db = require('./db');
const { makeWarner } = require('./warn');

const PIECES = {
  agent: ['messages', 'agent'],            // who sent each outgoing message
  done: ['conversations', 'done_at'],      // "needs reply" until answered or marked done
  replies: ['saved_replies', 'id'],        // shared saved replies
  passMark: ['push_subscriptions', 'pass_mark'], // devices signed up under the current passcode
};
const RECHECK_MS = 5 * 60 * 1000;
const warnProbe = makeWarner('feature probe failed, the newer inbox features stay off');

let known = null;
let checkedAt = 0;
let forced = null;

const everything = (on) => Object.fromEntries(Object.keys(PIECES).map((k) => [k, on]));

async function load() {
  if (forced) return forced;
  if (db.isInjected()) return everything(true);
  const complete = known && Object.values(known).every(Boolean);
  if (known && (complete || Date.now() - checkedAt < RECHECK_MS)) return known;
  try {
    const tables = [...new Set(Object.values(PIECES).map(([t]) => t))];
    const { rows } = await db.raw(
      'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2)',
      [db.SCHEMA(), tables],
    );
    const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    known = Object.fromEntries(Object.entries(PIECES).map(([k, [t, c]]) => [k, have.has(`${t}.${c}`)]));
  } catch (e) {
    warnProbe(e);
    known = known || everything(false);
  }
  checkedAt = Date.now();
  return known;
}

function __setForTesting(value) {
  forced = value ? { ...everything(true), ...value } : null;
  known = null;
}

module.exports = { load, __setForTesting };
