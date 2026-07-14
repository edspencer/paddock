import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";

// The PWA manifest + icons are static assets under packages/web/public (served
// at the web root by fastifyStatic). These tests pin the contract issue #199
// depends on: a valid manifest with the fields browsers require to offer
// "install", and real icon files at the sizes it advertises.
// vitest runs with cwd = packages/web (its config root), so resolve from there.
const publicDir = resolve(process.cwd(), "public");

function readPublic(rel: string): Buffer {
  // rel may be root-absolute ("/icons/..") or bare ("icons/.."); strip the lead.
  return readFileSync(join(publicDir, rel.replace(/^[./]+/, "")));
}

// Minimal PNG dimension reader (IHDR is at a fixed offset in every PNG).
function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // PNG magic
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("PWA manifest", () => {
  const manifest = JSON.parse(readPublic("manifest.webmanifest").toString("utf8"));

  it("declares the fields a browser needs to offer install", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("lists 192 + 512 icons and a maskable variant", () => {
    const bySize = Object.fromEntries(manifest.icons.map((i: { sizes: string }) => [i.sizes, i]));
    expect(bySize["192x192"]).toBeDefined();
    expect(bySize["512x512"]).toBeDefined();
    const purposes = manifest.icons.map((i: { purpose?: string }) => i.purpose);
    expect(purposes).toContain("maskable");
  });

  it("points every icon at a real PNG of the advertised size", () => {
    for (const icon of manifest.icons as Array<{ src: string; sizes: string; type: string }>) {
      expect(icon.type).toBe("image/png");
      const buf = readPublic("." + icon.src); // src is root-absolute ("/icons/..")
      const [w, h] = icon.sizes.split("x").map(Number);
      expect(pngSize(buf)).toEqual({ width: w, height: h });
    }
  });

  it("ships an opaque apple-touch-icon for iOS home-screen", () => {
    expect(pngSize(readPublic("icons/apple-touch-icon.png"))).toEqual({ width: 180, height: 180 });
  });

  it("ships browser-tab favicons (16/32 PNG + a .ico for the bare request)", () => {
    expect(pngSize(readPublic("icons/favicon-32.png"))).toEqual({ width: 32, height: 32 });
    expect(pngSize(readPublic("icons/favicon-16.png"))).toEqual({ width: 16, height: 16 });
    const ico = readPublic("favicon.ico");
    // ICONDIR header: reserved=0, type=1 (icon), count>=1.
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(1);
  });
});
