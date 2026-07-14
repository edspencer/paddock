/*
 * Paddock service worker (issue #199).
 *
 * Hand-rolled and dependency-free — no Workbox, no build-time precache
 * manifest — so it stays trivial to reason about and adds nothing to the
 * install/build footprint. It exists to make the installed PWA launch offline
 * (an app shell that doesn't white-screen) and to satisfy the SW requirement
 * for a future Web Push follow-up (issue #200).
 *
 * Strategy:
 *  - Navigations: network-first, falling back to the cached app shell ("/").
 *    Online users always get the freshly branded index.html; offline they get
 *    the last good shell for ANY client-side route.
 *  - Static assets (scripts, styles, fonts, icons): stale-while-revalidate —
 *    instant from cache, refreshed in the background.
 *  - /api and /ws: never touched. These are dynamic (auth, transcripts, live
 *    WebSocket frames); caching them would be actively wrong, so the SW does
 *    not call respondWith for them and the browser handles them normally.
 *
 * Bump CACHE_VERSION to invalidate every cached asset on the next activation.
 */
const CACHE_VERSION = "paddock-v1";
const SHELL_URL = "/";

// Minimal set precached on install so a cold, offline launch has its shell and
// icons. Hashed JS/CSS bundles are intentionally NOT listed (their names change
// per build); they populate via the runtime stale-while-revalidate path.
const PRECACHE = [SHELL_URL, "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      // A single missing entry must not abort activation of the whole SW.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

function isBypassed(url) {
  return url.pathname.startsWith("/api") || url.pathname.startsWith("/ws");
}

async function networkFirstShell(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cachedShell = () =>
    cache.match(request).then((r) => r || cache.match(SHELL_URL));
  try {
    const fresh = await fetch(request);
    // Keep the shell fresh so offline launches get the latest good document.
    if (fresh && fresh.ok) {
      cache.put(SHELL_URL, fresh.clone());
      return fresh;
    }
    // Reachable but erroring (e.g. a 502 when the app server is down behind an
    // up proxy) is NOT a fetch rejection, so prefer the cached shell if we have
    // one — the installed app should still launch. Fall through to the raw
    // response only when nothing is cached.
    return (await cachedShell()) || fresh;
  } catch {
    // Truly offline (fetch rejected): serve this route's cached document, else
    // the shell, else a minimal fallback so we never reject a navigation.
    return (
      (await cachedShell()) ||
      new Response("<!doctype html><title>Paddock</title><h1>Offline</h1>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    );
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok && res.type === "basic") cache.put(request, res.clone());
      return res;
    })
    .catch(() => undefined);
  return cached || (await network) || fetch(request);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // cross-origin: leave alone
  if (isBypassed(url)) return; // /api + /ws: never cache

  if (request.mode === "navigate") {
    event.respondWith(networkFirstShell(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});
