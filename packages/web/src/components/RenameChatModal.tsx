import { useEffect, useRef, useState } from "react";
import { XIcon } from "./icons";
import { useEscapeKey } from "../lib/useEscapeKey";

/**
 * Rename a chat (#541) — the modal that replaced a `window.prompt()`.
 *
 * The empty-input case is load-bearing here rather than an edge case, because
 * of what the prompt's return value used to mean: `null` for "cancelled" and
 * `""` for "the user deliberately cleared the field", which the caller read as
 * *reset this chat to its auto-generated preview name*. A dialog has to keep
 * both doors open — `onClose` is the cancel, `onRename(null)` is the reset.
 *
 * The upside of the swap is that the reset stops being folklore: `prompt()`
 * had no way to mention it, so the only way to discover it was to clear the
 * box and find out. Here it's a visible hint and a button that relabels itself.
 */
export function RenameChatModal({
  open,
  chatName,
  resetName,
  onClose,
  onRename,
}: {
  open: boolean;
  /** Current name, prefilled and pre-selected so typing replaces it. */
  chatName: string;
  /** What the chat falls back to when the name is cleared, if known. */
  resetName?: string;
  onClose: () => void;
  /** `null` means "clear the custom name and fall back to the preview". */
  onRename: (name: string | null) => void;
}) {
  const [name, setName] = useState(chatName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(chatName);
    // autoFocus only puts the caret at the end; select the prefilled text so
    // the first keystroke replaces the old name instead of appending to it.
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.select();
    }
  }, [open, chatName]);

  useEscapeKey(open, onClose);

  if (!open) return null;

  const trimmed = name.trim();
  const willReset = trimmed === "";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onRename(willReset ? null : trimmed);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <form
        className="w-full max-w-md animate-scale-in rounded-2xl border border-edge bg-surface-raised p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label="Rename chat"
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Rename chat</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-fg-subtle hover:bg-surface-hover hover:text-fg-muted"
            aria-label="Close"
          >
            <XIcon width={18} height={18} />
          </button>
        </div>
        <p className="mb-5 text-sm text-fg-muted">
          Renaming only changes how this chat is labelled in the sidebar — the transcript, its id,
          and its history are untouched.
        </p>

        <label className="mb-2 block">
          <span className="field-label">Chat name</span>
          <input
            ref={inputRef}
            autoFocus
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={resetName || "Chat name"}
          />
        </label>

        <p className="mb-5 text-xs text-fg-subtle" data-testid="rename-hint">
          {willReset ? (
            <>
              Clearing the name resets it to
              {resetName ? (
                <>
                  {" "}
                  <span className="font-medium text-fg-muted">
                    {resetName}
                  </span>
                  .
                </>
              ) : (
                " the chat's generated name."
              )}
            </>
          ) : (
            "Clear the box to reset it to the generated name."
          )}
        </p>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary">
            {willReset ? "Reset name" : "Rename"}
          </button>
        </div>
      </form>
    </div>
  );
}
