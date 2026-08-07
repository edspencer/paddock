import { useEffect } from "react";
import { AlertIcon, CheckIcon, XIcon } from "./icons";

/**
 * A transient, self-dismissing status message (#588).
 *
 * paddock had no toast mechanism before this: action feedback was either
 * ProjectView's `loadErr` — which is an early return that REPLACES the whole page,
 * fine for "the project failed to load" and far too violent for "7 chats
 * adopted" — or a pane-local inline strip (`ChatPane`'s composer error). Neither
 * can report a background action that succeeded, which is what an adoption needs, so
 * this is the small shared piece that was missing rather than a fourth private
 * copy of the idea.
 *
 * Deliberately dumb: the caller owns the message and the dismissal, exactly like
 * every other piece of state in this route. It renders nothing when `message` is
 * null, so a call site is one piece of state and one unconditional element.
 *
 * Not a native `alert()` — those are banned repo-wide (see
 * `src/no-native-dialogs.test.ts`) and would block the tab besides.
 */
export function Toast({
  message,
  tone = "success",
  onDismiss,
  /**
   * Auto-dismiss delay. 0 disables the timer, for a message the user must
   * acknowledge. The timer is keyed on the message text, so a second toast
   * arriving mid-countdown gets its own full dwell rather than inheriting the
   * remainder of the first one's.
   */
  durationMs = 6000,
  /**
   * Optional single action offered alongside the message — an "Undo" for an
   * action that has already happened (#660).
   *
   * Inside the toast rather than beside it because the toast IS the window in
   * which the offer stands: it disappears with the message, so there is never an
   * Undo button pointing at an adoption the user has long since forgotten. Callers
   * that offer one should raise the dwell time to match — six seconds is right
   * for reading an outcome, short for deciding to reverse it.
   */
  action,
}: {
  message: string | null;
  tone?: "success" | "error";
  onDismiss: () => void;
  durationMs?: number;
  action?: { label: string; onAct: () => void };
}) {
  useEffect(() => {
    if (message === null || durationMs <= 0) return;
    const t = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(t);
  }, [message, durationMs, onDismiss]);

  if (message === null) return null;

  const err = tone === "error";
  return (
    <div
      // `status` rather than `alert` even for the error tone: this reports the
      // outcome of something the user just asked for, so it is not an
      // interruption — an assertive live region would talk over them.
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4"
    >
      <div
        className={`pointer-events-auto flex max-w-md items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg ${
          err
            ? "border-rose-300/60 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/80 dark:text-rose-300"
            : "border-paddock-200 bg-canvas text-paddock-700 dark:border-paddock-700 dark:bg-paddock-800 dark:text-paddock-100"
        }`}
      >
        {err ? (
          <AlertIcon width={16} height={16} className="mt-0.5 shrink-0" />
        ) : (
          <CheckIcon width={16} height={16} className="mt-0.5 shrink-0 text-emerald-500" />
        )}
        <span className="break-words">{message}</span>
        {action && (
          <button
            type="button"
            onClick={action.onAct}
            className="ml-1 shrink-0 font-medium underline underline-offset-2 transition hover:opacity-80"
          >
            {action.label}
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="-mr-1 ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded transition hover:bg-black/5 dark:hover:bg-white/10"
        >
          <XIcon width={12} height={12} />
        </button>
      </div>
    </div>
  );
}
