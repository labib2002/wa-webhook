// Server-side Supabase client (service-role key — bypasses RLS).
// NEVER import this into anything that ships to the browser.
//
// We create the client lazily so the app still boots (and the Meta handshake
// still works) before the Supabase env vars are filled in. Routes that need
// the DB call getDb() and get a clear error if it isn't configured yet.

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

let client = null;
let injected = null; // test/demo override

// Inject a Supabase-shaped client (used only by the screenshot/demo harness).
function __setDbForTesting(fake) {
  injected = fake;
}

function isConfigured() {
  if (injected) return true;
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function getDb() {
  if (injected) return injected;
  if (!isConfigured()) {
    const err = new Error(
      'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
    );
    err.code = 'DB_NOT_CONFIGURED';
    throw err;
  }
  if (!client) {
    client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: { persistSession: false, autoRefreshToken: false },
        // We never open a realtime socket server-side, but supabase-js builds a
        // RealtimeClient on construction which needs a WebSocket ctor that
        // Node < 22 lacks natively. Provide one so it works on Vercel's runtime.
        realtime: { transport: ws },
      }
    );
  }
  return client;
}

module.exports = { getDb, isConfigured, __setDbForTesting };
