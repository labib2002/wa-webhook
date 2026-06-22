// Verify Meta's X-Hub-Signature-256 header against the raw request body using
// the app secret. Meta signs the *exact bytes* it sent, so we must hash the
// raw body (captured in api/index.js via the express.json verify hook), not a
// re-stringified object.

const crypto = require('crypto');

// Returns one of: 'ok' | 'invalid' | 'skipped'
//   'skipped' => APP_SECRET not set yet, so we can't verify (allowed, with a warn)
function checkSignature(req) {
  const appSecret = process.env.APP_SECRET;
  if (!appSecret) return 'skipped';

  const header = req.get('x-hub-signature-256') || '';
  if (!header.startsWith('sha256=')) return 'invalid';

  const raw = req.rawBody; // Buffer, set by the verify hook
  if (!raw || !raw.length) return 'invalid';

  const expected =
    'sha256=' + crypto.createHmac('sha256', appSecret).update(raw).digest('hex');

  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return 'invalid';
  return crypto.timingSafeEqual(a, b) ? 'ok' : 'invalid';
}

module.exports = { checkSignature };
