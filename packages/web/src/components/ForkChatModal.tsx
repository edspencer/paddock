import { useEffect, useRef, useState } from "react";
import { XIcon } from "./icons";
import { useEscapeKey } from "../lib/useEscapeKey";

/**
 * Name a fork before creating it (issue #279). Forking used to fire eagerly on
 * button click, titling the copy "Fork of <parent>" with no chance to rename.
 * This dialog pops first, prefilled with that same default in an auto-focused,
 * fully-selected input — so the user can hit Enter to accept it or just start
 * typing to replace it. Submit hands the (trimmed) name back to the caller,
 * which still owns the actual fork + lineage + navigation.
 */
export function ForkChatModal({
  open,
  chatName,
  onClose,
  onFork,
}: {
  open: boolean;
  chatName: string;
  onClose: () => void;
  onFork: (name: string) => void;
}) {
  const defaultName = `Fork of ${chatName}`;
  const [name, setName] = useState(defaultName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName(defaultName);
      // autoFocus only focuses (caret at the end); select the prefilled text so
      // the first keystroke replaces the default rather than appending to it.
      const input = inputRef.current;
      if (input) {
        input.focus();
        input.select();
        // …then scroll back to the start. `select()` leaves the focus end of the
        // selection at the last character, and the browser scrolls to show it —
        // so a chat named after a long first prompt opens this dialog showing
        // the TAIL of "Fork of Add a 256-colour fallback for terminals without
        // truecolor, and check the default…", i.e. a mid-sentence fragment with
        // no visible "Fork of" and no clue which chat it came from.
        // The selection is untouched, so typing still replaces the whole thing.
        input.scrollLeft = 0;
      }
    }
    // defaultName is derived from chatName, so chatName covers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, chatName]);

  useEscapeKey(open, onClose);

  if (!open) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // Whitespace-only names fall back to the default rather than forking blank.
    onFork(name.trim() || defaultName);
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
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Fork chat</h2>
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
          Branches a new chat from this one — the parent&apos;s full history comes along and stays
          resumable. Name the fork, then continue it independently.
        </p>

        <label className="mb-5 block">
          <span className="field-label">Fork name</span>
          <input
            ref={inputRef}
            autoFocus
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={defaultName}
          />
        </label>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary">
            Fork
          </button>
        </div>
      </form>
    </div>
  );
}
