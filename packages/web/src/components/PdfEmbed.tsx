import { AlertIcon, FileIcon } from "./icons";
import { MediaActions } from "./MediaImage";

/**
 * Render a PDF inline via the browser's NATIVE viewer (an <object> pointed at a
 * byte endpoint) — no pdf.js, no heavy deps. Some browsers (notably mobile
 * Safari/Chrome) won't inline-render a PDF; for them the <object>'s children act
 * as fallback content: a small panel with open-in-new-tab + download links.
 *
 * Shared by the two places a PDF can appear (issue #917):
 *  - a file the agent sent via `send_file` (`SentFileBlock`, the original home
 *    of this component — issue #128)
 *  - a `.pdf` in the project tree, via the Files tab and the Changes tab
 *
 * The `src` endpoint MUST serve `application/pdf` with a CSP that omits the
 * `sandbox` token — under a bare `sandbox` the native viewer renders nothing at
 * all, with no console error. `cspFor()` server-side is what guarantees this.
 */
export function PdfEmbed({
  src,
  filename,
  className = "h-[600px] w-full",
}: {
  src?: string;
  filename: string;
  /** Sizing for the <object>. The Files tab fills its pane; chat uses a fixed height. */
  className?: string;
}) {
  if (!src) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-sm text-danger">
        <AlertIcon width={16} height={16} className="shrink-0" />
        <span>Could not display this PDF.</span>
      </div>
    );
  }
  // `relative` so the action bar can overlay the native viewer. No Maximize:
  // Chrome's <object> viewer already offers fullscreen/print/save, and
  // open-in-new-tab is the cross-browser "pop it out" affordance.
  return (
    <div className="group relative">
      <object
        data={src}
        type="application/pdf"
        aria-label={filename}
        className={`${className} bg-surface-sunken`}
      >
        <div className="flex flex-col items-center gap-3 px-4 py-8 text-center text-sm text-fg-muted">
          <FileIcon width={13} height={13} className="shrink-0 text-fg-subtle" />
          <span className="font-mono text-fg">{filename}</span>
          <span className="text-xs text-fg-muted">
            This browser can’t show the PDF inline.
          </span>
          <div className="flex items-center gap-2">
            <a
              href={src}
              target="_blank"
              rel="noreferrer noopener"
              className="rounded-md bg-fg px-3 py-1.5 text-xs font-medium text-surface motion-fast transition-colors hover:bg-fg-muted"
            >
              Open in new tab
            </a>
            <a
              href={src}
              download={filename}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-fg-muted ring-1 ring-edge-strong hover:bg-surface-hover"
            >
              Download
            </a>
          </div>
        </div>
      </object>
      <MediaActions src={src} filename={filename} />
    </div>
  );
}
