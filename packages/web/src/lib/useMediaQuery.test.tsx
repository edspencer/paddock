import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMediaQuery } from "./useMediaQuery";

/** Install a controllable `window.matchMedia` mock; returns a flip() helper. */
function mockMatchMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: initial,
    media: "",
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
  };
  window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia;
  return {
    flip(next: boolean) {
      mql.matches = next;
      listeners.forEach((l) => l());
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error — reset the mock between tests.
  delete window.matchMedia;
});

describe("useMediaQuery", () => {
  it("reports the initial match state", () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(true);
  });

  it("updates when the query starts/stops matching", () => {
    const mm = mockMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(false);
    act(() => mm.flip(true));
    expect(result.current).toBe(true);
  });

  it("defaults to false when matchMedia is unavailable (SSR/jsdom)", () => {
    // No matchMedia installed.
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(false);
  });
});
