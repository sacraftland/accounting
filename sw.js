// كرافت لاند — service worker
// الاستراتيجية: الشبكة أولاً. كل مرة يُفتح التطبيق يجيب أحدث نسخة من الموقع،
// والنسخة المخزنة تُستخدم فقط إذا انقطع الإنترنت.
// طلبات Supabase وأي موقع خارجي لا يلمسها هذا الملف أبداً.
const CACHE = 'craftland-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return; // Supabase، الخطوط، CDN → مباشرة
  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
      if (hit) return hit;
      throw err;
    }
  })());
});
