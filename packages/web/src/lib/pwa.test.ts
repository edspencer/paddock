import { describe, it, expect, vi, afterEach } from "vitest";
import { registerServiceWorker } from "./pwa";

// registerServiceWorker guards on browser support + build mode, and (issue #221)
// reloads the tab once when a new build takes control. These tests pin those
// behaviours: never throw, skip in dev, register the root-scoped worker only in a
// production build, and reload exactly once on a genuine update (not first install).
const originalSW = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
const originalLocation = window.location;

interface SWMock {
  register: ReturnType<typeof vi.fn>;
  controller: object | null;
  fireControllerChange: () => void;
}

/** A serviceWorker mock that captures listeners so tests can drive events. */
function makeSW(opts: { controller?: object | null; register?: ReturnType<typeof vi.fn> } = {}): SWMock {
  const listeners: Record<string, Array<() => void>> = {};
  const register = opts.register ?? vi.fn().mockResolvedValue(undefined);
  const value = {
    register,
    controller: opts.controller ?? null,
    addEventListener: (type: string, fn: () => void) => {
      (listeners[type] ||= []).push(fn);
    },
  };
  Object.defineProperty(navigator, "serviceWorker", { value, configurable: true });
  return {
    register,
    get controller() {
      return value.controller;
    },
    fireControllerChange: () => (listeners["controllerchange"] || []).forEach((fn) => fn()),
  };
}

function stubReload(): ReturnType<typeof vi.fn> {
  const reload = vi.fn();
  Object.defineProperty(window, "location", { value: { reload }, configurable: true });
  return reload;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (originalSW) Object.defineProperty(navigator, "serviceWorker", originalSW);
  else delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  Object.defineProperty(window, "location", { value: originalLocation, configurable: true });
});

describe("registerServiceWorker", () => {
  it("is a no-op when service workers are unsupported", () => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    expect(() => registerServiceWorker()).not.toThrow();
  });

  it("does not register in dev (would shadow Vite HMR)", () => {
    vi.stubEnv("DEV", true);
    const sw = makeSW();
    const addSpy = vi.spyOn(window, "addEventListener");
    registerServiceWorker();
    window.dispatchEvent(new Event("load"));
    expect(sw.register).not.toHaveBeenCalled();
    // The dev guard returns before wiring the load listener at all.
    expect(addSpy).not.toHaveBeenCalledWith("load", expect.anything());
  });

  it("registers the root-scoped worker on load in a production build", () => {
    vi.stubEnv("DEV", false);
    const sw = makeSW();
    registerServiceWorker();
    expect(sw.register).not.toHaveBeenCalled(); // deferred to window 'load'
    window.dispatchEvent(new Event("load"));
    expect(sw.register).toHaveBeenCalledWith("/sw.js");
  });

  it("swallows a failing registration (never takes down the app)", async () => {
    vi.stubEnv("DEV", false);
    makeSW({ register: vi.fn().mockRejectedValue(new Error("boom")) });
    registerServiceWorker();
    expect(() => window.dispatchEvent(new Event("load"))).not.toThrow();
    await Promise.resolve();
  });

  // Invoke ONLY this registration's window `load` handler (registerServiceWorker
  // adds one each call; those leak across tests, so a global dispatch would fire
  // stale handlers too). Capture and call just the freshly-added one.
  const fireOwnLoad = () => {
    const spy = vi.spyOn(window, "addEventListener");
    registerServiceWorker();
    const handler = spy.mock.calls.find(([t]) => t === "load")?.[1] as
      | ((e: Event) => void)
      | undefined;
    handler?.(new Event("load"));
  };

  it("reloads once when a new build takes control (issue #221)", () => {
    vi.stubEnv("DEV", false);
    const reload = stubReload();
    const sw = makeSW({ controller: {} }); // a SW already controls the page at load
    fireOwnLoad();
    sw.fireControllerChange();
    expect(reload).toHaveBeenCalledTimes(1);
    // Guard against reload loops: a second controllerchange does not reload again.
    sw.fireControllerChange();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does NOT reload on the first-ever install (no prior controller)", () => {
    vi.stubEnv("DEV", false);
    const reload = stubReload();
    const sw = makeSW({ controller: null }); // first visit; claim() fires a change
    fireOwnLoad();
    sw.fireControllerChange();
    expect(reload).not.toHaveBeenCalled();
  });
});
