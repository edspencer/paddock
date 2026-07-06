/**
 * Per-instance branding injection (issue #34).
 *
 * The SPA's look (wordmark, logo glyph, accent color) is configured per
 * instance via `PADDOCK_BRAND_*` env (see config.ts `BrandConfig`). Rather than
 * bake it in at build time — which would force one image per instance — we
 * inject it into `index.html` at serve time:
 *
 *  - a `window.__PADDOCK_CONFIG__` global the SPA reads for name + logo, and
 *  - a `:root` `<style>` overriding the `--accent*` CSS channels the buttons and
 *    logo chip use.
 *
 * Injecting into the served HTML (rather than fetching config after load) means
 * no title flash and no wrong-color flash before the first paint.
 */
import type { BrandConfig } from "./config.js";

export const DEFAULT_ACCENT = "#c2603c";

/** Parse a `#rgb` / `#rrggbb` hex color to `[r, g, b]` (0–255), or null. */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Darken an RGB triple by `factor` (0–1), rounding + clamping to 0–255. */
function darken([r, g, b]: [number, number, number], factor: number): [number, number, number] {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v * factor)));
  return [clamp(r), clamp(g), clamp(b)];
}

/** RGB triple as the space-separated channel string Tailwind's tokens expect. */
function channels([r, g, b]: [number, number, number]): string {
  return `${r} ${g} ${b}`;
}

/**
 * The `:root` accent override for a given accent color, or null when it matches
 * the default (so a default instance stays pixel-identical to the CSS defaults
 * and only genuinely-branded instances get computed hover shades). An accent
 * that doesn't parse as hex falls back to null (defaults apply).
 *
 * The 600/700 hover shades are derived by darkening — close enough to the
 * hand-tuned terracotta ramp for a hover/active state, and it means an operator
 * only has to pick ONE color.
 */
export function accentRootStyle(accent: string): string | null {
  const rgb = hexToRgb(accent);
  if (!rgb) return null;
  if (accent.trim().toLowerCase() === DEFAULT_ACCENT) return null;
  const base = channels(rgb);
  const c600 = channels(darken(rgb, 0.86));
  const c700 = channels(darken(rgb, 0.71));
  return `:root{--accent:${base};--accent-600:${c600};--accent-700:${c700};}`;
}

/** Escape a string for safe interpolation into HTML text (title). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Serialize a value to JSON safe to embed inside a <script> tag. */
function safeJson(value: unknown): string {
  // Escape `<` so a `</script>` (or `<!--`) in a value can't break out of the
  // inline script; JSON.parse is unaffected by the < escape.
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Inject branding into the built `index.html`:
 *  - replace the <title> with the configured name,
 *  - add a `window.__PADDOCK_CONFIG__` script (name + logo for the SPA),
 *  - add a `:root` accent override <style> (only when non-default).
 *
 * Everything is inserted just before `</head>` so it wins over the linked
 * stylesheet's `--accent` defaults by source order. Idempotent-ish: called once
 * at startup and the result cached.
 */
export function renderIndexHtml(rawHtml: string, brand: BrandConfig): string {
  let html = rawHtml;

  // 1. Title.
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(brand.name)}</title>`);

  // 2. Config global + accent override, injected before </head>.
  const config = safeJson({ brand: { name: brand.name, logo: brand.logo, accent: brand.accent } });
  const accentStyle = accentRootStyle(brand.accent);
  const injection =
    `<script>window.__PADDOCK_CONFIG__=${config};</script>` +
    (accentStyle ? `<style>${accentStyle}</style>` : "");

  if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, `${injection}</head>`);
  } else {
    // No </head> (unexpected) — prepend so the config is still present.
    html = injection + html;
  }
  return html;
}
