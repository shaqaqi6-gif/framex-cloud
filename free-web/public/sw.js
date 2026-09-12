/*
 * FrameX service worker.
 *
 * Versions come from the registration URL (sw.js?b=<build>&e=<engine>) so the
 * caches roll over on their own:
 *   - the shell cache is keyed to the build, so every deploy starts clean and
 *     a phone can never be stuck on a previous build's HTML;
 *   - the engine cache is keyed to the FFmpeg core version, so the 32MB wasm
 *     survives UI-only deploys instead of being downloaded again.
 */

var params = new URL(self.location.href).searchParams;
var BUILD = params.get('b') || 'dev';
var ENGINE = params.get('e') || 'dev';
var SHELL_CACHE = 'framex-shell-' + BUILD;
var ENGINE_CACHE = 'framex-engine-' + ENGINE;
var KEEP = [SHELL_CACHE, ENGINE_CACHE];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(function (cache) { return cache.addAll(['./', './manifest.webmanifest', './icon.svg']); })
      .catch(function () { /* offline on first load is fine */ })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) {
          if (KEEP.indexOf(key) === -1) return caches.delete(key);
          return null;
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  /* Immutable by URL: the engine carries ?e=<version>, vite assets carry a
     content hash. Serve them from cache and skip the network entirely. */
  if (url.pathname.indexOf('/ffmpeg/') !== -1) {
    event.respondWith(cacheFirst(request, ENGINE_CACHE));
    return;
  }
  if (url.pathname.indexOf('/assets/') !== -1) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  event.respondWith(networkFirst(request, SHELL_CACHE));
});

function cacheFirst(request, cacheName) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(request).then(function (hit) {
      if (hit) return hit;
      return fetch(request).then(function (response) {
        if (response && response.ok) cache.put(request, response.clone());
        return response;
      });
    });
  });
}

function networkFirst(request, cacheName) {
  return fetch(request, { cache: 'no-store' })
    .then(function (response) {
      if (response && response.ok) {
        var copy = response.clone();
        caches.open(cacheName).then(function (cache) { cache.put(request, copy); });
      }
      return response;
    })
    .catch(function () {
      return caches.match(request).then(function (hit) {
        return hit || caches.match('./');
      });
    });
}
