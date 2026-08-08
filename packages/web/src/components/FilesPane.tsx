import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { DirListing, Project } from "../lib/types";
import { FileView } from "./FileView";
import { AlertIcon, ChevronRightIcon, FileIcon, FolderIcon, PinIcon } from "./icons";

/**
 * The Files tab (issue #259). Browses ONE directory level at a time from a
 * project-relative `path` ("" = the project root), so subdirectories — a project
 * that files its notes under `design/`, `aar/`, `docs/` — are reachable instead
 * of invisible. The current directory (or file) is carried in the URL by
 * ProjectView, so every folder and file is deep-linkable and refresh-safe.
 *
 * The same `path` addresses both folders and files; we don't know which from the
 * URL alone, so we ask the listing endpoint, which discriminates on `kind`: a
 * directory returns its entries; a file returns `kind: "file"` and we render the
 * single-file viewer for that path. Navigating (into a folder, up via `..`, or a
 * breadcrumb) just changes `path` through `onNavigate` — the URL is the source of
 * truth.
 */
export function FilesPane({
  project,
  path,
  onNavigate,
  onTogglePin,
}: {
  project: Project;
  /** Project-relative subpath of the directory or file being viewed ("" = root). */
  path: string;
  /** Navigate to another files subpath (a folder, a file, or "" for the root). */
  onNavigate: (subpath: string) => void;
  onTogglePin: (file: string) => void;
}) {
  const slug = project.slug;
  // "dir" -> browsing a directory (listing loaded); "file" -> `path` is a file,
  // render the viewer; null while we're still deciding.
  const [listing, setListing] = useState<DirListing | null>(null);
  const [isFile, setIsFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setListing(null);
    setIsFile(false);
    api
      .listProjectDir(slug, path)
      .then((l) => {
        if (cancelled) return;
        // A file, not a directory: render the single-file viewer for this path.
        if (l.kind === "file") setIsFile(true);
        else setListing(l);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load files");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, path]);

  // The parent directory of `path` (""-safe): "design/sub/foo.md" -> "design/sub".
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

  const breadcrumb = (
    <Breadcrumb path={path} isFile={isFile} onNavigate={onNavigate} />
  );

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-3xl px-6 py-6">
          {breadcrumb}
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-10 animate-pulse rounded-lg bg-surface-active"
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-3xl px-6 py-6">
          {breadcrumb}
          <div className="flex items-start gap-2 rounded-lg border border-danger-edge bg-danger-soft px-3 py-2 text-sm text-danger">
            <AlertIcon width={16} height={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        </div>
      </div>
    );
  }

  // `path` is a file — the viewer, with a breadcrumb + a Pin toggle. Any file
  // reachable through the browser is pinnable, at any depth (issue #259 made the
  // whole path pinnable; the pinned list stores the project-relative path).
  if (isFile) {
    const isPinned = project.pinned.includes(path);
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-edge px-4 py-2">
          <div className="min-w-0 flex-1">{breadcrumb}</div>
          <button
            onClick={() => onTogglePin(path)}
            className={`ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
              isPinned
                ? "bg-accent/10 text-accent"
                : "text-fg-muted hover:bg-surface-hover"
            }`}
            title={isPinned ? "Unpin (remove tab)" : "Pin as a tab"}
          >
            <PinIcon width={13} height={13} />
            {isPinned ? "Pinned" : "Pin as tab"}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <FileView slug={slug} name={path} />
        </div>
      </div>
    );
  }

  // A directory listing.
  const entries = listing?.entries ?? [];
  return (
    <div className="flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto max-w-3xl px-6 py-6">
        {breadcrumb}
        {entries.length === 0 && path === "" ? (
          <div className="card">
            <p className="text-sm italic text-fg-subtle">
              No files yet. Files Claude writes (and sweep-curated OVERVIEW.md)
              will appear here.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-edge">
            {/* A ".." row to go up a level when we're nested. */}
            {path !== "" && (
              <button
                onClick={() => onNavigate(parent)}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-hover"
              >
                <FolderIcon width={15} height={15} className="shrink-0 text-fg-subtle" />
                <span className="font-mono text-sm text-fg-muted">..</span>
              </button>
            )}
            {entries.length === 0 && path !== "" && (
              <div className="px-3 py-2.5 text-sm italic text-fg-subtle">
                This folder is empty.
              </div>
            )}
            {entries.map((e, i) => {
              const childPath = path ? `${path}/${e.name}` : e.name;
              const isDir = e.kind === "dir";
              const isPinned = project.pinned.includes(childPath);
              // Any file is pinnable, at any depth — the pin stores childPath
              // (the full project-relative path), not just the basename.
              const showPin = !isDir;
              const border = i > 0 || path !== "" ? "border-t border-edge" : "";
              return (
                <div
                  key={e.name}
                  className={`group/file flex items-center gap-2 px-3 py-2.5 transition-colors hover:bg-surface-hover ${border}`}
                >
                  <button
                    onClick={() => onNavigate(childPath)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    {isDir ? (
                      <FolderIcon width={15} height={15} className="shrink-0 text-accent/80" />
                    ) : (
                      <FileIcon width={15} height={15} className="shrink-0 text-fg-subtle" />
                    )}
                    <span
                      className={`truncate font-mono text-sm ${
                        isDir ? "font-medium text-fg" : "text-fg"
                      }`}
                    >
                      {e.name}
                    </span>
                    {isDir && (
                      <ChevronRightIcon
                        width={14}
                        height={14}
                        className="ml-auto shrink-0 text-fg-subtle"
                      />
                    )}
                  </button>
                  {showPin && (
                    <button
                      type="button"
                      aria-label={isPinned ? `Unpin ${e.name}` : `Pin ${e.name}`}
                      title={isPinned ? "Unpin (remove tab)" : "Pin as a sibling tab"}
                      onClick={() => onTogglePin(childPath)}
                      className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-2xs font-medium transition ${
                        isPinned
                          ? "bg-accent/10 text-accent"
                          : "text-fg-subtle opacity-0 hover:bg-surface-active hover:text-fg-muted focus:opacity-100 group-hover/file:opacity-100"
                      }`}
                    >
                      <PinIcon width={12} height={12} />
                      {isPinned ? "Pinned" : "Pin"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A path breadcrumb: a "Files" root crumb plus one crumb per path segment. Every
 * crumb but the last navigates to its cumulative subpath; the last is the current
 * location (the folder you're in, or the file you're viewing) and isn't a link.
 */
function Breadcrumb({
  path,
  isFile,
  onNavigate,
}: {
  path: string;
  isFile: boolean;
  onNavigate: (subpath: string) => void;
}) {
  const segments = path ? path.split("/") : [];
  return (
    <nav
      aria-label="File path"
      className="mb-3 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-sm"
    >
      <CrumbButton
        label="Files"
        isLast={segments.length === 0}
        onClick={() => onNavigate("")}
      />
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        const cumulative = segments.slice(0, i + 1).join("/");
        return (
          <span key={cumulative} className="flex items-center gap-x-1">
            <ChevronRightIcon
              width={13}
              height={13}
              className="shrink-0 text-fg-subtle"
            />
            <CrumbButton
              label={seg}
              // The final file crumb is plain text; final folder crumb too.
              isLast={isLast}
              mono
              muted={isLast && isFile}
              onClick={() => onNavigate(cumulative)}
            />
          </span>
        );
      })}
    </nav>
  );
}

function CrumbButton({
  label,
  isLast,
  mono,
  muted,
  onClick,
}: {
  label: string;
  isLast: boolean;
  mono?: boolean;
  muted?: boolean;
  onClick: () => void;
}) {
  const cls = mono ? "font-mono" : "";
  if (isLast) {
    return (
      <span
        aria-current="page"
        className={`${cls} font-medium ${
          muted ? "text-fg-muted" : "text-fg"
        }`}
      >
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${cls} rounded text-fg-muted transition-colors hover:text-accent`}
    >
      {label}
    </button>
  );
}
