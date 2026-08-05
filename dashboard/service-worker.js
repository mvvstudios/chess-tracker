"use strict";

const CACHE_PREFIX = "chess-opening-trainer-";
const SHELL_CACHE_VERSION = "v5";
const DATA_CACHE_VERSION = "v3";
const SHELL_CACHE = `${CACHE_PREFIX}shell-${SHELL_CACHE_VERSION}`;
const DATA_CACHE = `${CACHE_PREFIX}data-${DATA_CACHE_VERSION}`;

// Keep this list limited to the application shell. Opening-puzzle manifests and
// chunks are cached only after the trainer requests them.
const SHELL_ASSETS = [
  "./trainer.html",
  "./caro-kann-puzzles.html",
  "./styles.css",
  "./chess-ui.js",
  "./puzzle-domain.js",
  "./caro-kann-domain.js",
  "./trainer-domain.js",
  "./caro-kann-puzzles.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./chessground-theme.css",
  "./vendor/chessground.base.css",
  "./vendor/chessground.min.js",
  "./vendor/pieces/cburnett/wP.svg",
  "./vendor/pieces/cburnett/wN.svg",
  "./vendor/pieces/cburnett/wB.svg",
  "./vendor/pieces/cburnett/wR.svg",
  "./vendor/pieces/cburnett/wQ.svg",
  "./vendor/pieces/cburnett/wK.svg",
  "./vendor/pieces/cburnett/bP.svg",
  "./vendor/pieces/cburnett/bN.svg",
  "./vendor/pieces/cburnett/bB.svg",
  "./vendor/pieces/cburnett/bR.svg",
  "./vendor/pieces/cburnett/bQ.svg",
  "./vendor/pieces/cburnett/bK.svg"
];

const scopeUrl = new URL(self.registration.scope);
const shellPaths = new Set(SHELL_ASSETS.map(path => new URL(path, scopeUrl).pathname));
const openingDocuments = new Set([
  new URL("./trainer.html", scopeUrl).pathname,
  new URL("./caro-kann-puzzles.html", scopeUrl).pathname,
]);

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL_ASSETS);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map(name => {
      if (name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE && name !== DATA_CACHE) {
        return caches.delete(name);
      }
      return Promise.resolve(false);
    }));
    await self.clients.claim();
  })());
});

function dataPath(url) {
  if (url.origin !== scopeUrl.origin || !url.pathname.startsWith(scopeUrl.pathname)) return "";
  return url.pathname.slice(scopeUrl.pathname.length);
}

function isDeckDataRequest(url) {
  const path = dataPath(url);
  return path === "data/opening-puzzle-catalog.json"
    || path === "data/my-blunder-puzzles.json"
    || /^data\/[^/]+\/manifest\.json$/.test(path)
    || /^data\/[^/]+\/selection-index\.json$/.test(path)
    || /^data\/[^/]+\/chunks\/chunk-\d+\.json$/.test(path);
}

async function networkFirstData(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await cache.put(request, response.clone());
      return response;
    }
    return await cache.match(request) || response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) await cache.put(request, response.clone());
  return response;
}

async function openingNavigation(request, url) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await cache.put(url.pathname, response.clone());
      return response;
    }
    const cached = await cache.match(url.pathname, { ignoreSearch: true });
    if (cached) return cached;
    return response;
  } catch (error) {
    const cached = await cache.match(url.pathname, { ignoreSearch: true })
      || await cache.match("./trainer.html");
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (isDeckDataRequest(url)) {
    event.respondWith(networkFirstData(request));
    return;
  }
  if (request.mode === "navigate" && openingDocuments.has(url.pathname)) {
    event.respondWith(openingNavigation(request, url));
    return;
  }
  if (url.origin === scopeUrl.origin && shellPaths.has(url.pathname)) {
    event.respondWith(cacheFirstShell(request));
  }
});

self.addEventListener("message", event => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
