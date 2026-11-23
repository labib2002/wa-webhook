// One-off: store the pixel size of photos, stickers and videos received or
// sent before the inbox kept it (media_meta.w / media_meta.h). Adds those two
// keys and nothing else; a row it cannot read is left as it is.
//   node -r dotenv/config scripts/backfill-media-size.js          (writes)
//   node -r dotenv/config scripts/backfill-media-size.js --dry    (counts only)
const db = require('../lib/db');
const media = require('../lib/media');
const dims = require('../lib/dims');

const DRY = process.argv.includes('--dry');
const WANTED = `type IN ('image', 'sticker', 'video') AND media_status = 'stored' AND media_path IS NOT NULL
  AND (media_meta IS NULL OR media_meta->>'w' IS NULL)`;

async function count() {
  const { rows } = await db.raw(`SELECT type, count(*)::int AS n FROM messages WHERE ${WANTED} GROUP BY type ORDER BY type`);
  return rows;
}

async function sizeOf(row) {
  const dl = await db.getDb().storage.from(media.BUCKET()).download(row.media_path);
  if (dl.error || !dl.data) return null;
  const bytes = Buffer.from(await dl.data.arrayBuffer());
  const mime = (row.media_meta && row.media_meta.mime_type) || (row.type === 'video' ? 'video/mp4' : 'image/jpeg');
  return dims.mediaSize(bytes, row.type === 'sticker' ? 'image/webp' : mime, media.extFromName(row.media_path));
}

(async () => {
  console.log('without a size, before:', JSON.stringify(await count()));
  if (DRY) return db.close();
  const done = { sized: 0, unreadable: 0 };
  let after = 0;
  for (;;) {
    const { rows } = await db.raw(
      `SELECT id, type, media_path, media_meta FROM messages WHERE ${WANTED} AND id > $1 ORDER BY id LIMIT 40`, [after],
    );
    if (!rows.length) break;
    after = rows[rows.length - 1].id;
    await Promise.all(rows.map(async (row) => {
      const size = await sizeOf(row).catch(() => null);
      if (!size) { done.unreadable++; return; }
      await db.raw(
        `UPDATE messages SET media_meta = coalesce(media_meta, '{}'::jsonb) || jsonb_build_object('w', $1::int, 'h', $2::int) WHERE id = $3`,
        [size.w, size.h, row.id],
      );
      done.sized++;
    }));
  }
  console.log('done:', JSON.stringify(done));
  console.log('without a size, after:', JSON.stringify(await count()));
  await db.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
