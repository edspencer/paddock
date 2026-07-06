import { describe, it, expect, afterEach } from "vitest";
import { getBrand, logoIsImage, DEFAULT_BRAND } from "./brand";

type WithConfig = { __PADDOCK_CONFIG__?: unknown };

afterEach(() => {
  delete (globalThis as WithConfig).__PADDOCK_CONFIG__;
});

describe("getBrand", () => {
  it("returns the defaults when no config is injected", () => {
    expect(getBrand()).toEqual(DEFAULT_BRAND);
  });

  it("merges an injected brand over the defaults", () => {
    (globalThis as WithConfig).__PADDOCK_CONFIG__ = { brand: { name: "Homelab", logo: "🏠" } };
    expect(getBrand()).toEqual({ name: "Homelab", logo: "🏠", accent: DEFAULT_BRAND.accent });
  });

  it("ignores a malformed / empty config", () => {
    (globalThis as WithConfig).__PADDOCK_CONFIG__ = {};
    expect(getBrand()).toEqual(DEFAULT_BRAND);
  });
});

describe("logoIsImage", () => {
  it("treats http(s) URLs and absolute paths as images", () => {
    expect(logoIsImage("https://example.com/logo.png")).toBe(true);
    expect(logoIsImage("http://x/y.svg")).toBe(true);
    expect(logoIsImage("/brand/logo.svg")).toBe(true);
  });

  it("treats emoji / glyphs as text", () => {
    expect(logoIsImage("🐎")).toBe(false);
    expect(logoIsImage("P")).toBe(false);
    expect(logoIsImage("logo.png")).toBe(false); // relative, not a URL/abs path
  });
});
