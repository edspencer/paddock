/*
 * Paddock service worker (issue #199, hardened in #221).
 *
 * Hand-rolled and dependency-free — no Workbox, no build-time precache
 * manifest — so it stays trivial to reason about and adds nothing to the
 * install/build footprint. It exists to make the installed PWA launch offline
 * (an app shell that doesn't white-screen) and to satisfy the SW requirement
 * for a future Web Push follow-up (issue #200).
 *
 * Strategy:
 *  - Navigations: network-first. Online users always get whatever the server
 *    says — the fresh index.html, OR an auth redirect / 401 that the browser
 *    must be allowed to act on (follow the SSO login). The cached app shell is
 *    served ONLY when the network is genuinely unreachable (fetch rejects), so
 *    the SW never masks a login redirect with a stale shell (#221).
 *  - Static assets (scripts, styles, fonts, icons): stale-while-revalidate —
 *    instant from cache, refreshed in the background. Never caches (or serves) an
 *    HTML document under an asset URL — a mis-served index.html for a missing
 *    hashed chunk must not poison the cache (#220/#221).
 *  - /api and /ws: never touched. These are dynamic (auth, transcripts, live
 *    WebSocket frames); caching them would be actively wrong, so the SW does
 *    not call respondWith for them and the browser handles them normally.
 *
 * CACHE_VERSION is injected at build time (vite.config.ts → swCacheVersion
 * plugin) from the package version + a hash of the emitted bundle, so EVERY
 * deploy activates a fresh cache and `activate` purges the previous one. The
 * literal token below is the dev/un-built fallback (the SW is not registered in
 * dev, so it never actually runs unreplaced).
 */
const CACHE_VERSION = "__CACHE_VERSION__";
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

/** True when a response is an HTML document (must never satisfy an asset request). */
function isHtmlResponse(res) {
  const ct = res.headers.get("content-type") || "";
  return ct.includes("text/html");
}

async function networkFirstShell(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const fresh = await fetch(request);
    // Keep the offline shell fresh, but ONLY from a real same-origin 200 HTML
    // document — never cache a redirect/401/error as the shell.
    if (fresh && fresh.ok && fresh.type === "basic" && isHtmlResponse(fresh)) {
      cache.put(SHELL_URL, fresh.clone());
    }
    // Return exactly what the server said. A 302→SSO (opaqueredirect) or a 401
    // MUST reach the browser so it can run the login flow — substituting the
    // cached shell here would wedge the app on a stale document during an auth
    // lapse (the #221 incident). Only a genuine offline (fetch reject, below)
    // falls back to cache.
    return fresh;
  } catch {
    // Truly offline (fetch rejected): serve this route's cached document, else
    // the shell, else a minimal fallback so we never reject a navigation.
    const cached = (await cache.match(request)) || (await cache.match(SHELL_URL));
    return (
      cached ||
      new Response("<!doctype html><title>Paddock</title><h1>Offline</h1>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    );
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  // A cached HTML document under a non-navigation (asset) URL is poison left by a
  // prior build that mis-served index.html for a missing hashed chunk (#220).
  // Never serve it — fall through to the network so the real asset (or a clean
  // 404) is fetched.
  const usableCached = cached && !isHtmlResponse(cached) ? cached : undefined;
  const network = fetch(request)
    .then((res) => {
      // Only cache a genuine, same-origin, non-redirected 200 that is NOT an HTML
      // document — so an app-shell/login page can never be cached under an asset
      // URL and served to a `<script type=module>` ("module script failed").
      if (
        res &&
        res.status === 200 &&
        res.type === "basic" &&
        !res.redirected &&
        !isHtmlResponse(res)
      ) {
        cache.put(request, res.clone());
      }
      return res;
    })
    .catch(() => undefined);
  return usableCached || (await network) || fetch(request);
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
