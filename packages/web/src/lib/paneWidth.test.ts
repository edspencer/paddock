import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHATLIST_PANE,
  SIDENAV_PANE,
  clampWidth,
  clearPaneWidth,
  nextWidth,
  readPaneWidth,
  writePaneWidth,
} from "./paneWidth";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("paneWidth", () => {
  it("clamps a width to the pane's [min, max]", () => {
    expect(clampWidth(SIDENAV_PANE, 10)).toBe(SIDENAV_PANE.min);
    expect(clampWidth(SIDENAV_PANE, 9999)).toBe(SIDENAV_PANE.max);
    expect(clampWidth(SIDENAV_PANE, 320)).toBe(320);
  });

  it("computes the next drag width as start + delta, clamped", () => {
    expect(nextWidth(300, 40, SIDENAV_PANE)).toBe(340);
    expect(nextWidth(300, -1000, SIDENAV_PANE)).toBe(SIDENAV_PANE.min);
    expect(nextWidth(300, 1000, SIDENAV_PANE)).toBe(SIDENAV_PANE.max);
  });

  it("round-trips a written width", () => {
    writePaneWidth(CHATLIST_PANE, 300);
    expect(readPaneWidth(CHATLIST_PANE)).toBe(300);
  });

  it("clamps on write so an out-of-range value can never be stored", () => {
    writePaneWidth(SIDENAV_PANE, 9999);
    expect(readPaneWidth(SIDENAV_PANE)).toBe(SIDENAV_PANE.max);
    writePaneWidth(SIDENAV_PANE, 1);
    expect(readPaneWidth(SIDENAV_PANE)).toBe(SIDENAV_PANE.min);
  });

  it("clamps on read too (tolerates a stale/hand-edited value)", () => {
    localStorage.setItem("paddock:panewidth:sidenav", "10000");
    expect(readPaneWidth(SIDENAV_PANE)).toBe(SIDENAV_PANE.max);
  });

  it("returns null when nothing is stored or the value is non-numeric", () => {
    expect(readPaneWidth(SIDENAV_PANE)).toBeNull();
    localStorage.setItem("paddock:panewidth:sidenav", "wide");
    expect(readPaneWidth(SIDENAV_PANE)).toBeNull();
  });

  it("namespaces the two panes independently", () => {
    writePaneWidth(SIDENAV_PANE, 300);
    writePaneWidth(CHATLIST_PANE, 400);
    expect(readPaneWidth(SIDENAV_PANE)).toBe(300);
    expect(readPaneWidth(CHATLIST_PANE)).toBe(400);
  });

  it("clears a stored width", () => {
    writePaneWidth(SIDENAV_PANE, 300);
    clearPaneWidth(SIDENAV_PANE);
    expect(readPaneWidth(SIDENAV_PANE)).toBeNull();
  });

  it("never throws when localStorage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readPaneWidth(SIDENAV_PANE)).toBeNull();
    expect(() => writePaneWidth(SIDENAV_PANE, 300)).not.toThrow();
    expect(() => clearPaneWidth(SIDENAV_PANE)).not.toThrow();
  });
});
