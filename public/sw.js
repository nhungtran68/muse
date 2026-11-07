const CACHE = 'muse-offline-v1';
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.add('/offline.html'))));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter(name => name.startsWith('muse-offline-') && name !== CACHE).map(name => caches.delete(name)));
  await self.clients.claim();
})()));
// Never cache application responses, authentication, uploads, or customer media.
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(request).catch(async () => (await caches.open(CACHE)).match('/offline.html')));
});
