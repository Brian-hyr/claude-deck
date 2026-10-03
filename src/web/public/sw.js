// Service worker mínimo: só existe para o Brave oferecer "instalar como app".
// Não guarda nada em cache (a interface vem sempre do servidor local).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
