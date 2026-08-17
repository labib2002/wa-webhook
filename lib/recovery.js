// Re-drive inbound media that never reached the bucket (L7.2).
//
// ingest.js writes the row with media_status='pending' and then fetches the
// bytes inside the same request. If that fetch dies (process restart, Graph
// blip, a SIGKILL mid-download) the row stays 'pending' or flips to 'failed'
// and nothing anywhere ever retries it: retention only touches 'stored', and
// POST /api/retry/:id refuses direction='in'.
//
// media_meta.id is Meta's media id and is preserved on the row, so the bytes
// are recoverable for as long as Meta keeps them, about 30 days.

const media = require('./media');

const WINDOW_DAYS = 30;
const BATCH = 50;

async function recoverStuckMedia(db, opts = {}) {
  const windowDays = opts.windowDays || WINDOW_DAYS;
  const limit = opts.limit || BATCH;
  const cutoffIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: rows, error } = await db
    .from('messages')
    .select('id, wa_id, type, media_meta, media_status')
    .eq('direction', 'in')
    .in('media_status', ['pending', 'failed'])
    .gte('created_at', cutoffIso)
    .limit(limit);
  if (error) throw error;

  const out = { considered: (rows || []).length, recovered: 0, stillFailed: 0, skipped: 0 };
  for (const row of rows || []) {
    const mm = row.media_meta || {};
    if (!mm.id) { out.skipped += 1; continue; }
    try {
      const stored = await media.fetchAndStore(mm.id, row.wa_id, row.type, mm.filename);
      const upd = await db
        .from('messages')
        .update({ media_path: stored.path, media_status: 'stored' })
        .eq('id', row.id);
      if (upd.error) throw upd.error;
      out.recovered += 1;
    } catch (e) {
      out.stillFailed += 1;
      // Meta drops media after ~30 days, so a miss here is expected on old rows
      // and must not abort the batch.
      await db.from('messages').update({ media_status: 'failed' }).eq('id', row.id);
      console.error(`media recovery failed for message ${row.id}:`, e.message);
    }
  }
  return out;
}

module.exports = { recoverStuckMedia };
