// Process entrypoint. The Express app lives in api/index.js.
const app = require('./api/index');
const boot = require('./lib/boot');
const db = require('./lib/db');

const PORT = process.env.PORT || 3000;
// Must stay under PM2's kill_timeout (60s) or the drain is SIGKILLed anyway.
const DRAIN_MS = 55000;

(async () => {
  try {
    await boot.run();
  } catch (e) {
    console.error('refusing to start:', e.message);
    process.exit(1);
  }

  const server = app.listen(PORT, () => console.log(`Listening on port ${PORT}`));

  // Without this, `pm2 reload` SIGKILLs after 1.6s and takes any in-flight
  // media download with it, leaving the row stuck at media_status='pending'.
  // On Vercel that was a deploy edge case; here it is every reload.
  let closing = false;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      if (closing) return;
      closing = true;
      console.log(`${sig} received, draining in-flight requests`);
      const timer = setTimeout(() => {
        console.error('drain timed out, exiting anyway');
        process.exit(1);
      }, DRAIN_MS);
      timer.unref();
      server.close(async () => {
        await db.close().catch(() => {});
        console.log('drained cleanly');
        process.exit(0);
      });
    });
  }
})();
