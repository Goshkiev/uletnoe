// Service worker приложения «Заказы»: нужен для установки на телефон и показа уведомлений.
const CACHE = 'uletnoe-admin-v2';
const SHELL = ['./', './admin.css', './admin.js', '../config.js', '../api-client.js', '../fonts/fonts.css', './icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Сначала сеть, кэш только если интернета нет: так обновления приходят сразу.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(fetch(e.request)
    .then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    })
    .catch(() => caches.match(e.request)));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.includes('/admin/'));
    return open ? open.focus() : self.clients.openWindow('./');
  }));
});

// Push приходит пустым: свежие заказы забираем с нашего сервера и показываем уведомление.
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let title = 'Новый заказ';
    let body = 'Откройте приложение, чтобы посмотреть';
    let tag = 'new-order';
    try {
      const res = await fetch(new URL('../api/staff/orders?status=new', self.location), { credentials: 'same-origin', cache: 'no-store' });
      const list = res.ok ? await res.json() : [];
      const o = list[list.length - 1];
      if (o) {
        title = `Новый заказ №${o.number}`;
        body = `${o.items.map((i) => `${i.qty}× ${i.name}`).join(', ')} · ${o.total} ₽`;
        tag = o.id;
      }
    } catch (err) { /* покажем общее уведомление */ }
    await self.registration.showNotification(title, { body, tag, renotify: true, icon: 'icon-192.png', badge: 'icon-192.png', vibrate: [200, 100, 200, 100, 200] });
  })());
});
