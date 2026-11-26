import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMarginFits } from "./useMarginFits";

/** An element of a settable width, and a ResizeObserver that resize() fires. */
function rig(widthPx: number) {
  const el = document.createElement("div");
  let width = widthPx;
  el.getBoundingClientRect = () => ({ width }) as DOMRect;
  const observers = new Set<() => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: () => void) {}
      observe() {
        observers.add(this.cb);
      }
      disconnect() {
        observers.delete(this.cb);
      }
    },
  );
  return {
    ref: { current: el },
    resize(next: number) {
      width = next;
      observers.forEach((cb) => cb());
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useMarginFits", () => {
  it("fits from exactly minRem wide, at the root font size", () => {
    expect(renderHook(() => useMarginFits(rig(56 * 16).ref, 56)).result.current).toBe(true);
    expect(renderHook(() => useMarginFits(rig(56 * 16 - 1).ref, 56)).result.current).toBe(false);
  });

  it("follows the element as it is resized", () => {
    const r = rig(400);
    const { result } = renderHook(() => useMarginFits(r.ref, 56));
    expect(result.current).toBe(false);
    act(() => r.resize(1200));
    expect(result.current).toBe(true);
    act(() => r.resize(800));
    expect(result.current).toBe(false);
  });

  it("does not fit when there is no element to measure", () => {
    const { result } = renderHook(() => useMarginFits({ current: null }, 56));
    expect(result.current).toBe(false);
  });
});
