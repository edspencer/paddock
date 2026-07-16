import { describe, it, expect } from "vitest";
import {
  isChunkLoadError,
  reloadedRecently,
  markReloaded,
  decideChunkRecovery,
} from "./chunk-error";

/** A Map-backed Storage stand-in so tests can inject state deterministically. */
function fakeStorage(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

describe("isChunkLoadError", () => {
  it("matches cross-browser dynamic-import / module-script failures", () => {
    const messages = [
      "Failed to fetch dynamically imported module: https://app/assets/ChatPane-ABC.js",
      "error loading dynamically imported module",
      "Importing a module script failed.",
      "Unexpected application error: a module script failed",
      "Unable to preload CSS for /assets/x.css",
      "Load failed",
    ];
    for (const m of messages) expect(isChunkLoadError(new Error(m)), m).toBe(true);
  });

  it("matches a ChunkLoadError by name regardless of message", () => {
    const err = new Error("whatever");
    err.name = "ChunkLoadError";
    expect(isChunkLoadError(err)).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(new TypeError("x is not a function"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });

  it("handles non-Error thrown values", () => {
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(true);
    expect(isChunkLoadError("nope")).toBe(false);
  });
});

describe("reload guard", () => {
  it("reports a recent reload within the window and not outside it", () => {
    const now = 1_000_000;
    const s = fakeStorage();
    expect(reloadedRecently(now, s)).toBe(false);
    markReloaded(now, s);
    expect(reloadedRecently(now + 500, s)).toBe(true); // still within 10s
    expect(reloadedRecently(now + 20_000, s)).toBe(false); // window elapsed
  });

  it("is safe when storage is unavailable", () => {
    expect(reloadedRecently(0, undefined)).toBe(false);
    expect(() => markReloaded(0, undefined)).not.toThrow();
  });
});

describe("decideChunkRecovery", () => {
  it("reloads for a fresh chunk error", () => {
    expect(decideChunkRecovery(new Error("Failed to fetch dynamically imported module"), 0, fakeStorage())).toBe(
      "reload",
    );
  });

  it("shows (does not loop) a chunk error that already survived a reload", () => {
    const s = fakeStorage();
    markReloaded(5_000, s);
    expect(
      decideChunkRecovery(new Error("module script failed"), 6_000, s),
    ).toBe("show");
  });

  it("shows a non-chunk error", () => {
    expect(decideChunkRecovery(new Error("boom"), 0, fakeStorage())).toBe("show");
  });
});
