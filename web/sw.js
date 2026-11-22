// Shows a notification for a member message when the inbox is not in front,
// and opens that chat when it is tapped. It caches nothing, so the inbox
// itself always loads fresh from the server.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Chrome and Firefox allow skipping the notification while the inbox is in
// front. Safari (every iPhone browser) drops a subscription that stays silent.
const MAY_STAY_SILENT = /Chrom(e|ium)\/|Edg\/|Firefox\//.test(self.navigator.userAgent);

function inboxWindows() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
}

async function showFor(d) {
  try {
    if (self.navigator.setAppBadge && Number.isFinite(d.unread)) {
      if (d.unread > 0) await self.navigator.setAppBadge(d.unread);
      else await self.navigator.clearAppBadge();
    }
  } catch (_) {}
  if (MAY_STAY_SILENT) {
    const wins = await inboxWindows();
    if (wins.some((w) => w.focused && w.visibilityState === 'visible')) return;
  }
  await self.registration.showNotification(d.title || 'New message', {
    body: d.body || '',
    tag: d.wa_id ? `wa-${d.wa_id}` : 'wa-inbox',
    icon: '/static/icon-192.png',
    data: { wa_id: d.wa_id || null },
  });
}

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) {}
  event.waitUntil(showFor(d));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const waId = event.notification.data && event.notification.data.wa_id;
  event.waitUntil((async () => {
    const wins = await inboxWindows();
    const win = wins.find((w) => new URL(w.url).pathname === '/app');
    if (win) {
      try { await win.focus(); } catch (_) {}
      win.postMessage({ type: 'open-chat', wa_id: waId });
      return;
    }
    await self.clients.openWindow(waId ? `/app#chat=${encodeURIComponent(waId)}` : '/app');
  })());
});
