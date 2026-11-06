/* 自动生成（tools/build.mjs）——勿手改；版本 v0.1.0-b18ed2f5 */
const CACHE = 'sgby-assets-v0.1.0-b18ed2f5';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    /* 清掉旧版本缓存（素材变更时） */
    for (const k of await caches.keys()) {
      if (k.startsWith('sgby-assets-') && k !== CACHE) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  /* 只缓存三个大资源；页面/脚本/meta 走网络（meta 需每次确认资源包版本） */
  const name = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  if (!['game.zip', 'fontbm.bin', 'fontbm-full.bin'].includes(name)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(e.request);
    if (hit) return hit;
    const resp = await fetch(e.request);
    if (resp.ok) {
      try { await cache.put(e.request, resp.clone()); } catch (err) { /* 配额等异常不阻断 */ }
    }
    return resp;
  })());
});
