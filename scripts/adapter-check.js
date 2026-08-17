/* =============================================================================
   Conformance check for the pg adapter in lib/db.js, against a REAL Postgres.
   The fake DB in scripts/fake-db.js can only prove the call sites are shaped
   right; this proves the SQL they compile to actually behaves the same way.

   Run:  DATABASE_URL=postgres://... node scripts/adapter-check.js
   Point it at a SCRATCH database. It writes and deletes rows.
   ============================================================================= */

require('dotenv').config();
const db = require('../lib/db');

let failed = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m✗ ${m}\x1b[0m`); failed++; };
const eq = (got, want, m) => (JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(`${m} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const WA = '999000111222';
const WA2 = '999000111333';

(async () => {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
  const c = db.getDb();

  try {
    await c.from('messages').delete().in('wa_id', [WA, WA2]);
    await c.from('conversations').delete().in('wa_id', [WA, WA2]);

    console.log('\nUPSERT COLUMN SET (the single highest-risk line in the port)');
    await c.from('conversations').upsert(
      { wa_id: WA, profile_name: 'Original Name', phone_number_id: 'PNID1', last_message_text: 'first' },
      { onConflict: 'wa_id' },
    );
    // ingest.js deliberately omits profile_name when the webhook carries none.
    // A fixed column list would null it out across the whole inbox.
    await c.from('conversations').upsert(
      { wa_id: WA, last_message_text: 'second', last_message_direction: 'in' },
      { onConflict: 'wa_id' },
    );
    let r = await c.from('conversations').select('*').eq('wa_id', WA).maybeSingle();
    eq(r.data.profile_name, 'Original Name', 'a partial upsert does NOT null profile_name');
    eq(r.data.phone_number_id, 'PNID1', 'a partial upsert does NOT null phone_number_id');
    eq(r.data.last_message_text, 'second', 'a partial upsert DOES update the keys it carries');

    // templateSend.js upserts only { wa_id }.
    await c.from('conversations').upsert({ wa_id: WA }, { onConflict: 'wa_id' });
    r = await c.from('conversations').select('profile_name').eq('wa_id', WA).maybeSingle();
    eq(r.data.profile_name, 'Original Name', 'a wa_id-only upsert preserves every other column');

    console.log('\nATOMIC INCREMENT');
    eq((await c.from('conversations').select('unread_count').eq('wa_id', WA).maybeSingle()).data.unread_count, 0, 'unread starts at 0');
    await c.from('conversations').upsert({ wa_id: WA }, { onConflict: 'wa_id', increment: { unread_count: 1 } });
    await c.from('conversations').upsert({ wa_id: WA }, { onConflict: 'wa_id', increment: { unread_count: 1 } });
    eq((await c.from('conversations').select('unread_count').eq('wa_id', WA).maybeSingle()).data.unread_count, 2, 'two bumps give 2');
    await c.from('conversations').upsert({ wa_id: WA2 }, { onConflict: 'wa_id', increment: { unread_count: 1 } });
    eq((await c.from('conversations').select('unread_count').eq('wa_id', WA2).maybeSingle()).data.unread_count, 1, 'a bump that inserts starts at 1');

    console.log('\nIDEMPOTENT UPSERT + NOVELTY DETECTION');
    const wamid = `wamid.ADAPTER_${Date.now()}`;
    const row = { wa_message_id: wamid, wa_id: WA, direction: 'in', type: 'text', body: 'hello', status: 'received' };
    let ins = await c.from('messages').upsert(row, { onConflict: 'wa_message_id', ignoreDuplicates: true }).select();
    eq(ins.data.length, 1, 'first delivery RETURNS the inserted row');
    ins = await c.from('messages').upsert(row, { onConflict: 'wa_message_id', ignoreDuplicates: true }).select();
    eq(ins.data.length, 0, 'a replay RETURNS nothing, so unread is not bumped again');
    const cnt = await c.from('messages').select('id', { count: 'exact', head: true }).eq('wa_message_id', wamid);
    eq(cnt.count, 1, 'still exactly one row after the replay');

    console.log('\nERROR CODE PROPAGATION (dedupe depends on this)');
    const key = `adapter-${Date.now()}`;
    const first = await c.from('messages').insert({ wa_id: WA, direction: 'out', type: 'text', client_key: key, status: 'pending' }).select().single();
    eq(Boolean(first.data && first.data.id), true, 'reservation insert returns the row');
    const dupe = await c.from('messages').insert({ wa_id: WA, direction: 'out', type: 'text', client_key: key, status: 'pending' }).select().single();
    eq(dupe.error && dupe.error.code, '23505', 'a duplicate client_key surfaces SQLSTATE 23505 verbatim');
    eq(dupe.data, null, 'and returns no data');

    console.log('\nLAZY UPDATE (markSent / markFailed return the builder unawaited)');
    const lazy = c.from('messages').update({ status: 'sent', error: null }).eq('id', first.data.id);
    const settled = await lazy.select().single();
    eq(settled.data.status, 'sent', '.update().eq() chained into .select().single() returns the row');
    const bare = await c.from('messages').update({ status: 'delivered' }).eq('id', first.data.id);
    eq([bare.data, bare.error], [null, null], 'a bare awaited update returns { data: null, error: null }');

    console.log('\nTRIGGER');
    const before = (await c.from('messages').select('updated_at').eq('id', first.data.id).maybeSingle()).data.updated_at;
    await new Promise((res) => setTimeout(res, 25));
    await c.from('messages').update({ reaction: '👍' }).eq('id', first.data.id);
    const after = (await c.from('messages').select('updated_at').eq('id', first.data.id).maybeSingle()).data.updated_at;
    (new Date(after) > new Date(before)) ? ok('messages_set_updated_at bumps updated_at on UPDATE') : bad('updated_at did NOT move: reactions and delivery ticks would never poll through');

    console.log('\nSINGLE vs MAYBESINGLE');
    const none = await c.from('messages').select('*').eq('wa_id', 'nobody').maybeSingle();
    eq([none.data, none.error], [null, null], 'maybeSingle on zero rows is { null, null }');
    const strict = await c.from('messages').select('*').eq('wa_id', 'nobody').single();
    eq(Boolean(strict.error), true, 'single on zero rows is an error');

    console.log('\nFILTERS AND ORDERING');
    await c.from('messages').insert([
      { wa_id: WA, direction: 'in', type: 'image', media_path: 'a/b.jpg', media_status: 'stored' },
      { wa_id: WA, direction: 'in', type: 'image', media_status: 'pending' },
    ]);
    const notNull = await c.from('messages').select('id').eq('wa_id', WA).not('media_path', 'is', null);
    eq(notNull.data.length, 1, ".not(col,'is',null) selects only non-null media_path");
    const inList = await c.from('messages').select('id').eq('wa_id', WA).in('media_status', ['pending', 'failed']);
    eq(inList.data.length, 1, '.in() matches a value list');
    const emptyIn = await c.from('messages').select('id').in('id', []);
    eq(emptyIn.data.length, 0, '.in([]) matches nothing rather than erroring');

    await c.from('conversations').upsert({ wa_id: WA2, last_message_at: null }, { onConflict: 'wa_id' });
    const ordered = await c.from('conversations').select('wa_id').in('wa_id', [WA, WA2])
      .order('last_message_at', { ascending: false, nullsFirst: false }).limit(10);
    eq(ordered.data[ordered.data.length - 1].wa_id, WA2, 'nullsFirst:false puts NULL last_message_at at the end');

    console.log('\nCOUNT / DELETE');
    const total = await c.from('messages').select('id', { count: 'exact', head: true }).eq('wa_id', WA);
    eq(typeof total.count, 'number', "count:'exact', head:true returns a number and no data");
    const del = await c.from('messages').delete().eq('wa_id', WA).eq('type', 'image');
    eq(del.error, null, 'delete with two eq filters runs clean');
    eq((await c.from('messages').select('id').eq('wa_id', WA).eq('type', 'image')).data.length, 0, 'and removed the rows');

    console.log('\nBOOT PROBE');
    const boot = require('../lib/boot');
    try { await boot.probeDatabase(); ok('RLS behaviour probe passes and rolls back'); }
    catch (e) { bad(`RLS probe failed: ${e.message}`); }
    const leftover = await c.from('conversations').select('wa_id').eq('wa_id', '__healthcheck__').maybeSingle();
    eq(leftover.data, null, 'the probe left no rows behind');

    await c.from('messages').delete().in('wa_id', [WA, WA2]);
    await c.from('conversations').delete().in('wa_id', [WA, WA2]);
    ok('cleaned up');
  } catch (e) {
    bad(`threw: ${e.stack}`);
  } finally {
    await db.close();
    console.log(failed ? `\n\x1b[31m${failed} check(s) failed\x1b[0m\n` : '\n\x1b[32mAll adapter checks passed\x1b[0m\n');
    process.exit(failed ? 1 : 0);
  }
})();
