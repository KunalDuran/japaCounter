'use strict';

const SHELL_CACHE = 'naam-jap-shell-v1';
const FONT_CACHE  = 'naam-jap-fonts-v1';

const SHELL_FILES = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/favicon.ico',
  '/icon.svg',
  '/manifest.json',
];

// Install: pre-cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

// Activate: evict old shell caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== FONT_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API calls: always go to the network (live data, don't cache)
  if (url.hostname === 'dyn.duranz.in') return;

  // Google Fonts: stale-while-revalidate
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(FONT_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const fresh = fetch(request).then((res) => {
          if (res.ok) cache.put(request, res.clone());
          return res;
        });
        return cached ?? fresh;
      })
    );
    return;
  }

  // App shell: cache-first, fall back to network and update cache
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        if (res.ok) {
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, res.clone()));
        }
        return res;
      });
    })
  );
});
// Open the app when the user clicks the reminder notification
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // Focus an existing window if we have one
      for (const w of wins) {
        if ('focus' in w) return w.focus();
      }
      // Otherwise open a new one
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});