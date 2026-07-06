/**
 * Unit tests for the branding injection (brand.ts, issue #34): hex parsing, the
 * accent `:root` override (with default-skip + non-hex fallback), and the
 * index.html renderer (title replace, config global, accent style, and
 * </script>-breakout escaping).
 */
import { describe, it, expect } from "vitest";
import { hexToRgb, accentRootStyle, renderIndexHtml, DEFAULT_ACCENT } from "../../src/brand.js";
import type { BrandConfig } from "../../src/config.js";

const RAW_HTML =
  "<!doctype html><html><head><title>Paddock</title></head><body><div id=root></div></body></html>";

function brand(over: Partial<BrandConfig> = {}): BrandConfig {
  return { name: "Paddock", logo: "🐎", accent: DEFAULT_ACCENT, ...over };
}

describe("hexToRgb", () => {
  it("parses #rrggbb", () => {
    expect(hexToRgb("#c2603c")).toEqual([194, 96, 60]);
  });
  it("parses shorthand #rgb", () => {
    expect(hexToRgb("#fff")).toEqual([255, 255, 255]);
  });
  it("tolerates a missing # and whitespace", () => {
    expect(hexToRgb("  c2603c ")).toEqual([194, 96, 60]);
  });
  it("returns null for a non-hex color", () => {
    expect(hexToRgb("rebeccapurple")).toBeNull();
    expect(hexToRgb("rgb(1,2,3)")).toBeNull();
    expect(hexToRgb("#12")).toBeNull();
  });
});

describe("accentRootStyle", () => {
  it("returns null for the default accent (CSS defaults stay authoritative)", () => {
    expect(accentRootStyle(DEFAULT_ACCENT)).toBeNull();
    expect(accentRootStyle("#C2603C")).toBeNull(); // case-insensitive
  });
  it("returns null for a non-hex accent (falls back to defaults)", () => {
    expect(accentRootStyle("rebeccapurple")).toBeNull();
  });
  it("emits channel triples + darkened hover shades for a custom accent", () => {
    const style = accentRootStyle("#3366cc");
    expect(style).toContain("--accent:51 102 204;");
    // 600 = darken(0.86): round(51*.86)=44, round(102*.86)=88, round(204*.86)=175
    expect(style).toContain("--accent-600:44 88 175;");
    // 700 = darken(0.71): round(51*.71)=36, round(102*.71)=72, round(204*.71)=145
    expect(style).toContain("--accent-700:36 72 145;");
    expect(style?.startsWith(":root{")).toBe(true);
  });
});

describe("renderIndexHtml", () => {
  it("replaces the <title> with the brand name", () => {
    const out = renderIndexHtml(RAW_HTML, brand({ name: "Homelab" }));
    expect(out).toContain("<title>Homelab</title>");
    expect(out).not.toContain("<title>Paddock</title>");
  });

  it("injects the config global with name + logo before </head>", () => {
    const out = renderIndexHtml(RAW_HTML, brand({ name: "Homelab", logo: "🏠" }));
    expect(out).toContain("window.__PADDOCK_CONFIG__=");
    const idx = out.indexOf("window.__PADDOCK_CONFIG__=");
    expect(out.indexOf("</head>")).toBeGreaterThan(idx); // injected before </head>
    const json = JSON.parse(
      out.slice(out.indexOf("=", idx) + 1, out.indexOf(";</script>", idx)),
    );
    expect(json).toEqual({ brand: { name: "Homelab", logo: "🏠", accent: DEFAULT_ACCENT } });
  });

  it("injects an accent <style> only for a non-default accent", () => {
    expect(renderIndexHtml(RAW_HTML, brand())).not.toContain("<style>");
    const branded = renderIndexHtml(RAW_HTML, brand({ accent: "#3366cc" }));
    expect(branded).toContain("<style>:root{--accent:51 102 204;");
  });

  it("escapes a </script> in a brand value so it can't break out of the script", () => {
    const out = renderIndexHtml(RAW_HTML, brand({ name: "</script><script>alert(1)</script>" }));
    // The raw closing tag must not appear inside the injected config script.
    const cfgStart = out.indexOf("window.__PADDOCK_CONFIG__=");
    const cfgEnd = out.indexOf(";</script>", cfgStart);
    expect(out.slice(cfgStart, cfgEnd)).not.toContain("</script>");
    expect(out.slice(cfgStart, cfgEnd)).toContain("\\u003c/script>");
    // And the <title> gets HTML-escaped, not left as raw tags.
    expect(out).toContain("<title>&lt;/script&gt;");
  });

  it("still injects config when there is no </head> (degenerate input)", () => {
    const out = renderIndexHtml("<html><body>x</body></html>", brand({ name: "X" }));
    expect(out).toContain("window.__PADDOCK_CONFIG__=");
  });
});
