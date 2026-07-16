/**
 * Behavioural tests for the real service worker (packages/web/public/sw.js),
 * hardened in issue #221. sw.js is a standalone worker script (not an ES module),
 * so we read its source and evaluate it inside a mocked SW global, capturing its
 * `fetch` handler and driving it with synthetic requests/responses.
 *
 * The behaviours that matter for the "module script failed" / stale-cache class
 * of bugs:
 *  - a navigation that returns 401 or an SSO redirect is passed THROUGH (the SW
 *    must not mask the login with a cached shell)
 *  - offline (fetch rejects) still falls back to the cached shell
 *  - an HTML document is never cached under, nor served for, an asset URL
 *  - a genuine JS 200 is cached
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// sw.js lives in public/. Resolve it from cwd (packages/web when tests run per
// workspace) with a repo-root fallback — import.meta.url isn't a file:// URL
// under vitest's transform, so fileURLToPath can't be used here.
function readSwSource(): string {
  const candidates = [
    path.resolve(process.cwd(), "public/sw.js"),
    path.resolve(process.cwd(), "packages/web/public/sw.js"),
  ];
  for (const c of candidates) {
    try {
      return readFileSync(c, "utf-8");
    } catch {
      /* try next */
    }
  }
  throw new Error("sw.test.ts: could not locate public/sw.js");
}

const SW_SOURCE = readSwSource();

const ORIGIN = "https://app.test";

interface Res {
  ok: boolean;
  status: number;
  type: string;
  redirected: boolean;
  headers: { get: (k: string) => string | null };
  body: string;
  clone: () => Res;
}

function res(o: { status?: number; type?: string; redirected?: boolean; ct?: string; body?: string }): Res {
  const status = o.status ?? 200;
  const ct = o.ct ?? "application/javascript";
  const r: Res = {
    ok: status >= 200 && status < 300,
    status,
    type: o.type ?? "basic",
    redirected: o.redirected ?? false,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? ct : null) },
    body: o.body ?? "",
    clone() {
      return r;
    },
  };
  return r;
}

const keyOf = (req: unknown) => (typeof req === "string" ? req : (req as { url: string }).url);

class FakeCache {
  store = new Map<string, Res>();
  async match(req: unknown) {
    return this.store.get(keyOf(req));
  }
  async put(req: unknown, r: Res) {
    this.store.set(keyOf(req), r);
  }
  async addAll() {
    /* precache no-op */
  }
}

interface Harness {
  fetchHandler: (event: { request: unknown; respondWith: (p: Promise<Res>) => void }) => void;
  cache: FakeCache;
  setFetch: (fn: (req: { url: string }) => Promise<Res>) => void;
  run: (request: { method: string; url: string; mode: string }) => Promise<Res>;
}

function loadSw(): Harness {
  const cache = new FakeCache();
  const caches = {
    open: async () => cache,
    keys: async () => [] as string[],
    delete: async () => true,
    match: async (r: unknown) => cache.match(r),
  };
  const handlers: Record<string, (e: unknown) => void> = {};
  const self = {
    addEventListener: (t: string, fn: (e: unknown) => void) => {
      handlers[t] = fn;
    },
    location: { origin: ORIGIN },
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };
  let fetchImpl: (req: { url: string }) => Promise<Res> = async () => res({});
  const fetchMock = (req: { url: string }) => fetchImpl(req);

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("self", "caches", "fetch", "Response", "URL", SW_SOURCE)(
    self,
    caches,
    fetchMock,
    Response,
    URL,
  );

  return {
    fetchHandler: handlers["fetch"] as Harness["fetchHandler"],
    cache,
    setFetch: (fn) => {
      fetchImpl = fn;
    },
    run(request) {
      let responded: Promise<Res> | undefined;
      handlers["fetch"]({ request, respondWith: (p: Promise<Res>) => (responded = p) });
      return responded as Promise<Res>;
    },
  };
}

describe("service worker (issue #221)", () => {
  let h: Harness;
  beforeEach(() => {
    h = loadSw();
  });

  const nav = (url = `${ORIGIN}/`) => ({ method: "GET", url, mode: "navigate" });
  const asset = (url: string) => ({ method: "GET", url, mode: "cors" });

  it("passes a 401 navigation THROUGH instead of masking it with the cached shell", async () => {
    await h.cache.put("/", res({ ct: "text/html", body: "STALE-SHELL" }));
    h.setFetch(async () => res({ status: 401, ct: "application/json", body: "unauthorized" }));
    const out = await h.run(nav());
    expect(out.status).toBe(401);
    expect(out.body).not.toBe("STALE-SHELL");
  });

  it("passes an SSO redirect (opaqueredirect) THROUGH so the browser can log in", async () => {
    await h.cache.put("/", res({ ct: "text/html", body: "STALE-SHELL" }));
    h.setFetch(async () => res({ status: 0, type: "opaqueredirect", ct: "" }));
    const out = await h.run(nav());
    expect(out.type).toBe("opaqueredirect");
  });

  it("falls back to the cached shell only when genuinely offline (fetch rejects)", async () => {
    await h.cache.put("/", res({ ct: "text/html", body: "OFFLINE-SHELL" }));
    h.setFetch(async () => {
      throw new Error("offline");
    });
    const out = await h.run(nav(`${ORIGIN}/projects/x`));
    expect(out.body).toBe("OFFLINE-SHELL");
  });

  it("never caches an HTML document under an asset URL", async () => {
    const url = `${ORIGIN}/assets/index-ABC.js`;
    // Server mis-serves index.html (200 text/html) for a missing hashed chunk.
    h.setFetch(async () => res({ status: 200, ct: "text/html", body: "<!doctype html>" }));
    await h.run(asset(url));
    expect(h.cache.store.has(url)).toBe(false);
  });

  it("bypasses a poisoned cached HTML asset and serves the fresh JS", async () => {
    const url = `${ORIGIN}/assets/index-ABC.js`;
    await h.cache.put(url, res({ ct: "text/html", body: "<!doctype html>" })); // poison
    h.setFetch(async () => res({ status: 200, ct: "application/javascript", body: "export{}" }));
    const out = await h.run(asset(url));
    expect(out.headers.get("content-type")).toContain("javascript");
    expect(out.body).toBe("export{}");
  });

  it("caches a genuine JS 200 for next time", async () => {
    const url = `${ORIGIN}/assets/chunk-XYZ.js`;
    h.setFetch(async () => res({ status: 200, ct: "application/javascript", body: "1" }));
    await h.run(asset(url));
    expect(h.cache.store.has(url)).toBe(true);
  });
});
