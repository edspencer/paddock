import { useEffect, useState } from "react";
import type { SentFile, SentFileKind } from "../lib/types";
import { AlertIcon, CheckIcon, CopyIcon, DownloadIcon } from "./icons";

/** The kinds whose source is text, and so can be copied to the clipboard. */
const TEXT_KINDS: ReadonlySet<SentFileKind> = new Set([
  "markdown",
  "code",
  "text",
  "html",
  "mermaid",
]);

export function isTextKind(kind: SentFileKind): boolean {
  return TEXT_KINDS.has(kind);
}

/** A text file's source: still loading, failed to load, or resolved. */
export type SentFileText = { text: string } | { error: true } | null;

/**
 * Resolve a text-kind sent file's source. Inline content is already in hand; a
 * file source is fetched from Paddock's byte endpoint. Lives on the block rather
 * than in the body so the header's Copy works while the file is collapsed (the
 * body isn't mounted then). Returns `null` while loading — and for non-text
 * kinds, which have nothing to resolve.
 */
export function useSentFileText(file: SentFile): SentFileText {
  const url = file.source === "file" && isTextKind(file.kind) ? file.rawUrl : undefined;
  const [fetched, setFetched] = useState<SentFileText>(null);
  useEffect(() => {
    if (file.source !== "file" || !isTextKind(file.kind)) return;
    if (!url) {
      setFetched({ error: true });
      return;
    }
    let cancelled = false;
    setFetched(null);
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => !cancelled && setFetched({ text }))
      .catch(() => !cancelled && setFetched({ error: true }));
    return () => {
      cancelled = true;
    };
  }, [url, file.source, file.kind]);

  if (!isTextKind(file.kind)) return null;
  if (file.source === "inline") return { text: file.content ?? "" };
  return fetched;
}

/** MIME type for a download built from inline content (no server response to carry one). */
const MIME: Partial<Record<SentFileKind, string>> = {
  markdown: "text/markdown",
  html: "text/html",
};

const BTN =
  "flex items-center px-2.5 text-fg-subtle motion-fast transition-colors hover:bg-surface-hover hover:text-fg focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-40";

/**
 * Copy / Download actions for a sent file's header. Always visible — the header
 * is a fixed bar, not an overlay, and hover doesn't exist on touch.
 *
 * Copy is offered for text kinds only and copies the SOURCE (the markdown, not
 * the rendered page). Download is offered for every kind except image and PDF,
 * which already carry one in their `MediaActions` overlay. A file source links
 * straight at its byte endpoint (same-origin, so `download` overrides the
 * endpoint's `inline` disposition); inline content has no URL, so it's wrapped
 * in a Blob on click.
 */
export function SentFileActions({ file, text }: { file: SentFile; text: SentFileText }) {
  return (
    <>
      {isTextKind(file.kind) ? <CopyButton filename={file.filename} text={text} /> : null}
      {file.kind === "image" || file.kind === "pdf" ? null : (
        <DownloadButton file={file} failed={text !== null && "error" in text} />
      )}
    </>
  );
}

function CopyButton({ filename, text }: { filename: string; text: SentFileText }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (status === "idle") return;
    const t = setTimeout(() => setStatus("idle"), 1600);
    return () => clearTimeout(t);
  }, [status]);

  const ready = text !== null && "text" in text;
  const onClick = () => {
    if (!ready) return;
    // Only claim success once the write resolves — `navigator.clipboard` is
    // absent outside a secure context and can be denied by permission.
    const clip = navigator.clipboard;
    if (!clip) {
      setStatus("failed");
      return;
    }
    clip.writeText(text.text).then(
      () => setStatus("copied"),
      () => setStatus("failed"),
    );
  };

  const title =
    status === "copied"
      ? "Copied"
      : status === "failed"
        ? "Couldn't copy"
        : text === null
          ? "Loading…"
          : "error" in text
            ? "Couldn't load this file"
            : "Copy source";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!ready}
      aria-label={`Copy ${filename}`}
      title={title}
      className={BTN}
    >
      {status === "copied" ? (
        <CheckIcon width={13} height={13} className="text-success" />
      ) : status === "failed" ? (
        <AlertIcon width={13} height={13} className="text-danger" />
      ) : (
        <CopyIcon width={13} height={13} />
      )}
      <span className="sr-only" role="status">
        {status === "copied" ? "Copied" : status === "failed" ? "Couldn't copy" : ""}
      </span>
    </button>
  );
}

function DownloadButton({ file, failed }: { file: SentFile; failed: boolean }) {
  const label = `Download ${file.filename}`;
  if (file.source === "file") {
    if (!file.rawUrl) return null;
    // The preview already found the bytes missing; a link would save the 404.
    if (failed) {
      return (
        <button type="button" disabled aria-label={label} title="Couldn't load this file" className={BTN}>
          <DownloadIcon width={13} height={13} />
        </button>
      );
    }
    return (
      <a href={file.rawUrl} download={file.filename} aria-label={label} title="Download" className={BTN}>
        <DownloadIcon width={13} height={13} />
      </a>
    );
  }
  const onClick = () => {
    const type = `${MIME[file.kind] ?? "text/plain"};charset=utf-8`;
    const url = URL.createObjectURL(new Blob([file.content ?? ""], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = file.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on a later tick: some browsers start the download asynchronously.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <button type="button" onClick={onClick} aria-label={label} title="Download" className={BTN}>
      <DownloadIcon width={13} height={13} />
    </button>
  );
}
