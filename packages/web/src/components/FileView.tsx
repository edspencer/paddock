import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ProjectFile } from "../lib/types";
import { Markdown } from "./Markdown";
import { AlertIcon } from "./icons";

/**
 * Fetches a single project file (GET /files/:name) and renders it by `kind`:
 *  - markdown -> the Markdown renderer with live Mermaid diagrams
 *  - html     -> a SANDBOXED iframe (sandbox="allow-scripts", no same-origin)
 *                so arbitrary LLM-authored HTML/CSS/JS runs safely + isolated
 *  - image    -> an <img> loaded from the raw-bytes endpoint (issue #61)
 *  - text     -> monospace preformatted
 *
 * Used both for the Files tab (clicking a file) and pinned sibling tabs.
 */
export function FileView({ slug, name }: { slug: string; name: string }) {
  const [file, setFile] = useState<ProjectFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFile(null);
    api
      .getProjectFile(slug, name)
      .then((f) => {
        if (!cancelled) setFile(f);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load file");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, name]);

  if (loading) {
    return (
      <div className="space-y-3 p-6">
        <div className="h-4 w-1/3 animate-pulse rounded bg-surface-active" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-surface-active" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-surface-active" />
      </div>
    );
  }

  if (error || !file) {
    return (
      <div className="p-6">
        <div className="flex items-start gap-2 rounded-lg border border-danger-edge bg-danger-soft px-3 py-2 text-sm text-danger">
          <AlertIcon width={16} height={16} className="mt-0.5 shrink-0" />
          <span>{error ?? "File not found."}</span>
        </div>
      </div>
    );
  }

  if (file.kind === "image") {
    return <ImageFileView slug={slug} name={file.name} />;
  }

  if (file.kind === "html") {
    return <HtmlFileView name={file.name} content={file.content} />;
  }

  if (file.kind === "text") {
    return (
      <div className="overflow-auto p-6">
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-edge bg-surface-sunken p-4 font-mono text-xs leading-relaxed text-fg">
          {file.content}
        </pre>
      </div>
    );
  }

  // markdown — a document, so it is set as one: a page on the board, at the
  // reading measure. `prose-doc` caps each block at `--measure` (68ch) and lets
  // code, tables and images break out of it.
  return (
    <div className="px-3 py-6 sm:px-6">
      <article className="prose-doc page mx-auto max-w-3xl px-5 py-8 sm:px-10 sm:py-10">
        <Markdown mermaid>{file.content}</Markdown>
      </article>
    </div>
  );
}

/**
 * HTML rendered inside a sandboxed iframe. `sandbox="allow-scripts"` WITHOUT
 * `allow-same-origin` means the document runs as a null/opaque origin: it can
 * execute its own JS/Mermaid/CSS but cannot touch this app's DOM, cookies, or
 * storage. `srcDoc` keeps it same-page (no extra request).
 */
function HtmlFileView({ name, content }: { name: string; content: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-edge bg-surface-sunken px-4 py-2 text-2xs text-fg-muted">
        <ShieldIcon />
        <span>
          <span className="font-mono text-fg-muted">{name}</span> renders in
          a sandboxed frame (scripts allowed, isolated from the app).
        </span>
      </div>
      <iframe
        title={name}
        sandbox="allow-scripts"
        srcDoc={content}
        className="html-preview min-h-[480px] w-full flex-1"
      />
    </div>
  );
}

/**
 * An image file (issue #61): the bytes load from the raw endpoint (correct
 * Content-Type, not the JSON/UTF-8 path that mangled them) into a contained
 * <img> over a neutral checkerboard so transparency reads clearly. A broken load
 * falls back to an error note.
 */
function ImageFileView({ slug, name }: { slug: string; name: string }) {
  const [failed, setFailed] = useState(false);
  // Tokenised checkerboard: a 6% wash of the foreground colour, so the mat
  // inverts with the theme instead of always being a black tint.
  const checker =
    "repeating-conic-gradient(color-mix(in oklab, var(--text) 6%, transparent) 0% 25%, transparent 0% 50%) 50% / 20px 20px";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-edge bg-surface-sunken px-4 py-2 text-2xs text-fg-muted">
        <span className="font-mono text-fg-muted">{name}</span>
      </div>
      <div
        className="flex flex-1 items-center justify-center overflow-auto p-6"
        style={{ background: checker }}
      >
        {failed ? (
          <div className="flex items-center gap-2 rounded-lg border border-danger-edge bg-danger-soft px-3 py-2 text-sm text-danger">
            <AlertIcon width={16} height={16} className="shrink-0" />
            <span>Could not display this image.</span>
          </div>
        ) : (
          <img
            src={api.projectFileRawUrl(slug, name)}
            alt={name}
            onError={() => setFailed(true)}
            className="max-h-full max-w-full object-contain shadow-sm"
          />
        )}
      </div>
    </div>
  );
}

function ShieldIcon() {
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
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
    </svg>
  );
}
