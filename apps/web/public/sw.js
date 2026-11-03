// Changer ce nom à chaque évolution de l’interface force les appareils installés à se mettre à jour.
const CACHE_NAME = 'geniussend-shell-v7';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(['/', '/app/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('geniussend-shell-') && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Deux pages : l’accueil (/) et l’application (/app/). Hors ligne, chacune retombe sur sa copie.
  if (request.mode === 'navigate') {
    const page = url.pathname.startsWith('/app') ? '/app/' : '/';
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(page, copy));
      }
      return response;
    }).catch(async () => (await caches.match(page)) || Response.error()));
    return;
  }

  // Les fichiers de /assets/ portent une empreinte dans leur nom : ils ne changent jamais, le cache suffit.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    })));
    return;
  }

  // Icônes et logo gardent la même adresse d’une version à l’autre : réseau d’abord, cache seulement hors ligne.
  // Le reste (dont les sources servies par Vite en développement) n’est pas intercepté.
  if (url.pathname.startsWith('/icons/') || url.pathname.startsWith('/brand/')) {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(async () => (await caches.match(request)) || Response.error()));
  }
});
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'GeniusSend', body: 'Un fichier vous attend.' };
  }

  const title = payload.title || 'Fichier entrant GeniusSend';
  const body = payload.fileName
    ? `${payload.senderName || 'Un appareil'} vous envoie ${payload.fileName}. Ouvrez GeniusSend pour le recevoir.`
    : payload.body || 'Ouvrez GeniusSend pour recevoir le fichier.';

  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: payload.transferId || 'geniussend-transfer',
    data: { url: '/app/', transferId: payload.transferId || null }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/app/', self.location.origin).href;
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

