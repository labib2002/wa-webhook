// Download incoming WhatsApp media from the Graph API and store it in a private
// Supabase Storage bucket.
//
// WhatsApp media retrieval is two hops:
//   1) GET /<version>/<media-id>            -> JSON with a short-lived `url`
//   2) GET <url>                            -> the raw bytes
// Both hops require the Bearer access token. The step-1 `url` (on
// lookaside.fbsbx.com) is only valid for a few minutes, which is exactly why we
// copy the bytes into our own bucket immediately and serve them via signed URLs.

const { getDb } = require('./db');

const BUCKET = () => process.env.MEDIA_BUCKET || 'wa-media';

// Map a mime type to a sensible file extension for the stored object.
function extFromMime(mime) {
  if (!mime) return 'bin';
  const m = mime.split(';')[0].trim().toLowerCase();
  const table = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'video/3gpp': '3gp',
    'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/amr': 'amr',
    'audio/ogg': 'ogg', 'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/plain': 'txt',
  };
  return table[m] || (m.split('/')[1] || 'bin').replace(/[^a-z0-9]/g, '') || 'bin';
}

// Step 1: resolve a media id to its temporary download URL + mime.
async function resolveMediaUrl(mediaId) {
  const version = process.env.GRAPH_API_VERSION || 'v23.0';
  const resp = await fetch(`https://graph.facebook.com/${version}/${mediaId}`, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`media lookup ${resp.status}: ${t.slice(0, 200)}`);
  }
  return resp.json(); // { url, mime_type, sha256, file_size, id }
}

// Step 2: download the bytes from the temporary URL.
async function downloadBytes(url) {
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      // Meta's media CDN is picky; a UA avoids occasional 403s.
      'User-Agent': 'wa-webhook/1.0 (+https://github.com/labib2002/wa-webhook)',
    },
  });
  if (!resp.ok) {
    throw new Error(`media download ${resp.status}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  return buf;
}

// Full pipeline for one media id. Returns { path, mime, size } or throws.
// `kind` is the message type (image/audio/...) used only to namespace the path.
async function fetchAndStore(mediaId, waId, kind) {
  if (!process.env.WHATSAPP_TOKEN) {
    throw new Error('WHATSAPP_TOKEN not set; cannot download media.');
  }
  const meta = await resolveMediaUrl(mediaId);
  const bytes = await downloadBytes(meta.url);

  const ext = extFromMime(meta.mime_type);
  // Deterministic-ish path: <wa_id>/<kind>/<media_id>.<ext>
  const safeWa = String(waId).replace(/[^0-9]/g, '') || 'unknown';
  const path = `${safeWa}/${kind || 'file'}/${mediaId}.${ext}`;

  const db = getDb();
  const { error } = await db.storage.from(BUCKET()).upload(path, bytes, {
    contentType: meta.mime_type || 'application/octet-stream',
    upsert: true,
  });
  if (error) throw new Error(`storage upload failed: ${error.message}`);

  return { path, mime: meta.mime_type, size: meta.file_size || bytes.length };
}

// Create a short-lived signed URL for a stored object (for the browser).
async function signedUrl(path, expiresSeconds = 600) {
  const db = getDb();
  const { data, error } = await db.storage
    .from(BUCKET())
    .createSignedUrl(path, expiresSeconds);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

module.exports = { fetchAndStore, signedUrl, extFromMime, BUCKET };
