import { useEffect, useMemo, useState } from "react";
import type { AdoptableCandidate, AdoptableChats } from "../lib/types";
import { useEscapeKey } from "../lib/useEscapeKey";
import { TerminalIcon, XIcon } from "./icons";

/**
 * Confirm what a native-chat adoption is about to bring in (#660).
 *
 * Adoption used to be one unconfirmed click on a permanently-visible sidebar
 * button, with no preview and no undo. That is a bad combination with a count
 * that can be wrong: on the instance that prompted this, the offer of 26 chats
 * was 10 of Paddock's own sweeper runs (#658) and 16 forgotten `claude -p` smoke
 * tests, and a sibling project was offering 15 chats belonging to a different
 * Paddock instance entirely (#659). Both are fixed, but "the count is
 * trustworthy" is not a property to keep betting a one-click irreversible action
 * on.
 *
 * So: show the sessions, grouped by where they came from, and let the user
 * choose. Everything is ticked initially — the common case really is "yes, all
 * of it", and this must not become a chore for the user who already knows what
 * their own history is.
 *
 * `sourceCwd` is shown per group and is the most load-bearing thing here: it is
 * what makes "these 15 are from a scratch copy, not my checkout" visible at all.
 */
export function AdoptChatsModal({
  open,
  adoptable,
  busy,
  onClose,
  onAdopt,
}: {
  open: boolean;
  /** What the workspace currently offers, as returned by `getAdoptableChats`. */
  adoptable: AdoptableChats | null;
  busy: boolean;
  onClose: () => void;
  /** Adopt exactly these sessions. Never called with an empty selection. */
  onAdopt: (sessionIds: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Normalised up front so everything below reads one shape. `sessions` is newer
  // than `sessionIds`, and a server that predates it still answers the count
  // endpoint — degrading to id-only rows keeps the dialog usable instead of
  // crashing the route, the same version-skew tolerance the count fetch has.
  const sources = useMemo(
    () =>
      (adoptable?.sources ?? []).map((s) => ({
        sourceCwd: s.sourceCwd,
        sessions: s.sessions ?? s.sessionIds.map((sessionId) => ({ sessionId }) as AdoptableCandidate),
      })),
    [adoptable],
  );
  const allIds = useMemo(
    () => sources.flatMap((s) => s.sessions.map((c) => c.sessionId)),
    [sources],
  );

  // Select everything whenever the dialog OPENS or the offer changes underneath
  // it. Keyed on the ids rather than on `open` alone so a refreshed offer cannot
  // leave the selection holding ids that are no longer available.
  const idKey = allIds.join(",");
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(allIds));
    // `idKey` is the stable projection of `allIds`; depending on the array itself
    // would re-run this on every render and fight the user's clicks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, idKey]);

  // Escape closes, but not out from under an in-flight adoption — the request
  // would still land. Same rule as `ConfirmDialog` and `PromoteChatModal`.
  useEscapeKey(open && !busy, onClose);

  if (!open) return null;

  const toggle = (sessionId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(sessionId)) next.add(sessionId);
      return next;
    });
  };

  const toggleSource = (ids: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const count = selected.size;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-sm"
      onClick={() => !busy && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Adopt native Claude Code chats"
        className="flex max-h-[80vh] w-full max-w-2xl animate-scale-in flex-col rounded-2xl border border-edge bg-surface-raised p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <TerminalIcon width={16} height={16} />
            Adopt native chats
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg p-1 text-fg-subtle hover:bg-surface-hover hover:text-fg-muted"
            aria-label="Close"
          >
            <XIcon width={18} height={18} />
          </button>
        </div>
        <p className="mb-4 text-sm text-fg-muted">
          These Claude Code sessions were run in a terminal and aren&apos;t visible here yet.
          Adopting them lists them here — your own <code>~/.claude</code> history is never moved
          or deleted.
        </p>

        <div className="-mx-1 flex-1 overflow-y-auto px-1">
          {sources.length === 0 && (
            <p className="py-6 text-center text-sm text-fg-muted">Nothing left to adopt.</p>
          )}
          {sources.map((source) => {
            const ids = source.sessions.map((c) => c.sessionId);
            const allOn = ids.every((id) => selected.has(id));
            return (
              <section key={source.sourceCwd} className="mb-4 last:mb-0">
                <header className="mb-1 flex items-baseline justify-between gap-2">
                  {/* The origin path, in full. A user who does not recognise a
                      source is exactly who this dialog exists for. */}
                  <code className="min-w-0 break-all text-xs text-fg-muted">
                    {source.sourceCwd}
                  </code>
                  <button
                    type="button"
                    onClick={() => toggleSource(ids, !allOn)}
                    className="shrink-0 text-xs text-fg-muted underline underline-offset-2 hover:text-fg"
                  >
                    {allOn ? "Deselect all" : "Select all"}
                  </button>
                </header>
                <ul className="space-y-1">
                  {source.sessions.map((candidate) => (
                    <li key={candidate.sessionId}>
                      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-edge px-3 py-2 transition hover:bg-surface-hover">
                        <input
                          type="checkbox"
                          className="mt-1 shrink-0"
                          checked={selected.has(candidate.sessionId)}
                          onChange={() => toggle(candidate.sessionId)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{describe(candidate)}</span>
                          {/* Absent only against an older server that reports ids
                              alone — then the row is the id and nothing else,
                              rather than "Invalid Date · NaN kB". */}
                          {candidate.mtime !== undefined && (
                            <span className="mt-0.5 block text-xs text-fg-muted tabular">
                              {formatDate(candidate.mtime)} · {formatSize(candidate.sizeBytes)}
                            </span>
                          )}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>

        <div className="mt-4 flex items-center justify-between gap-2 border-t border-edge pt-4">
          <span className="text-sm text-fg-muted">
            {count} of {allIds.length} selected
          </span>
          <span className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy || count === 0}
              onClick={() => onAdopt([...selected])}
            >
              {busy ? "Adopting…" : `Adopt ${count} chat${count === 1 ? "" : "s"}`}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The best one-line label available for a candidate.
 *
 * `autoName` is the transcript's own summary and reads best when present;
 * otherwise the first user message, which is what the user actually typed. A
 * session with neither is not nothing — it is a real transcript with an
 * unusual head — so it falls back to the id rather than rendering blank.
 */
function describe(candidate: AdoptableCandidate): string {
  const name = candidate.autoName?.trim();
  if (name !== undefined && name !== "") return name;
  const preview = candidate.preview?.trim();
  if (preview !== undefined && preview !== "") return preview;
  return candidate.sessionId;
}

/** Short absolute date — these are historic sessions, so "3m ago" is no use. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown date";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Rough transcript size — enough to tell a one-liner from a long conversation. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
