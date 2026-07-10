import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ResizableBox, nextHeight } from "./ResizableBox";
import { itemHeightKey, readItemHeight } from "../lib/itemHeight";

afterEach(() => {
  localStorage.clear();
});

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
