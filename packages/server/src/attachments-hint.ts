/**
 * The composer-attachment "hint" wrapper for issue #328 Phase 1.
 *
 * On a turn that carries uploaded files, the server prepends a delimited block to
 * the prompt string — exactly like the `<project-context>` preload wrapper
 * (preload.ts) — telling the keeper which files were attached and pointing its
 * `Read` tool at their absolute paths (native vision on images/PDFs). The block
 * is single-sourced HERE so the WS layer that BUILDS it and the web that STRIPS +
 * PARSES it (for the transcript chips) can't drift.
 *
 *   <paddock-attachments>
 *   The user attached these files. Use the Read tool to view images and PDFs;
 *   each line is: id \t kind \t filename \t absolute-path.
 *   <id>\t<kind>\t<filename>\t<abs path>
 *   …
 *   </paddock-attachments>
 *
 *   <the user's actual message>
 *
 * Both audiences read the same block: the keeper reads the human header + the
 * visible absolute path in each line; the web parses the tab-delimited lines to
 * rebuild image thumbnails / file chips from the attachment store on reload. The
 * cleanup-on-delete path also parses it (via {@link parseAttachmentIds}) so an
 * uploaded file's bytes are removed with its chat.
 *
 * The wrapper nests INSIDE the preload wrapper when both apply (attachments wrap
 * the user's message first, then preload wraps the whole thing), so stripping the
 * attachment block yields the same clean request the preload strip already
 * expects.
 */
import { extname } from "node:path";

/** The renderer hint carried per attachment (a subset of send_file's kinds). */
export type AttachmentKind =
  | "image"
  | "video"
  | "pdf"
  | "markdown"
  | "code"
  | "text"
  | "html"
  | "file";

export const ATTACHMENTS_OPEN = "<paddock-attachments>";
export const ATTACHMENTS_CLOSE = "</paddock-attachments>";
/** The literal boundary between the attachment block and the user's real request. */
export const ATTACHMENTS_REQUEST_MARKER = `${ATTACHMENTS_CLOSE}\n\n`;

const HEADER =
  "The user attached these files. Use the Read tool to view images and PDFs; " +
  "each line is: id\\tkind\\tfilename\\tabsolute-path.";

/** One attachment as the server knows it when building the prompt block. */
export interface PromptAttachment {
  /** Opaque attachment-store id (`<uuid><ext>`), also the basename of `path`. */
  id: string;
  /** Original display filename (as uploaded). */
  filename: string;
  /** Renderer hint. */
  kind: AttachmentKind;
  /** Absolute path to the stored bytes, so the keeper's Read tool can open it. */
  path: string;
}

/** A parsed attachment ref for the web (no absolute path — it fetches by id). */
export interface ParsedAttachment {
  id: string;
  filename: string;
  kind: AttachmentKind;
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".heic"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v"]);
const PDF_EXT = new Set([".pdf"]);
const MARKDOWN_EXT = new Set([".md", ".mdx", ".markdown"]);
const HTML_EXT = new Set([".html", ".htm"]);
const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs",
  ".java", ".c", ".h", ".cpp", ".cc", ".cs", ".php", ".swift", ".kt", ".sh",
  ".bash", ".zsh", ".sql", ".json", ".yaml", ".yml", ".toml", ".css", ".scss",
  ".xml",
]);
const TEXT_EXT = new Set([".txt", ".text", ".log", ".csv", ".tsv", ".env", ".ini"]);

/**
 * Infer a renderer {@link AttachmentKind} from a filename. Images/videos/PDFs get
 * rich rendering; source/markup/text get a typed chip; everything else is a
 * generic `file`. IMAGE is tested before VIDEO so `.webp` (image) never collides
 * with `.webm` (video).
 */
export function inferAttachmentKind(filename: string, mime?: string): AttachmentKind {
  const ext = extname(filename).toLowerCase();
  if (IMAGE_EXT.has(ext) || (mime ?? "").startsWith("image/")) return "image";
  if (VIDEO_EXT.has(ext) || (mime ?? "").startsWith("video/")) return "video";
  if (PDF_EXT.has(ext) || mime === "application/pdf") return "pdf";
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (HTML_EXT.has(ext)) return "html";
  if (CODE_EXT.has(ext)) return "code";
  if (TEXT_EXT.has(ext) || (mime ?? "").startsWith("text/")) return "text";
  return "file";
}

/** A tab or newline in a field would corrupt the block; collapse to a space. */
function sanitizeField(s: string): string {
  return s.replace(/[\t\r\n]+/g, " ").trim();
}

/**
 * Build the attachment-wrapped prompt. Returns `message` unchanged when there are
 * no attachments, so the caller can always wrap unconditionally.
 */
export function wrapAttachments(attachments: PromptAttachment[], message: string): string {
  if (attachments.length === 0) return message;
  const lines = attachments.map(
    (a) => `${a.id}\t${a.kind}\t${sanitizeField(a.filename)}\t${a.path}`,
  );
  return `${ATTACHMENTS_OPEN}\n${HEADER}\n${lines.join("\n")}\n${ATTACHMENTS_REQUEST_MARKER}${message}`;
}

/**
 * Parse a (possibly) attachment-wrapped message into its attachment refs + the
 * user's real request. If `text` isn't wrapped it's returned unchanged with an
 * empty list. The block may be nested inside a preload wrapper, so we locate it
 * anywhere in `text` rather than only at the very start.
 */
export function parseAttachmentsWrapper(text: string): {
  attachments: ParsedAttachment[];
  message: string;
} {
  const open = text.indexOf(ATTACHMENTS_OPEN);
  if (open === -1) return { attachments: [], message: text };
  const bodyStart = open + ATTACHMENTS_OPEN.length;
  const close = text.indexOf(ATTACHMENTS_CLOSE, bodyStart);
  if (close === -1) return { attachments: [], message: text };
  const body = text.slice(bodyStart, close);
  const attachments: ParsedAttachment[] = [];
  for (const line of body.split("\n")) {
    const parts = line.split("\t");
    // A data line is `id \t kind \t filename [\t path]`. The header line has no
    // tabs, so it's naturally skipped.
    if (parts.length < 3) continue;
    const [id, kind, filename] = parts;
    if (!id || !filename) continue;
    attachments.push({
      id: id.trim(),
      filename: filename.trim(),
      kind: (kind.trim() || "file") as AttachmentKind,
    });
  }
  // Strip the whole block to recover the user's clean request: everything before
  // the open tag + everything after the close marker. (Anything before the open
  // tag is a preload wrapper we deliberately leave intact — existing behavior.)
  const before = text.slice(0, open);
  const afterClose = close + ATTACHMENTS_CLOSE.length;
  const after = text.startsWith(ATTACHMENTS_REQUEST_MARKER, close)
    ? text.slice(close + ATTACHMENTS_REQUEST_MARKER.length)
    : text.slice(afterClose).replace(/^\n+/, "");
  return { attachments, message: before + after };
}

/** Just the attachment ids referenced by a wrapped message (cleanup-on-delete). */
export function parseAttachmentIds(text: string): string[] {
  return parseAttachmentsWrapper(text).attachments.map((a) => a.id);
}

/**
 * Recover the user's real request from a (possibly) attachment-wrapped message —
 * the clean text with the `<paddock-attachments>` block removed. Used for chat
 * display-name derivation (mirrors {@link import("./preload.js").stripPreloadWrapper}).
 */
export function stripAttachmentsWrapper(text: string): string {
  return parseAttachmentsWrapper(text).message;
}
