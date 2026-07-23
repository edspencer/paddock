/**
 * Byte-serving HTTP helpers for the raw-file / attachment endpoints (issue #126):
 * the Content-Security-Policy chosen per MIME type and the `Range:` header parser
 * that makes an inline `<video>` play. Pure — no Fastify or route-deps ties.
 */

/**
 * The Content-Security-Policy to serve a chat attachment with, chosen from its
 * MIME type (issue #126). A media/PDF subresource gets a bare `default-src
 * 'none'` (the `sandbox` token does nothing useful for it and we don't want it
 * anywhere near `<video>` playback); everything else keeps the locked-down
 * `sandbox; default-src 'none'` that guards a directly-opened image/HTML/SVG.
 */
export function cspFor(mime: string): string {
  const base = mime.split(";")[0].trim().toLowerCase();
  if (base.startsWith("video/") || base === "application/pdf") return "default-src 'none'";
  return "sandbox; default-src 'none'";
}

/**
 * Parse an HTTP `Range` header against a known total size (issue #126). Supports
 * the single-range forms `bytes=start-`, `bytes=start-end`, and the suffix
 * `bytes=-N` (last N bytes). Returns the resolved `{ start, end }` (inclusive),
 * `"unsatisfiable"` for a malformed/out-of-bounds range (→ 416), or `null` when
 * there is no range to honor (→ serve the full body, 200).
 */
export function parseRangeHeader(
  header: string | undefined,
  total: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multi-range or a form we don't handle → fall back to 200
  const [, startStr, endStr] = m;
  if (startStr === "" && endStr === "") return null;

  let start: number;
  let end: number;
  if (startStr === "") {
    // Suffix form `bytes=-N`: the last N bytes.
    const n = Number(endStr);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? total - 1 : Math.min(Number(endStr), total - 1);
  }
  if (start > end || start >= total) return "unsatisfiable";
  return { start, end };
}
