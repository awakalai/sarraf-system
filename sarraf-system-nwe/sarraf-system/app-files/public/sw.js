// Service worker سادە بۆ ئەوەی ئەپەکە دابمەزرێت
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => self.clients.claim());
self.addEventListener('fetch', (e) => {});
