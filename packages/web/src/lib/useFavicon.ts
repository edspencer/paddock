/**
 * Keep the tab's favicon showing this instance's brand chip (issue #958), plus
 * the live status dot when there is one (#958 part 3).
 *
 * Two stages, so a status change never re-resolves the brand and a brand change
 * never waits on a status:
 *
 *  1. RESOLVE the brand into a {@link FaviconBase} — once per name/logo/accent.
 *     - All-defaults brand (Paddock / 🐎 / default accent): `shipped`. With no
 *       status the shipped PNG links are left exactly as `index.html` has them.
 *     - Glyph logo: a chip of that glyph.
 *     - Image logo: loaded with CORS so the canvas stays readable, then a chip
 *       of it. If that can't happen the fallbacks degrade in order, none of
 *       them throwing or leaving a broken icon:
 *         a. CORS load fails, or the canvas is tainted → load it WITHOUT CORS;
 *            if that succeeds the image is fine to show, just not to composite,
 *            so the raw URL becomes the icon (`raw`). It STAYS the icon while a
 *            status is shown, with no dot: the dot needs compositing, and the
 *            tab's identity must not flip to another picture with every turn.
 *            The status is not shown at all in this case.
 *         b. The image does not load at all → a chip with the name's initial.
 *  2. APPLY base + dot. Rendered hrefs are memoised per (base, dot), so a status
 *     that flips back and forth, or a count that changes without changing the
 *     dot, never redraws the canvas. No canvas at all → the shipped icons stay
 *     (or the raw image URL); the status is not shown at all.
 *
 * Today the brand is frozen at server boot (a Config → Branding edit needs a
 * restart, then a reload), so in practice stage 1 runs once per page load; the
 * hook does not assume it.
 */
import { useEffect, useRef, useState } from "react";
import { logoIsImage, STATUS_DOT_COLORS, type Brand } from "./brand";
import { brandChipColor, chipForeground, isDefaultBrand } from "./brandChip";
import {
  FAVICON_SIZES,
  loadImage,
  renderFaviconChip,
  restoreFavicon,
  setFavicon,
  shippedIconHref,
  type ChipContent,
  type FaviconHrefs,
} from "./favicon";
import type { TabDot } from "./tabStatus";

/** Draw both rasters, or null if either cannot be drawn. */
export function renderFaviconHrefs(content: ChipContent, color: string, dot?: string): FaviconHrefs | null {
  // 3:1 — the glyph fills most of the icon; see chipForeground.
  const foreground = chipForeground(color, 3);
  const large = renderFaviconChip({ content, color, foreground, dot, size: FAVICON_SIZES.large });
  const small = large && renderFaviconChip({ content, color, foreground, dot, size: FAVICON_SIZES.small });
  return large && small ? { large, small, type: "image/png" } : null;
}

/** First character (grapheme-ish: one code point) of the name, upper-cased — the last-resort glyph. */
export function nameInitial(name: string): string {
  return (Array.from(name.trim())[0] ?? "P").toUpperCase();
}

/** What the brand resolved to (stage 1). */
export type FaviconBase =
  | { kind: "shipped" }
  | { kind: "chip"; content: ChipContent; color: string }
  /** A logo that shows but can't be composited — so it never carries a dot. */
  | { kind: "raw"; src: string };

