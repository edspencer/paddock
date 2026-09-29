import { useContext, useEffect, useState } from "react";
import type { SentFile, SentFileKind } from "../lib/types";
import { SentFileViewerContext } from "./chat/chatContexts";
import { CodeBlock } from "./CodeBlock";
import { Markdown } from "./Markdown";
import { Mermaid } from "./Mermaid";
import { ResizableBox } from "./ResizableBox";
import { InlineImage } from "./MediaImage";
import { PdfEmbed } from "./PdfEmbed";
import { AlertIcon } from "./icons";

/**
 * Renders a file the agent sent via `mcp__paddock__send_file` (issue #112).
 * Reuses the same primitives as the Files tab (`Markdown` with live Mermaid, a
 * sandboxed iframe for HTML) inside a filename-header "editor" chrome.
 *
 * Two sources:
 *  - inline/virtual → the content is carried in the tool-call envelope and
 *    rendered directly (survives reload because it's in the transcript output).
 *  - file → the envelope carries only a path; the bytes load on demand from
 *    Paddock's sandboxed endpoint (`file.rawUrl`), live and after a reload.
 *
 * Expanded by default, with a collapse toggle (unlike the generic tool widget,
 * which starts collapsed — a sent file is the point, so we lead with it).
 *
 * Inside a chat, the header's Maximize button (and a click on an image) opens
 * the chat-wide viewer (#944), which steps through every sent file with ←/→.
 * `turnId` is what the viewer keys on and scrolls back to; without the viewer
 * context (a test, or any non-chat host) the button is simply absent and an
 * image keeps its own single-image lightbox.
 */
export function SentFileBlock({ file, turnId }: { file: SentFile; turnId?: string }) {
  const [open, setOpen] = useState(true);
  const viewer = useContext(SentFileViewerContext);
  const maximize = viewer && turnId ? () => viewer.open(turnId, file) : undefined;
  // Stable, reload-safe key for persisting this embed's height (#136).
  const itemId = sentFileStableKey(file);
  return (
    <div className="flex animate-fade-in justify-start" data-sent-file-turn={turnId}>
      <div className="w-full max-w-[92%] overflow-hidden rounded-2xl rounded-bl-md bg-surface-raised shadow-sm ring-1 ring-edge">
        <div className="flex items-stretch border-b border-edge bg-surface-sunken text-2xs text-fg-muted">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-2 px-4 py-2 text-left"
          >
            <Chevron open={open} />
            <FileIcon />
            <span className="truncate font-mono text-fg-muted">{file.filename}</span>
            <span className="ml-auto uppercase tracking-wide text-3xs text-fg-subtle">
              {file.language ?? file.kind}
            </span>
          </button>
          {maximize ? (
            <button
              type="button"
              onClick={maximize}
              aria-label={`Maximize ${file.filename}`}
              title="Maximize"
              className="flex items-center px-3 text-fg-subtle motion-fast transition-colors hover:bg-surface-hover hover:text-fg"
            >
              <MaximizeIcon />
            </button>
          ) : null}
        </div>
        {file.message ? (
          <div className="border-b border-edge-subtle px-4 py-2 text-xs text-fg-muted">
            {file.message}
          </div>
        ) : null}
        {open ? <SentFileBody file={file} itemId={itemId} onMaximize={maximize} /> : null}
      </div>
    </div>
  );
}

/**
 * A stable, reload-safe key identifying THIS sent file, for persisting per-embed
 * UI state (issue #136). A real-file send's `rawUrl` embeds its immutable
 * attachment id (byte-for-byte identical live and after a reload); an inline
 * send is keyed on a hash of its filename + kind + content. Deliberately NOT the
 * transcript `turn.id`: a freshly-sent (live) turn is assigned an ephemeral
 * counter id that differs from the stable uuid it's rebuilt with on reload, so a
 * height set live would be orphaned on reload — whereas the file's own identity
 * is stable across both.
 */
export function sentFileStableKey(file: SentFile): string {
  if (file.source === "file" && file.rawUrl) return `file:${file.rawUrl}`;
  return `inline:${djb2(`${file.filename}\u0000${file.kind}\u0000${file.content ?? ""}`)}`;
}

/** Small deterministic non-crypto string hash (djb2) — stable across reloads. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * A sent file's content, by kind. Also rendered by the full-screen viewer
 * (#944) with `fill` set, which drops the inline height bounds so the content
 * takes the viewer's panel instead.
 */
export function SentFileBody({
  file,
  itemId,
  onMaximize,
  fill = false,
}: {
  file: SentFile;
  itemId?: string;
  /** Hand an image click to the chat viewer instead of the image's own lightbox. */
  onMaximize?: () => void;
  fill?: boolean;
}) {
  if (file.kind === "image") {
    // Thread the agent's optional caption so the lightbox can show it (#137).
    return (
      <InlineImage
        src={file.rawUrl}
        filename={file.filename}
        message={file.message}
        onMaximize={onMaximize}
      />
    );
  }
  // A video is always a real file (rejected inline server-side) → load from the
  // byte endpoint, which advertises byte-range support so it plays on iOS.
  if (file.kind === "video") {
    return <VideoBody src={file.rawUrl} filename={file.filename} />;
  }
  if (file.kind === "pdf") {
    // A PDF is binary, so it's always a real file (source: "file") served from
    // the byte endpoint — never inline content.
    return (
      <PdfEmbed
        src={file.rawUrl}
        filename={file.filename}
        className={fill ? "h-full w-full" : undefined}
      />
    );
  }
  // Text-ish kinds. Inline content renders directly; a file source loads its
  // text from the byte endpoint first.
  if (file.source === "inline") {
    return (
      <TextKind
        kind={file.kind}
        text={file.content ?? ""}
        language={file.language}
        itemId={itemId}
        fill={fill}
      />
    );
  }
  return (
    <FetchedTextKind
      url={file.rawUrl}
      kind={file.kind}
      language={file.language}
      itemId={itemId}
      fill={fill}
    />
  );
}

