// Service worker for the AJI SUSHI kitchen order board.
// Handles receiving push notifications (new orders) even when the page
// itself isn't open, and focuses/opens the order board when tapped.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = { title: 'New order', body: 'You have a new order to confirm.' };
  try {
    if (event.data) payload = event.data.json();
  } catch (e) {
    // ignore malformed payloads, fall back to default text above
  }

  const options = {
    body: payload.body || 'You have a new order to confirm.',
    icon: '/kitchen-icon.png',
    badge: '/kitchen-icon.png',
    vibrate: [300, 100, 300, 100, 300],
    tag: payload.tag || 'aji-new-order',
    renotify: true,
    requireInteraction: true,
    data: { url: payload.url || '/restaurant-orders.html' },
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'New order', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/restaurant-orders.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('restaurant-orders.html') && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
