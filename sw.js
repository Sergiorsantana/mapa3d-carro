// Service worker: guarda os arquivos do app e os pedaços de mapa já vistos (ajuda quando o sinal cai).
const APP = 'mapa3d-app-v6';
const TILES = 'mapa3d-tiles-v1';
const ARQUIVOS = ['./', 'index.html', 'style.css', 'app.js', 'cena3d.js', 'ia.js', 'ajustes.js', 'sensores.js', 'faixas.js', 'aviso.js', 'navegacao.js', 'limite.js', 'dashcam.js', 'historico.js', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(ARQUIVOS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(
    ks.filter((k) => k !== APP && k !== TILES).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Mapas: rede primeiro, cache se estiver sem internet.
  if (url.hostname.endsWith('openfreemap.org') || url.hostname === 'unpkg.com' || url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'storage.googleapis.com') {
    e.respondWith(
      fetch(e.request).then((r) => {
        if (r.ok) { const copia = r.clone(); caches.open(TILES).then((c) => c.put(e.request, copia)); }
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Arquivos do app: rede primeiro (pega atualizações), cache se estiver offline.
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' }).then((r) => {
        if (r.ok) { const copia = r.clone(); caches.open(APP).then((c) => c.put(e.request, copia)); }
        return r;
      }).catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
  }
});