/** Render already-resolved text by kind, reusing the Files-tab primitives. */
function TextKind({
  kind,
  text,
  language,
  itemId,
  fill = false,
}: {
  kind: SentFileKind;
  text: string;
  /** Language hint carried on the sent file — drives `code` syntax highlighting. */
  language?: string;
  /**
   * Stable per-turn id (issue #135). When present, the long-scrollable kinds
   * (code / text / markdown) are wrapped in a `ResizableBox` so their height is
   * bounded + user-resizable + persisted (#136). Undefined on call paths / tests
   * that have no id → render as-is (no bounding).
   */
  itemId?: string;
  /** Fill the parent (the full-screen viewer) rather than a fixed inline height. */
  fill?: boolean;
}) {
  if (kind === "html") {
    // Sandboxed (scripts allowed, isolated from the app) — mirrors FileView.
    return (
      <iframe
        title="sent-file"
        sandbox="allow-scripts"
        srcDoc={text}
        className={`html-preview w-full ${fill ? "h-full" : "min-h-[360px]"}`}
      />
    );
  }
  if (kind === "mermaid") {
    return (
      <div className="p-4">
        <Mermaid code={text} />
      </div>
    );
  }
  if (kind === "markdown") {
    return (
      <Resizable itemId={itemId}>
        <article className="prose-doc max-w-none px-4 py-3">
          <Markdown mermaid>{text}</Markdown>
        </article>
      </Resizable>
    );
  }
  if (kind === "code") {
    // Theme-aware syntax highlighting, lazy-loaded so hljs stays out of the
    // entry chunk (issue #127). Falls back to plain escaped text until (or if)
    // the highlighter chunk resolves.
    return (
      <Resizable itemId={itemId}>
        <CodeBlock code={text} language={language} />
      </Resizable>
    );
  }
  // text: plain monospace preformatted.
  return (
    <Resizable itemId={itemId}>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed text-fg">
        {text}
      </pre>
    </Resizable>
  );
}

/**
 * Wrap a long text-ish embed in a `ResizableBox` when we have a stable item id
 * to persist its height on; otherwise render the children as-is (current
 * behaviour — no bounding, no handle).
 */
function Resizable({ itemId, children }: { itemId?: string; children: React.ReactNode }) {
  if (!itemId) return <>{children}</>;
  return <ResizableBox itemId={itemId}>{children}</ResizableBox>;
}

/** Load a file-source's text from Paddock, then render it by kind. */
function FetchedTextKind({
  url,
  kind,
  language,
  itemId,
  fill,
}: {
  url?: string;
  kind: SentFileKind;
  language?: string;
  itemId?: string;
  fill?: boolean;
}) {
  const [state, setState] = useState<{ text: string } | { error: true } | null>(null);
  useEffect(() => {
    if (!url) {
      setState({ error: true });
      return;
    }
    let cancelled = false;
    setState(null);
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => !cancelled && setState({ text }))
      .catch(() => !cancelled && setState({ error: true }));
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (state === null) {
    return <div className="px-4 py-3 text-xs text-fg-subtle">Loading…</div>;
  }
  if ("error" in state) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-sm text-danger">
        <AlertIcon width={16} height={16} className="shrink-0" />
        <span>Could not load this file.</span>
      </div>
    );
  }
  return (
    <TextKind kind={kind} text={state.text} language={language} itemId={itemId} fill={fill} />
  );
}

/**
 * A file-source video, rendered as an inline HTML5 player. `playsInline` keeps
 * iOS from hijacking playback into fullscreen, and `preload="metadata"` fetches
 * just enough to show the poster frame + duration without pulling the whole clip.
 * iOS Safari only plays a `<video>` when the server supports HTTP byte ranges —
 * the `/api/chat-files/:id` endpoint answers `Range:` with `206`, which is what
 * actually makes mobile playback work (see routes.ts). The nested content is the
 * fallback for a browser that can't decode the format: a note + a download link.
 */
function VideoBody({ src, filename }: { src?: string; filename: string }) {
  if (!src) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-sm text-danger">
        <AlertIcon width={16} height={16} className="shrink-0" />
        <span>Could not display this video.</span>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center overflow-hidden bg-surface-sunken p-4">
      <video
        src={src}
        controls
        playsInline
        preload="metadata"
        className="max-h-[480px] w-full rounded-sm shadow-sm"
      >
        {/* Fallback for a format the browser can't play. */}
        <p className="p-4 text-sm text-fg-muted">
          Your browser can’t play this video.{" "}
          <a href={src} download={filename} className="underline">
            Download {filename}
          </a>
        </p>
      </video>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 text-fg-subtle transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-fg-subtle"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
    </svg>
  );
}