/** Resolve the brand. Calls back once (asynchronously for an image logo) unless cancelled. */
function resolveBase(brand: Pick<Brand, "name" | "logo" | "accent">, done: (b: FaviconBase) => void): () => void {
  if (isDefaultBrand(brand)) {
    done({ kind: "shipped" });
    return () => {};
  }
  const color = brandChipColor(brand);
  const src = brand.logo.trim();
  const initial: ChipContent = { glyph: nameInitial(brand.name) };
  if (!logoIsImage(src)) {
    done({ kind: "chip", content: { glyph: src }, color });
    return () => {};
  }
  let cancelled = false;
  const settle = (b: FaviconBase) => {
    if (!cancelled) done(b);
  };
  const fallbackToRawUrl = () =>
    loadImage(src, false).then(
      () => settle({ kind: "raw", src }),
      () => settle({ kind: "chip", content: initial, color }),
    );
  loadImage(src, true).then((image) => {
    if (cancelled) return;
    // Probe-render once: a tainted canvas (or none) can't composite this image.
    if (renderFaviconChip({ content: { image }, color, size: FAVICON_SIZES.small })) {
      settle({ kind: "chip", content: { image }, color });
    } else void fallbackToRawUrl();
  }, fallbackToRawUrl);
  return () => {
    cancelled = true;
  };
}

/**
 * Render (or fetch from the per-base memo) the hrefs for base + dot. Returns
 * a promise only for the shipped base with a dot, which needs the shipped PNG
 * loaded first. `null` = restore the shipped icons.
 */
function hrefsFor(
  base: FaviconBase,
  dot: TabDot | null,
  shippedIcon: () => Promise<HTMLImageElement | null>,
): FaviconHrefs | null | Promise<FaviconHrefs | null> {
  const dotColor = dot ? STATUS_DOT_COLORS[dot] : undefined;
  switch (base.kind) {
    case "shipped":
      if (!dotColor) return null;
      return shippedIcon().then((icon) => (icon ? renderFaviconHrefs({ icon }, "transparent", dotColor) : null));
    case "chip":
      return renderFaviconHrefs(base.content, base.color, dotColor);
    case "raw":
      // No dot, by design (see the top of the file): identity beats status here.
      return { small: base.src, large: base.src };
  }
}

export function useFavicon(brand: Brand, dot: TabDot | null = null): void {
  const { name, logo, accent } = brand;
  const [base, setBase] = useState<FaviconBase | null>(null);
  // Per-base memo of rendered hrefs, keyed by dot. A WeakMap so a superseded
  // base's renders go with it.
  const memo = useRef(new WeakMap<FaviconBase, Map<string, FaviconHrefs | null>>());
  const shipped = useRef<Promise<HTMLImageElement | null> | null>(null);

  useEffect(() => resolveBase({ name, logo, accent }, setBase), [name, logo, accent]);

  useEffect(() => {
    if (!base) return;
    const key = dot ?? "none";
    let perBase = memo.current.get(base);
    if (!perBase) memo.current.set(base, (perBase = new Map()));
    const apply = (hrefs: FaviconHrefs | null) => {
      if (hrefs) setFavicon(hrefs);
      else restoreFavicon();
    };
    if (perBase.has(key)) {
      apply(perBase.get(key) ?? null);
      return;
    }
    const loadShipped = () => {
      if (!shipped.current) {
        const href = shippedIconHref();
        // Same-origin, so drawing it never taints the canvas. A FAILED load is
        // not cached: the next status change tries again (a blip mid-deploy
        // must not cost the dot for the rest of the page's life).
        const attempt: Promise<HTMLImageElement | null> = href
          ? loadImage(href, false).catch(() => {
              if (shipped.current === attempt) shipped.current = null;
              return null;
            })
          : Promise.resolve(null);
        shipped.current = attempt;
      }
      return shipped.current;
    };
    const out = hrefsFor(base, dot, loadShipped);
    if (!(out instanceof Promise)) {
      perBase.set(key, out);
      apply(out);
      return;
    }
    let cancelled = false;
    void out.then((hrefs) => {
      // Only a drawn result is memoised; a null here is a failed shipped-icon
      // load, which the next status change should retry rather than replay.
      if (hrefs) perBase.set(key, hrefs);
      if (!cancelled) apply(hrefs);
    });
    return () => {
      cancelled = true;
    };
  }, [base, dot]);

  // Put the shipped icons back when the shell unmounts (and between tests).
  useEffect(() => () => restoreFavicon(), []);
}
