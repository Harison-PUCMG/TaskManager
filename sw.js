/* TaskFlow — Service Worker
 *
 * Fica na raiz do site (Vercel), então o escopo dele é todo o domínio do app.
 *
 * Estratégias:
 *  - Arquivos do próprio app (index.html, app.js, ícones): network-first.
 *    Online, sempre pega a versão nova do GitHub Pages; offline, usa o cache.
 *  - Bibliotecas do cdnjs (sql.js + .wasm, marked, DOMPurify): cache-first.
 *    As URLs têm versão fixa, então o conteúdo nunca muda.
 *  - /api/* (sincronização na nuvem) e qualquer outra coisa: passa direto,
 *    sem cache — nunca se serve dado de sync velho.
 *
 * Ao trocar a versão de alguma biblioteca do CDN, atualize CDN_ASSETS e
 * incremente VERSION.
 */
const VERSION = 'taskflow-v3';
const APP_CACHE = `${VERSION}-app`;
const CDN_CACHE = `${VERSION}-cdn`;

const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './editor.js',
  './styles.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

const CDN_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/sql-wasm.js',
  'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/sql-wasm.wasm',
  'https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.5/purify.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const app = await caches.open(APP_CACHE);
    await app.addAll(APP_SHELL);
    const cdn = await caches.open(CDN_CACHE);
    await cdn.addAll(CDN_ASSETS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k.startsWith('taskflow-') && !k.startsWith(VERSION))
          .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Bibliotecas do CDN: cache-first
  if (url.origin === 'https://cdnjs.cloudflare.com') {
    event.respondWith((async () => {
      const cached = await caches.match(req.url, { ignoreVary: true });
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') {
        const cache = await caches.open(CDN_CACHE);
        cache.put(req.url, res.clone());
      }
      return res;
    })());
    return;
  }

  // Arquivos do app (mesmo escopo): network-first com fallback
  const scopePath = new URL('./', self.location).pathname;
  if (url.origin === self.location.origin && url.pathname.startsWith(scopePath) && !url.pathname.startsWith(scopePath + 'api/')) {
    event.respondWith((async () => {
      const cache = await caches.open(APP_CACHE);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch (err) {
        const cached = await cache.match(req, { ignoreSearch: true });
        if (cached) return cached;
        if (req.mode === 'navigate') {
          return (await cache.match('./index.html')) || (await cache.match('./'));
        }
        throw err;
      }
    })());
  }
  // Demais requisições (ex.: /api/sync) seguem sem interceptação.
});
