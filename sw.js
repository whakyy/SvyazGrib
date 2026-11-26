// Сохраняет страницу приложения, чтобы она открывалась без интернета.
const CACHE = 'gv-v1';
self.addEventListener('install', e => {
  e.waitUntil(fetch('/', { cache: 'no-store' }).then(async r => { if (r.ok && r.headers.get('X-Gribsvyaz')) await (await caches.open(CACHE)).put('/', r); }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || (u.pathname !== '/' && u.pathname !== '/index.html')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE), old = await cache.match('/');
    const net = fetch(e.request).then(async r => {
      if (r.ok && r.headers.get('X-Gribsvyaz')) { await cache.put('/', r.clone()); return r; }
      return old || r;
    });
    if (!old) return net;
    // сначала свежая версия, но если сеть молчит 4 секунды, берём сохранённую
    return Promise.race([net.catch(() => old), new Promise(ok => setTimeout(() => ok(old), 4000))]);
  })());
});
