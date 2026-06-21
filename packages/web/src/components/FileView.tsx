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
        <div className="h-4 w-1/3 animate-pulse rounded bg-paddock-200/70 dark:bg-paddock-800/70" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-paddock-200/70 dark:bg-paddock-800/70" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-paddock-200/70 dark:bg-paddock-800/70" />
      </div>
    );
  }

  if (error || !file) {
    return (
      <div className="p-6">
        <div className="flex items-start gap-2 rounded-lg border border-rose-300/60 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/50 dark:text-rose-300">
          <AlertIcon width={16} height={16} className="mt-0.5 shrink-0" />
          <span>{error ?? "File not found."}</span>
        </div>
      </div>
    );
  }

  if (file.kind === "html") {
    return <HtmlFileView name={file.name} content={file.content} />;
  }

  if (file.kind === "text") {
    return (
      <div className="overflow-auto p-6">
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-paddock-200 bg-paddock-50 p-4 font-mono text-[12.5px] leading-relaxed text-paddock-800 dark:border-paddock-800 dark:bg-paddock-950 dark:text-paddock-200">
          {file.content}
        </pre>
      </div>
    );
  }

  // markdown
  return (
    <article className="prose-doc mx-auto max-w-3xl px-6 py-6">
      <Markdown mermaid>{file.content}</Markdown>
    </article>
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
      <div className="flex items-center gap-2 border-b border-paddock-200 bg-paddock-50/60 px-4 py-2 text-[11px] text-paddock-500 dark:border-paddock-800 dark:bg-paddock-900/40">
        <ShieldIcon />
        <span>
          <span className="font-mono text-paddock-600 dark:text-paddock-300">{name}</span> renders in
          a sandboxed frame (scripts allowed, isolated from the app).
        </span>
      </div>
      <iframe
        title={name}
        sandbox="allow-scripts"
        srcDoc={content}
        className="min-h-[480px] w-full flex-1 bg-white"
      />
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
      className="shrink-0 text-paddock-400"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
    </svg>
  );
}
