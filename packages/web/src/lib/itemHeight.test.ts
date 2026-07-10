import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearItemHeight,
  itemHeightKey,
  readItemHeight,
  writeItemHeight,
} from "./itemHeight";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("itemHeight", () => {
  it("namespaces the key by item id", () => {
    expect(itemHeightKey("abc")).toBe("paddock:itemHeight:abc");
  });

  it("round-trips a written height", () => {
    writeItemHeight("t1", 240);
    expect(readItemHeight("t1")).toBe(240);
  });

  it("rounds a fractional height to whole px", () => {
    writeItemHeight("t1", 240.7);
    expect(readItemHeight("t1")).toBe(241);
  });

  it("returns null when nothing is stored", () => {
    expect(readItemHeight("missing")).toBeNull();
  });

  it("returns null for a non-numeric / invalid stored value", () => {
    localStorage.setItem(itemHeightKey("bad"), "not-a-number");
    expect(readItemHeight("bad")).toBeNull();
  });

  it("treats a stored non-positive height as no preference", () => {
    localStorage.setItem(itemHeightKey("zero"), "0");
    expect(readItemHeight("zero")).toBeNull();
    localStorage.setItem(itemHeightKey("neg"), "-50");
    expect(readItemHeight("neg")).toBeNull();
  });

  it("removes the key when writing a non-positive / NaN height", () => {
    writeItemHeight("t1", 200);
    writeItemHeight("t1", 0);
    expect(readItemHeight("t1")).toBeNull();
    writeItemHeight("t1", 200);
    writeItemHeight("t1", Number.NaN);
    expect(readItemHeight("t1")).toBeNull();
  });

  it("clears a stored height", () => {
    writeItemHeight("t1", 200);
    clearItemHeight("t1");
    expect(readItemHeight("t1")).toBeNull();
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
    expect(readItemHeight("t1")).toBeNull();
    expect(() => writeItemHeight("t1", 200)).not.toThrow();
    expect(() => clearItemHeight("t1")).not.toThrow();
  });
});
