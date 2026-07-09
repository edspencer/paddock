import { useState } from "react";
import type { SentFile } from "../lib/types";
import { Markdown } from "./Markdown";
import { Mermaid } from "./Mermaid";
import { AlertIcon } from "./icons";

/**
 * Renders a file the agent sent inline via `mcp__paddock__send_file` (issue
 * #112). Reuses the same rendering primitives as the Files tab (`Markdown` with
 * live Mermaid, a sandboxed iframe for HTML) inside a filename-header "editor"
 * chrome, so an agent can share a real or virtual/illustrative file that reads
 * as it would in the file browser.
 *
 * Live-only for now (Phase 1): the frame is not persisted to the transcript, so
 * a reload drops it — see issue #112 Phase 2 for persistence.
 */
export function SentFileBlock({ file }: { file: SentFile }) {
  return (
    <div className="flex animate-fade-in justify-start">
      <div className="w-full max-w-[92%] overflow-hidden rounded-2xl rounded-bl-md bg-white shadow-sm ring-1 ring-paddock-200/70 dark:bg-paddock-900 dark:ring-paddock-800">
        <div className="flex items-center gap-2 border-b border-paddock-200 bg-paddock-50/60 px-4 py-2 text-[11px] text-paddock-500 dark:border-paddock-800 dark:bg-paddock-900/40">
          <FileIcon />
          <span className="font-mono text-paddock-600 dark:text-paddock-300">{file.filename}</span>
          <span className="ml-auto uppercase tracking-wide text-[10px] text-paddock-400">
            {file.language ?? file.kind}
          </span>
        </div>
        {file.message ? (
          <div className="border-b border-paddock-100 px-4 py-2 text-xs text-paddock-500 dark:border-paddock-800 dark:text-paddock-400">
            {file.message}
          </div>
        ) : null}
        <SentFileBody file={file} />
      </div>
    </div>
  );
}

function SentFileBody({ file }: { file: SentFile }) {
  if (file.kind === "image") {
    return <ImageBody dataUrl={file.dataUrl} filename={file.filename} />;
  }
  if (file.kind === "html") {
    // Sandboxed (scripts allowed, isolated from the app) — mirrors FileView.
    return (
      <iframe
        title={file.filename}
        sandbox="allow-scripts"
        srcDoc={file.content ?? ""}
        className="min-h-[360px] w-full bg-white"
      />
    );
  }
  if (file.kind === "mermaid") {
    return (
      <div className="p-4">
        <Mermaid code={file.content ?? ""} />
      </div>
    );
  }
  if (file.kind === "markdown") {
    return (
      <article className="prose-doc max-w-none px-4 py-3">
        <Markdown mermaid>{file.content ?? ""}</Markdown>
      </article>
    );
  }
  // code + text: monospace preformatted. Syntax highlighting is Phase 2.
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12.5px] leading-relaxed text-paddock-800 dark:text-paddock-200">
      {file.content}
    </pre>
  );
}

function ImageBody({ dataUrl, filename }: { dataUrl?: string; filename: string }) {
  const [failed, setFailed] = useState(false);
  const checker =
    "repeating-conic-gradient(rgb(0 0 0 / 0.06) 0% 25%, transparent 0% 50%) 50% / 20px 20px";
  if (!dataUrl || failed) {
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
        src={dataUrl}
        alt={filename}
        onError={() => setFailed(true)}
        className="max-h-[480px] max-w-full object-contain shadow-sm"
      />
    </div>
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
