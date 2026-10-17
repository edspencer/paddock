import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  areaCollapsedKey,
  readAreaCollapsed,
  subscribeAreaCollapsed,
  writeAreaCollapsed,
} from "./areaCollapsed";

beforeEach(() => localStorage.clear());

describe("areaCollapsed store", () => {
  it("keeps the grid's pre-existing key and values, so old folds survive", () => {
    expect(areaCollapsedKey("homelab")).toBe("paddock:area-collapsed:homelab");
    // Unsorted's slug is "" — stored under a readable name, as the grid did.
    expect(areaCollapsedKey("")).toBe("paddock:area-collapsed:unsorted");
    localStorage.setItem("paddock:area-collapsed:homelab", "1");
    expect(readAreaCollapsed("homelab")).toBe(true);
    writeAreaCollapsed("homelab", false);
    expect(localStorage.getItem("paddock:area-collapsed:homelab")).toBe("0");
  });

  it("reads anything but '1' as expanded", () => {
    expect(readAreaCollapsed("never-set")).toBe(false);
    localStorage.setItem(areaCollapsedKey("x"), "garbage");
    expect(readAreaCollapsed("x")).toBe(false);
  });

  it("notifies every subscriber in this tab on a write", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeAreaCollapsed(a);
    const offB = subscribeAreaCollapsed(b);
    writeAreaCollapsed("homelab", true);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    writeAreaCollapsed("homelab", false);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    offB();
  });

  it("notifies on another tab's write to an area key, and ignores other keys", () => {
    const cb = vi.fn();
    const off = subscribeAreaCollapsed(cb);
    window.dispatchEvent(new StorageEvent("storage", { key: "paddock:draft:x" }));
    expect(cb).not.toHaveBeenCalled();
    window.dispatchEvent(new StorageEvent("storage", { key: areaCollapsedKey("house") }));
    expect(cb).toHaveBeenCalledTimes(1);
    // A `localStorage.clear()` elsewhere arrives with a null key.
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(cb).toHaveBeenCalledTimes(2);
    off();
  });

  it("survives a throwing localStorage (private mode) as expanded", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readAreaCollapsed("homelab")).toBe(false);
    expect(() => writeAreaCollapsed("homelab", true)).not.toThrow();
    get.mockRestore();
    set.mockRestore();
  });
});
