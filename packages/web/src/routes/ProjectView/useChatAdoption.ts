import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { AdoptableChats, AdoptChatsResult } from "../../lib/types";

/**
 * What an adoption actually did (#588), in one line.
 *
 * Reports skips rather than rounding them away: "Adopted 7 chats" when two were
 * refused is a lie the user only discovers by counting rows. When every skip
 * shares a reason the reason is named — it is usually the whole explanation ("no
 * transcript on disk") and it is what turns a confusing number into an
 * actionable one.
 */
export function adoptSummary({ adopted, skipped }: AdoptChatsResult): string {
  const n = adopted.length;
  if (n === 0 && skipped.length === 0) return "Nothing to adopt — no native chats were found.";
  const head = n === 0 ? "Adopted nothing" : `Adopted ${n} chat${n === 1 ? "" : "s"}`;
  if (skipped.length === 0) return head;
  const reasons = [...new Set(skipped.map((s) => s.reason).filter(Boolean))];
  const why = reasons.length === 1 ? ` (${reasons[0]})` : "";
  return `${head} — skipped ${skipped.length}${why}`;
}

/** The one transient outcome message the workspace route raises. */
export interface AdoptionToast {
  message: string;
  tone: "success" | "error";
  /** Offered inside the toast, so the window to undo IS the toast's dwell. */
  action?: { label: string; onAct: () => void };
}

/**
 * Adopt native Claude Code CLI chats into a workspace (#588, #660): the live
 * adoptable count, the confirmation dialog's state, the adopt/undo round-trips,
 * and the toast that reports them. Lifted out of `ProjectView` whole (#919) —
 * nothing else in the route touches any of it.
 */
export function useChatAdoption(slug: string, refreshChats: () => Promise<void>) {
  // How many terminal-run sessions this workspace could adopt right now. A LIVE
  // count, not a "has the user dismissed the offer?" flag: it is re-read after
  // every adoption, so the sidebar button vanishes only because there is genuinely
  // nothing left to take — and comes back on its own when the user accrues more
  // CLI history. 0 both before the first fetch and when there is nothing on
  // offer, which is the same thing as far as the UI is concerned.
  const [adoptableCount, setAdoptableCount] = useState(0);
  const [adopting, setAdopting] = useState(false);
  // The full offer, fetched with the count and handed to the confirmation dialog
  // (#660). Held beside the count rather than re-fetched on open so the dialog
  // shows exactly what the button counted.
  const [adoptable, setAdoptable] = useState<AdoptableChats | null>(null);
  const [adoptOpen, setAdoptOpen] = useState(false);
  // The one transient outcome message this route raises. Distinct from the
  // route's `loadErr`, which is an early return that replaces the entire page —
  // correct for "this project failed to load", far too violent for "adopted 7
  // chats".
  const [toast, setToast] = useState<AdoptionToast | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);

  // Re-read the adoptable-chat count (#588). Called on workspace open and again
  // after an adoption — never on render, and never on a timer: the set of native
  // sessions only changes when the user runs `claude` in a terminal, which no
  // amount of polling here would make more timely.
  //
  // A failure zeroes the count rather than leaving the previous one standing: the
  // endpoint is new and an older server 404s it, and a button offering to adopt
  // N chats that then fails to adopt anything is worse than no button. The
  // offer costs nothing to make again on the next open.
  const refreshAdoptable = useCallback(async () => {
    const res = await api.getAdoptableChats(slug).catch(() => null);
    setAdoptableCount(res?.count ?? 0);
    setAdoptable(res);
  }, [slug]);

  /**
   * Undo the adoption just performed (#660).
   *
   * Carries only the session ids; WHICH files may be deleted is decided
   * server-side from what the adoption actually did, so this can never be talked
   * into removing something it did not create. `released: []` is a normal
   * outcome (the offer is in-memory and expires with a restart) and is reported
   * as such rather than as a success.
   */
  const undoAdopt = useCallback(
    async (sessionIds: string[]) => {
      setToast(null);
      try {
        const res = await api.unadoptChats(slug, { sessionIds });
        await refreshChats();
        await refreshAdoptable();
        setToast(
          res.released.length > 0
            ? {
                message: `Removed ${res.released.length} adopted chat${res.released.length === 1 ? "" : "s"}.`,
                tone: "success",
              }
            : { message: "Nothing left to undo.", tone: "error" },
        );
      } catch (e) {
        setToast({
          message: e instanceof Error ? e.message : "Failed to undo the adoption",
          tone: "error",
        });
      }
    },
    [slug, refreshChats, refreshAdoptable],
  );

  /**
   * Adopt the native CLI chats the user confirmed (#588, #660).
   *
   * Takes an explicit id list rather than "everything matched": the dialog is
   * where the decision is made, and sending the selection means a user who
   * unticked a source they did not recognise gets what they asked for.
   *
   * Both the chat list AND the count are re-read afterwards, in that order of
   * importance: the list is what the user came for, the count is what makes the
   * button disappear. Neither is inferred from the response — the count in
   * particular must come from the server, or the button's visibility would drift
   * away from what is actually still adoptable.
   *
   * A successful adoption offers an Undo for as long as its toast stands.
   */
  const confirmAdopt = useCallback(
    async (sessionIds: string[]) => {
      if (adopting) return;
      setAdopting(true);
      try {
        const res = await api.adoptChats(slug, { sessionIds });
        setAdoptOpen(false);
        await refreshChats();
        await refreshAdoptable();
        const failed = res.adopted.length === 0 && res.skipped.length > 0;
        setToast({
          message: adoptSummary(res),
          // Nothing adopted AND something refused is the one shape that reads as a
          // failure to the user, whatever the HTTP status said.
          tone: failed ? "error" : "success",
          // Nothing came in, nothing to take back out.
          action:
            res.adopted.length > 0
              ? { label: "Undo", onAct: () => void undoAdopt(res.adopted) }
              : undefined,
        });
      } catch (e) {
        // Deliberately NOT the route's `setLoadErr` (which would blank the whole
        // project view over a failed side-action) and deliberately no count
        // refresh — the offer stands, so the button stays clickable for a retry.
        setToast({
          message: e instanceof Error ? e.message : "Failed to adopt native chats",
          tone: "error",
        });
      } finally {
        // In `finally` so a throw can never strand the button in "Adopting…".
        setAdopting(false);
      }
    },
    [adopting, slug, refreshChats, refreshAdoptable, undoAdopt],
  );

  // Fetch the adoptable count once per workspace open. `refreshAdoptable` is
  // slug-scoped and otherwise stable, so this is the whole "on open, not on every
  // render" story — the deps array does the gating, no ref needed. The count and
  // any leftover toast reset FIRST so switching workspaces can't briefly offer to
  // adopt the previous one's chats.
  useEffect(() => {
    setAdoptableCount(0);
    setAdoptable(null);
    setAdoptOpen(false);
    setToast(null);
    void refreshAdoptable();
  }, [refreshAdoptable]);

  return {
    adoptableCount,
    adopting,
    adoptable,
    adoptOpen,
    setAdoptOpen,
    confirmAdopt,
    toast,
    dismissToast,
  };
}
