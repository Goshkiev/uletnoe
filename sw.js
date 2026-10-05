// Service worker приложения для гостей: установка на телефон и меню без интернета.
const CACHE = 'uletnoe-site-v1';
const SHELL = ['./', './index.html', './styles.css', './app.js', './api-client.js', './config.js', './menu.json', './fonts/fonts.css', './img/logo.jpg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('uletnoe-site-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Сначала сеть (свежие цены), кэш только без интернета. Заказы и экран кафе не трогаем.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || /\/(api|admin)\//.test(url.pathname)) return;
  e.respondWith(fetch(e.request)
    .then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
