/* Service worker — la coquille est servie RÉSEAU D'ABORD (toujours à jour en ligne),
   le cache ne sert que de secours hors ligne. Les appels API ne passent jamais par ici. */
const CACHE = 'jdl-shell-v5';
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/favicon-32.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(ASSETS.map((a) =>
        fetch(a, { cache: 'reload' }).then((r) => r.ok && c.put(a, r)).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // API -> réseau direct

  const isShell = req.mode === 'navigate' || /\.(?:html|js|css|webmanifest)$/.test(url.pathname);

  if (isShell) {
    // réseau d'abord, en contournant le cache HTTP du navigateur
    e.respondWith(
      fetch(req, { cache: 'reload' })
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return resp;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // icônes & co : cache d'abord
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((resp) => {
      if (resp && resp.status === 200 && resp.type === 'basic') {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return resp;
    }))
  );
});
