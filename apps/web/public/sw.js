self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open('geniussend-shell-v1');
    await cache.addAll(['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('geniussend-shell-') && key !== 'geniussend-shell-v1')
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        void caches.open('geniussend-shell-v1').then((cache) => cache.put('/', copy));
      }
      return response;
    }).catch(async () => (await caches.match('/')) || Response.error()));
    return;
  }

  if (['script', 'style', 'image', 'font'].includes(request.destination)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        void caches.open('geniussend-shell-v1').then((cache) => cache.put(request, copy));
      }
      return response;
    })));
  }
});
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'GeniusSend', body: 'Une nouvelle demande de transfert est disponible.' };
  }

  const title = payload.title || 'Demande de transfert GeniusSend';
  const body = payload.fileName
    ? `${payload.senderName || 'Un appareil'} souhaite envoyer ${payload.fileName}. Ouvrez GeniusSend pour répondre.`
    : payload.body || 'Ouvrez GeniusSend pour consulter la demande.';

  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: payload.transferId || 'geniussend-transfer',
    data: { url: '/', transferId: payload.transferId || null }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.navigate(target);
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});

