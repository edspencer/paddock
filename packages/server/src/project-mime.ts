/**
 * project-mime — MIME maps + file-kind/content-type helpers for project files.
 *
 * Extracted from projects.ts (issue #403) as a zero-coupling leaf module: the
 * three extension→MIME maps plus the two pure classifiers (`fileKind` for the UI
 * renderer choice, `contentTypeFor` for the raw-byte endpoint's Content-Type).
 * Re-exported from projects.ts so existing importers keep resolving in one place.
 */
import type { FileKind } from "./project-types.js";

/**
 * Image extensions → their MIME type, for the render kind + the raw byte
 * endpoint's Content-Type (issue #61). SVG is included but is served with a
 * locked-down CSP by the byte route (it can carry scripts).
 */
export const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

/**
 * Video extensions → their MIME type, for the raw byte endpoint's Content-Type
 * (issue #126). Kept SEPARATE from IMAGE_MIME so the image file-kind classifier
 * (`fileKind`) is untouched — video only affects the content-type served, which
 * (together with HTTP range support) is what lets a `<video>` play, incl. iOS.
 */
export const VIDEO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
};

/**
 * Non-image document extensions → their MIME type. Kept SEPARATE from
 * `IMAGE_MIME` on purpose: the file-kind classifier (`fileKind`) treats every
 * `IMAGE_MIME` entry as `kind: "image"`, so a `.pdf` must not live there. It's
 * used only for the byte endpoint's Content-Type (a PDF must serve as
 * `application/pdf`, not the octet-stream the attachment store rewrites to
 * `text/plain`).
 */
export const DOCUMENT_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
};

/** Derive a render kind from a file name's extension. */
export function fileKind(name: string): FileKind {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext in IMAGE_MIME) return "image";
  return "text";
}

/** The MIME type for a file name's extension, defaulting to octet-stream. */
export function contentTypeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return (
    IMAGE_MIME[ext] ?? VIDEO_MIME[ext] ?? DOCUMENT_MIME[ext] ?? "application/octet-stream"
  );
}
