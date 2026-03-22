self.addEventListener('install', (event) => {
  console.log('Service Worker installed');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('Service Worker activated');
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Empty fetch handler is required by some browsers to trigger PWA install prompt.
  // We don't cache explicitly here, just let the standard Next.js routing perform naturally.
  return;
});
