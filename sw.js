'use strict';

var CACHE_VERSION = 'konomi-v1.0.0';
var ASSETS = [
  '.',
  'index.html',
  'style.css',
  'js/logic.js',
  'js/charts.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE_VERSION).then(function (cache) {
    return cache.addAll(ASSETS);
  }));
  // 勝手に skipWaiting しない(更新はユーザーのトーストタップ時のみ)
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (key) {
      return key === CACHE_VERSION ? null : caches.delete(key);
    }));
  }));
  self.clients.claim();
});

// stale-while-revalidate: キャッシュ即返し + 裏で再取得(次回起動時に最新化)
self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then(function (cached) {
    var refresh = fetch(event.request).then(function (response) {
      if (response.ok) {
        var copy = response.clone();
        caches.open(CACHE_VERSION).then(function (cache) {
          cache.put(event.request, copy);
        });
      }
      return response;
    });
    if (cached) {
      refresh.catch(function () {});
      return cached;
    }
    return refresh;
  }));
});
