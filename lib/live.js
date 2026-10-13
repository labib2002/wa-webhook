// Live updates for open inbox tabs over Server-Sent Events. Any write to
// messages or conversations (webhook, sends, media finishing, read flags)
// pushes a "change" to every tab, which then fetches only what changed.
// In-process fan-out is enough because PM2 runs this app as one fork process.

const HEARTBEAT_MS = 25000;   // under the ALB's 60s idle timeout
const MAX_STREAM_MS = 15 * 60000; // reconnect re-runs the session check
const DEBOUNCE_MS = 150;

const clients = new Set();
let pending = null;

function subscribe(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write('event: ready\ndata: {}\n\n');
  clients.add(res);

  const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  const cap = setTimeout(() => res.end(), MAX_STREAM_MS);
  const done = () => {
    clearInterval(beat);
    clearTimeout(cap);
    clients.delete(res);
  };
  req.on('close', done);
  res.on('close', done);
}

function publish(table) {
  if (table !== 'messages' && table !== 'conversations') return;
  if (pending || !clients.size) return;
  pending = setTimeout(() => {
    pending = null;
    for (const res of clients) res.write('event: change\ndata: {}\n\n');
  }, DEBOUNCE_MS);
}

function closeAll() {
  for (const res of clients) res.end();
  clients.clear();
}

module.exports = { subscribe, publish, closeAll, _clients: clients };
