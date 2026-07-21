import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PaneResizer, usePaneWidth } from "./PaneResizer";
import { SIDENAV_PANE, readPaneWidth } from "../lib/paneWidth";

/** Controllable `window.matchMedia` so we can render desktop vs mobile. */
function mockMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn(() => ({
    matches,
    media: "",
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  // @ts-expect-error — reset the mock between tests.
  delete window.matchMedia;
});

describe("PaneResizer (controlled handle)", () => {
  const noop = () => {};

  it("exposes an accessible vertical separator with value bounds", () => {
    render(
      <PaneResizer
        spec={SIDENAV_PANE}
        width={300}
        onPreview={noop}
        onCommit={noop}
        onReset={noop}
        label="Resize sidebar"
      />,
    );
    const sep = screen.getByRole("separator", { name: "Resize sidebar" });
    expect(sep).toHaveAttribute("aria-orientation", "vertical");
    expect(sep).toHaveAttribute("aria-valuenow", "300");
    expect(sep).toHaveAttribute("aria-valuemin", String(SIDENAV_PANE.min));
    expect(sep).toHaveAttribute("aria-valuemax", String(SIDENAV_PANE.max));
  });

  it("nudges width with Arrow keys (preview + commit), clamped", () => {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    render(
      <PaneResizer
        spec={SIDENAV_PANE}
        width={300}
        onPreview={onPreview}
        onCommit={onCommit}
        onReset={noop}
        label="Resize sidebar"
      />,
    );
    const sep = screen.getByRole("separator", { name: "Resize sidebar" });
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(onPreview).toHaveBeenCalledWith(316);
    expect(onCommit).toHaveBeenCalledWith(316);
    fireEvent.keyDown(sep, { key: "ArrowLeft" });
    expect(onCommit).toHaveBeenCalledWith(284);
  });

  it("resets on double-click", () => {
    const onReset = vi.fn();
    render(
      <PaneResizer
        spec={SIDENAV_PANE}
        width={300}
        onPreview={noop}
        onCommit={noop}
        onReset={onReset}
        label="Resize sidebar"
      />,
    );
    fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize sidebar" }));
    expect(onReset).toHaveBeenCalled();
  });
});

// A harness that wires usePaneWidth to the handle, exposing the resolved width
// and inline style so we can assert the desktop-only behavior end-to-end.
function Harness() {
  const p = usePaneWidth(SIDENAV_PANE);
  return (
    <div>
      <span data-testid="width">{p.width}</span>
      <span data-testid="style">{p.style ? String(p.style.width) : "none"}</span>
      <PaneResizer
        spec={p.spec}
        width={p.width}
        onPreview={p.preview}
        onCommit={p.commit}
        onReset={p.reset}
        label="Resize sidebar"
      />
    </div>
  );
}

describe("usePaneWidth", () => {
  it("applies an inline width only on desktop", () => {
    mockMatchMedia(true);
    render(<Harness />);
    expect(screen.getByTestId("width").textContent).toBe(String(SIDENAV_PANE.def));
    expect(screen.getByTestId("style").textContent).toBe(String(SIDENAV_PANE.def));
  });

  it("omits the inline width on mobile (CSS drawer width wins)", () => {
    mockMatchMedia(false);
    render(<Harness />);
    expect(screen.getByTestId("style").textContent).toBe("none");
  });

  it("persists a keyboard-nudged width and re-reads it", () => {
    mockMatchMedia(true);
    render(<Harness />);
    const sep = screen.getByRole("separator", { name: "Resize sidebar" });
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(screen.getByTestId("width").textContent).toBe(String(SIDENAV_PANE.def + 16));
    expect(readPaneWidth(SIDENAV_PANE)).toBe(SIDENAV_PANE.def + 16);
  });

  it("reset (double-click) forgets the persisted width", () => {
    mockMatchMedia(true);
    render(<Harness />);
    const sep = screen.getByRole("separator", { name: "Resize sidebar" });
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(readPaneWidth(SIDENAV_PANE)).toBe(SIDENAV_PANE.def + 16);
    fireEvent.doubleClick(sep);
    expect(readPaneWidth(SIDENAV_PANE)).toBeNull();
    expect(screen.getByTestId("width").textContent).toBe(String(SIDENAV_PANE.def));
  });
});
