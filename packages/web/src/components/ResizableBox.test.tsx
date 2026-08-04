import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ResizableBox, nextHeight } from "./ResizableBox";
import { itemHeightKey, readItemHeight } from "../lib/itemHeight";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * jsdom has no layout, so `scrollHeight` is always 0 and the bounded path is
 * unreachable. This gives it just enough of the real thing to exercise #656: an
 * element whose height WE set reports that height (as a browser does for a fixed,
 * internally-scrolling box), anything else reports a tall content height. Combined
 * with a capturing `ResizeObserver` stub it reproduces the feedback loop exactly —
 * measuring the sized element re-opens the bounding decision.
 */
function fakeLayout(contentHeight: number) {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.style.height ? Number.parseInt(this.style.height, 10) : contentHeight;
  });
  const observed: Element[] = [];
  let fire = () => {};
  class FakeResizeObserver {
    constructor(cb: () => void) {
      fire = cb;
    }
    observe(el: Element) {
      observed.push(el);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  return { observed, fire: () => act(() => fire()) };
}

describe("nextHeight", () => {
  it("adds the delta within range", () => {
    expect(nextHeight(200, 40, 80, 400)).toBe(240);
    expect(nextHeight(200, -40, 80, 400)).toBe(160);
  });

  it("clamps below the minimum", () => {
    expect(nextHeight(100, -200, 80, 400)).toBe(80);
  });

  it("clamps above the maximum", () => {
    expect(nextHeight(300, 500, 80, 400)).toBe(400);
  });
});

describe("ResizableBox", () => {
  it("renders its children", () => {
    render(
      <ResizableBox itemId="t1">
        <div>hello content</div>
      </ResizableBox>,
    );
    expect(screen.getByText("hello content")).toBeInTheDocument();
  });

  it("leaves content unbounded (no handle) when there is no persisted height", () => {
    // jsdom has no layout, so natural height reads 0 → unbounded, no handle.
    render(
      <ResizableBox itemId="t1">
        <div>plain</div>
      </ResizableBox>,
    );
    expect(screen.queryByRole("slider", { name: /resize/i })).toBeNull();
  });

  it("applies a persisted height and shows a drag handle", () => {
    localStorage.setItem(itemHeightKey("t2"), "220");
    render(
      <ResizableBox itemId="t2">
        <div>bounded body</div>
      </ResizableBox>,
    );
    const handle = screen.getByRole("slider", { name: /resize/i });
    expect(handle).toBeInTheDocument();
    expect(handle.getAttribute("aria-valuenow")).toBe("220");
  });

  it("resets to the default (clears storage) on double-click of the handle", () => {
    localStorage.setItem(itemHeightKey("t3"), "300");
    render(
      <ResizableBox itemId="t3">
        <div>reset me</div>
      </ResizableBox>,
    );
    const handle = screen.getByRole("slider", { name: /resize/i });
    fireEvent.doubleClick(handle);
    expect(readItemHeight("t3")).toBeNull();
    // With the override cleared and no measurable natural height, the box falls
    // back to the unbounded path → the handle is gone.
    expect(screen.queryByRole("slider", { name: /resize/i })).toBeNull();
  });

  it("stays bounded when re-measured — never observes the element it sizes (#656)", () => {
    const { observed, fire } = fakeLayout(1679);
    render(
      <ResizableBox itemId="t5">
        <div>long body</div>
      </ResizableBox>,
    );
    // Tall content → bounded, with a handle.
    expect(screen.getByRole("slider", { name: /resize/i })).toBeInTheDocument();
    // The observed node must not be one we give a height to, or the measurement
    // is circular: it would read back 360 and unbound the box on the next frame.
    expect(observed).toHaveLength(1);
    expect(observed[0]).toBeInstanceOf(HTMLElement);
    expect((observed[0] as HTMLElement).style.height).toBe("");
    // Re-measuring (a real ResizeObserver fires as fonts/highlighting settle)
    // must be a no-op, not a flip. Before #656 the handle vanished here, and the
    // next measurement brought it back, once per frame, forever.
    fire();
    fire();
    expect(screen.getByRole("slider", { name: /resize/i })).toBeInTheDocument();
    expect(screen.getByText("long body")).toBeInTheDocument();
  });

  it("keeps the children mounted across the bounded/unbounded switch (#644)", () => {
    fakeLayout(1679);
    let mounts = 0;
    function CountMounts() {
      // A remount resets component state; `useState`'s initialiser runs once per
      // mount, which is exactly what an async Mermaid render cannot survive.
      useState(() => {
        mounts += 1;
        return null;
      });
      return <div>counted</div>;
    }
    render(
      <ResizableBox itemId="t6">
        <CountMounts />
      </ResizableBox>,
    );
    // One mount for the unbounded first paint, and the switch to bounded must
    // re-render rather than remount.
    expect(mounts).toBe(1);
    expect(screen.getByRole("slider", { name: /resize/i })).toBeInTheDocument();
  });

  it("nudges + persists the height with the arrow keys", () => {
    localStorage.setItem(itemHeightKey("t4"), "200");
    render(
      <ResizableBox itemId="t4">
        <div>keyboard</div>
      </ResizableBox>,
    );
    const handle = screen.getByRole("slider", { name: /resize/i });
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    // 200 - 24 step = 176, persisted immediately.
    expect(readItemHeight("t4")).toBe(176);
  });
});
