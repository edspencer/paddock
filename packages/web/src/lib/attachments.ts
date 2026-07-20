// Client-side helpers for composer attachments (issue #328).
//
// Mirrors the server's `<paddock-attachments>` prompt wrapper (server
// attachments-hint.ts): the server prepends a delimited block carrying each
// uploaded file's id/kind/filename to the user's message. On reload the user
// turn's content is that raw wrapped string, so we STRIP the block (for a clean
// bubble) and PARSE it (to re-render thumbnails/chips from `/api/chat-files/:id`).
import type { AttachmentKind, AttachmentRef } from "./types";

export const ATTACHMENTS_OPEN = "<paddock-attachments>";
export const ATTACHMENTS_CLOSE = "</paddock-attachments>";
const REQUEST_MARKER = `${ATTACHMENTS_CLOSE}\n\n`;

/** The raw-bytes URL an uploaded attachment renders from (image src / link href). */
export function attachmentRawUrl(id: string): string {
  return `/api/chat-files/${encodeURIComponent(id)}`;
}

/**
 * Parse a (possibly) attachment-wrapped message into its refs + the user's clean
 * request. If `content` isn't wrapped it's returned unchanged with an empty list.
 * The block may be nested inside a preload wrapper, so it's located anywhere in
 * `content` (matching the server parser).
 */
export function parseAttachments(content: string): {
  attachments: AttachmentRef[];
  text: string;
} {
  const open = content.indexOf(ATTACHMENTS_OPEN);
  if (open === -1) return { attachments: [], text: content };
  const bodyStart = open + ATTACHMENTS_OPEN.length;
  const close = content.indexOf(ATTACHMENTS_CLOSE, bodyStart);
  if (close === -1) return { attachments: [], text: content };
  const body = content.slice(bodyStart, close);
  const attachments: AttachmentRef[] = [];
  for (const line of body.split("\n")) {
    const parts = line.split("\t");
    // A data line is `id \t kind \t filename [\t path]`; the header has no tabs.
    if (parts.length < 3) continue;
    const [id, kind, filename] = parts;
    if (!id?.trim() || !filename?.trim()) continue;
    attachments.push({
      id: id.trim(),
      kind: (kind?.trim() || "file") as AttachmentKind,
      filename: filename.trim(),
    });
  }
  // Strip the block: everything before the open tag + everything after the close
  // marker. Anything before the open tag (e.g. a preload wrapper) is left intact.
  const before = content.slice(0, open);
  const after = content.startsWith(REQUEST_MARKER, close)
    ? content.slice(close + REQUEST_MARKER.length)
    : content.slice(close + ATTACHMENTS_CLOSE.length).replace(/^\n+/, "");
  return { attachments, text: before + after };
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

/** Lower-cased extension WITH the dot (`.png`), or "" when there's none. */
function extOf(filename: string): string {
  const base = filename.slice(filename.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** Infer a renderer {@link AttachmentKind} from a filename (client-side, for a File pick). */
export function inferAttachmentKind(filename: string, mime?: string): AttachmentKind {
  const ext = extOf(filename);
  if (IMAGE_EXT.has(ext) || (mime ?? "").startsWith("image/")) return "image";
  if (VIDEO_EXT.has(ext) || (mime ?? "").startsWith("video/")) return "video";
  if (PDF_EXT.has(ext) || mime === "application/pdf") return "pdf";
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (HTML_EXT.has(ext)) return "html";
  if (CODE_EXT.has(ext)) return "code";
  if (TEXT_EXT.has(ext) || (mime ?? "").startsWith("text/")) return "text";
  return "file";
}

/** Human-readable byte size for a chip label (e.g. "2.4 MB", "812 KB", "40 B"). */
export function formatFileSize(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * Build an `<input accept>` hint from an allowedTypes list. `["*"]` (allow-all)
 * yields "" (no restriction). MIME patterns pass through; extension entries pass
 * through as-is (`.pdf`). A hygiene/UX hint only — the server is authoritative.
 */
export function acceptAttribute(allowedTypes: string[]): string {
  if (allowedTypes.some((t) => t === "*" || t === "*/*")) return "";
  return allowedTypes.filter((t) => t && t !== "*").join(",");
}

/**
 * Client-side type check mirroring the server's `isTypeAllowed` (UX guardrail
 * only). A file is allowed if its MIME matches a MIME-pattern entry OR its
 * extension matches an extension entry; `"*"`/`"*​/*"` allows everything.
 */
export function isTypeAllowed(
  allowedTypes: string[],
  mime: string | undefined,
  filename: string | undefined,
): boolean {
  const m = (mime ?? "").trim().toLowerCase();
  const ext = extOf(filename ?? "");
  for (const raw of allowedTypes) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*" || entry === "*/*") return true;
    if (entry.includes("/")) {
      if (!m) continue;
      const [pType, pSub] = entry.split("/", 2);
      const [mType, mSub] = m.split("/", 2);
      if ((pType === "*" || pType === mType) && (pSub === "*" || pSub === mSub)) return true;
    } else if (entry.startsWith(".")) {
      if (ext && ext === entry) return true;
    } else if (ext && ext === `.${entry}`) {
      return true;
    }
  }
  return false;
}
