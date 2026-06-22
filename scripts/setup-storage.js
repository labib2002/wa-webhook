/* =============================================================================
   Create the private Supabase Storage bucket for incoming WhatsApp media.
   Run once:  node scripts/setup-storage.js
   Safe to re-run: if the bucket already exists it just reports that.
   Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.
   ============================================================================= */

require('dotenv').config();
const { getDb } = require('../lib/db');

const BUCKET = process.env.MEDIA_BUCKET || 'wa-media';

(async () => {
  const db = getDb();

  const { data: buckets, error: listErr } = await db.storage.listBuckets();
  if (listErr) {
    console.error('Could not list buckets:', listErr.message);
    process.exit(1);
  }

  if (buckets.some((b) => b.name === BUCKET)) {
    console.log(`✓ Bucket "${BUCKET}" already exists (private).`);
    process.exit(0);
  }

  const { error } = await db.storage.createBucket(BUCKET, {
    public: false, // private — served only via short-lived signed URLs
    fileSizeLimit: 26214400, // 25 MB, matches WhatsApp's media ceiling
  });
  if (error) {
    console.error(`Failed to create bucket "${BUCKET}":`, error.message);
    process.exit(1);
  }
  console.log(`✓ Created private bucket "${BUCKET}".`);
})();
