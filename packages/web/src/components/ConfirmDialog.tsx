import { useEffect, useState } from "react";
import { AlertIcon } from "./icons";
import { useEscapeKey } from "../lib/useEscapeKey";

/**
 * A small, focused confirmation modal. Used for destructive actions like
 * deleting a project or a chat. Esc cancels; the confirm button can show a
 * busy state while the async action runs.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  danger = true,
  wide = false,
  dismissOnBackdrop = true,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Roomier box for dialogs whose message is structured content, not one line. */
  wide?: boolean;
  /**
   * Whether clicking the backdrop cancels. The default suits short, one-line
   * confirmations. Set `false` where the dialog carries warning text the user
   * is meant to actually read (reverting a chat, #541): there the box is large,
   * so the backdrop is an easy mis-click, and discarding the decision silently
   * is worse than making the user pick a button.
   */
  dismissOnBackdrop?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  // Escape is ignored mid-flight, so the dialog can't be dismissed out from
  // under a request that has already gone to the server.
  useEscapeKey(open && !busy, onClose);

  if (!open) return null;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-4 backdrop-blur-sm"
      onClick={() => dismissOnBackdrop && !busy && onClose()}
    >
      <div
        className={`w-full ${wide ? "max-w-md" : "max-w-sm"} animate-scale-in rounded-2xl border border-edge bg-surface-raised p-6 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
      >
        <div className="flex items-start gap-3">
          {danger && (
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-danger-soft text-danger">
              <AlertIcon width={18} height={18} />
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{title}</h2>
            <div className="mt-1.5 text-sm text-fg-muted">{message}</div>
          </div>
        </div>

        {error && (
          <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? "btn btn-danger" : "btn-primary"}
            onClick={confirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
