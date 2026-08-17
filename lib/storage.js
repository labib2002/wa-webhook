// S3 object storage, presented with the same surface the app already calls
// (db.storage.from(bucket).upload/download/remove/createSignedUrl), so
// lib/media.js and lib/routes.js keep their existing call sites.
//
// Credentials come from the instance role. Do NOT add a credentials block; the
// static-key pattern in the backend's upload.service.js is not the model here.

const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand, ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let s3 = null;
function client() {
  if (!s3) s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-1' });
  return s3;
}

// Supabase Storage returned { data, error } and never threw. Keep that, or
// every existing `if (error)` branch silently becomes an uncaught throw.
async function wrap(fn) {
  try {
    return { data: await fn(), error: null };
  } catch (error) {
    return { data: null, error };
  }
}

// Egyptian customers send Arabic document filenames. Supabase percent-encoded
// this for us; S3 does not. Without the RFC 5987 form the download name is
// mojibake, and without the ASCII fallback old clients drop it entirely.
function contentDisposition(name) {
  const raw = String(name || '').replace(/[\r\n"]/g, '').trim();
  if (!raw) return undefined;
  const ascii = raw.replace(/[^\x20-\x7E]/g, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

function bucketApi(bucket) {
  return {
    async upload(path, body, opts = {}) {
      return wrap(async () => {
        await client().send(new PutObjectCommand({
          Bucket: bucket,
          Key: path,
          Body: body,
          ContentType: opts.contentType || 'application/octet-stream',
        }));
        return { path };
      });
    },

    // Callers do `Buffer.from(await dl.data.arrayBuffer())`, so keep a
    // Blob-shaped result rather than handing back a stream.
    async download(path) {
      return wrap(async () => {
        const out = await client().send(new GetObjectCommand({ Bucket: bucket, Key: path }));
        const bytes = await out.Body.transformToByteArray();
        const buf = Buffer.from(bytes);
        return { arrayBuffer: async () => buf, size: buf.length };
      });
    },

    // DeleteObjects caps at 1000 keys; lib/maintenance.js already chunks at 100.
    async remove(paths) {
      const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
      if (!list.length) return { data: [], error: null };
      return wrap(async () => {
        const out = await client().send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: list.map((Key) => ({ Key })), Quiet: true },
        }));
        if (out.Errors && out.Errors.length) {
          throw new Error(`${out.Errors.length} object(s) failed: ${out.Errors[0].Code}`);
        }
        return list.map((p) => ({ name: p }));
      });
    },

    async createSignedUrl(path, expiresSeconds = 600, opts = {}) {
      return wrap(async () => {
        const cmd = new GetObjectCommand({
          Bucket: bucket,
          Key: path,
          ResponseContentDisposition: contentDisposition(opts && opts.download),
        });
        const signedUrl = await getSignedUrl(client(), cmd, { expiresIn: expiresSeconds });
        return { signedUrl };
      });
    },

    // Flat paginated walk. S3 has no folders, so there is no queue, no
    // id === null folder marker and no object cap to trip over.
    async measure() {
      return wrap(async () => {
        let bytes = 0; let objects = 0; let token;
        do {
          const out = await client().send(new ListObjectsV2Command({
            Bucket: bucket, ContinuationToken: token,
          }));
          for (const o of out.Contents || []) { objects += 1; bytes += Number(o.Size) || 0; }
          token = out.IsTruncated ? out.NextContinuationToken : undefined;
        } while (token);
        return { bytes, objects };
      });
    },

    async listKeys(prefix) {
      return wrap(async () => {
        const keys = []; let token;
        do {
          const out = await client().send(new ListObjectsV2Command({
            Bucket: bucket, Prefix: prefix || undefined, ContinuationToken: token,
          }));
          for (const o of out.Contents || []) keys.push({ key: o.Key, size: Number(o.Size) || 0, etag: o.ETag });
          token = out.IsTruncated ? out.NextContinuationToken : undefined;
        } while (token);
        return keys;
      });
    },
  };
}

module.exports = { from: bucketApi, contentDisposition };
