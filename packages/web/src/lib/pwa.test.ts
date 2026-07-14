import { describe, it, expect, vi, afterEach } from "vitest";
import { registerServiceWorker } from "./pwa";

// registerServiceWorker guards on browser support + build mode. These tests pin
// those guards: it must never throw, must skip in dev, and must register the
// root-scoped worker only in a production build on a supporting browser.
const originalSW = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");

function setServiceWorker(value: unknown): void {
  Object.defineProperty(navigator, "serviceWorker", { value, configurable: true });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (originalSW) Object.defineProperty(navigator, "serviceWorker", originalSW);
  else delete (navigator as { serviceWorker?: unknown }).serviceWorker;
});

describe("registerServiceWorker", () => {
  it("is a no-op when service workers are unsupported", () => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    expect(() => registerServiceWorker()).not.toThrow();
  });

  it("does not register in dev (would shadow Vite HMR)", () => {
    vi.stubEnv("DEV", true);
    const register = vi.fn().mockResolvedValue(undefined);
    setServiceWorker({ register });
    const addSpy = vi.spyOn(window, "addEventListener");
    registerServiceWorker();
    window.dispatchEvent(new Event("load"));
    expect(register).not.toHaveBeenCalled();
    // The dev guard returns before wiring the load listener at all.
    expect(addSpy).not.toHaveBeenCalledWith("load", expect.anything());
  });

  it("registers the root-scoped worker on load in a production build", () => {
    vi.stubEnv("DEV", false);
    const register = vi.fn().mockResolvedValue(undefined);
    setServiceWorker({ register });
    registerServiceWorker();
    expect(register).not.toHaveBeenCalled(); // deferred to window 'load'
    window.dispatchEvent(new Event("load"));
    expect(register).toHaveBeenCalledWith("/sw.js");
  });

  it("swallows a failing registration (never takes down the app)", async () => {
    vi.stubEnv("DEV", false);
    const register = vi.fn().mockRejectedValue(new Error("boom"));
    setServiceWorker({ register });
    registerServiceWorker();
    expect(() => window.dispatchEvent(new Event("load"))).not.toThrow();
    await Promise.resolve();
  });
});
