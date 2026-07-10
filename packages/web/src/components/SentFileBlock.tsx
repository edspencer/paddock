import { useEffect, useState } from "react";
import type { SentFile, SentFileKind } from "../lib/types";
import { CodeBlock } from "./CodeBlock";
import { Markdown } from "./Markdown";
import { Mermaid } from "./Mermaid";
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
 */
export function SentFileBlock({ file }: { file: SentFile }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex animate-fade-in justify-start">
      <div className="w-full max-w-[92%] overflow-hidden rounded-2xl rounded-bl-md bg-white shadow-sm ring-1 ring-paddock-200/70 dark:bg-paddock-900 dark:ring-paddock-800">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 border-b border-paddock-200 bg-paddock-50/60 px-4 py-2 text-left text-[11px] text-paddock-500 dark:border-paddock-800 dark:bg-paddock-900/40"
        >
          <Chevron open={open} />
          <FileIcon />
          <span className="font-mono text-paddock-600 dark:text-paddock-300">{file.filename}</span>
          <span className="ml-auto uppercase tracking-wide text-[10px] text-paddock-400">
            {file.language ?? file.kind}
          </span>
        </button>
        {file.message ? (
          <div className="border-b border-paddock-100 px-4 py-2 text-xs text-paddock-500 dark:border-paddock-800 dark:text-paddock-400">
            {file.message}
          </div>
        ) : null}
        {open ? <SentFileBody file={file} /> : null}
      </div>
    </div>
  );
}

function SentFileBody({ file }: { file: SentFile }) {
  if (file.kind === "image") {
    return <ImageBody src={file.rawUrl} filename={file.filename} />;
  }
  // Text-ish kinds. Inline content renders directly; a file source loads its
  // text from the byte endpoint first.
  if (file.source === "inline") {
    return <TextKind kind={file.kind} text={file.content ?? ""} language={file.language} />;
  }
  return <FetchedTextKind url={file.rawUrl} kind={file.kind} language={file.language} />;
}

/** Render already-resolved text by kind, reusing the Files-tab primitives. */
function TextKind({
  kind,
  text,
  language,
}: {
  kind: SentFileKind;
  text: string;
  /** Language hint carried on the sent file — drives `code` syntax highlighting. */
  language?: string;
}) {
  if (kind === "html") {
    // Sandboxed (scripts allowed, isolated from the app) — mirrors FileView.
    return (
      <iframe
        title="sent-file"
        sandbox="allow-scripts"
        srcDoc={text}
        className="min-h-[360px] w-full bg-white"
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
      <article className="prose-doc max-w-none px-4 py-3">
        <Markdown mermaid>{text}</Markdown>
      </article>
    );
  }
  if (kind === "code") {
    // Theme-aware syntax highlighting, lazy-loaded so hljs stays out of the
    // entry chunk (issue #127). Falls back to plain escaped text until (or if)
    // the highlighter chunk resolves.
    return <CodeBlock code={text} language={language} />;
  }
  // text: plain monospace preformatted.
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12.5px] leading-relaxed text-paddock-800 dark:text-paddock-200">
      {text}
    </pre>
  );
}

/** Load a file-source's text from Paddock, then render it by kind. */
function FetchedTextKind({
  url,
  kind,
  language,
}: {
  url?: string;
  kind: SentFileKind;
  language?: string;
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
    return <div className="px-4 py-3 text-xs text-paddock-400">Loading…</div>;
  }
  if ("error" in state) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
        <AlertIcon width={16} height={16} className="shrink-0" />
        <span>Could not load this file.</span>
      </div>
    );
  }
  return <TextKind kind={kind} text={state.text} language={language} />;
}

function ImageBody({ src, filename }: { src?: string; filename: string }) {
  const [failed, setFailed] = useState(false);
  const checker =
    "repeating-conic-gradient(rgb(0 0 0 / 0.06) 0% 25%, transparent 0% 50%) 50% / 20px 20px";
  if (!src || failed) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
        <AlertIcon width={16} height={16} className="shrink-0" />
        <span>Could not display this image.</span>
      </div>
    );
  }
  return (
    <div
      className="flex items-center justify-center overflow-auto p-4"
      style={{ background: checker }}
    >
      <img
        src={src}
        alt={filename}
        onError={() => setFailed(true)}
        className="max-h-[480px] max-w-full object-contain shadow-sm"
      />
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
      className={`shrink-0 text-paddock-400 transition-transform ${open ? "rotate-90" : ""}`}
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
      className="shrink-0 text-paddock-400"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}
