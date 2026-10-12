/* Keeps the app itself loadable in a store with weak signal.
   Network first, but give up after 3 s and use the saved copy. Weak signal
   usually means lost packets rather than a fast refusal, so without the cap a
   request can hang for tens of seconds. Data calls to Google are not touched
   here; the app keeps its own saved copy of the list. */
const CACHE = 'groceries-v1';
const SHELL = ['./', './index.html', './app.js', './math.js', './config.js', './manifest.webmanifest', './icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const network = fetch(req).then(res => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    });
    const timeout = new Promise(resolve => setTimeout(() => resolve(null), 3000));
    try {
      const first = await Promise.race([network, timeout]);
      if (first) return first;
    } catch (err) { /* offline: fall through to the saved copy */ }
    const saved = await cache.match(req, { ignoreSearch: true });
    return saved || network;
  })());
});
