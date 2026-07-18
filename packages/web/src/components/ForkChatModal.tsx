import { useEffect, useRef, useState } from "react";
import { XIcon } from "./icons";

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
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // defaultName is derived from chatName, so chatName covers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, chatName, onClose]);

  if (!open) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // Whitespace-only names fall back to the default rather than forking blank.
    onFork(name.trim() || defaultName);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <form
        className="w-full max-w-md animate-scale-in rounded-2xl border border-paddock-200 bg-white p-6 shadow-2xl dark:border-paddock-800 dark:bg-paddock-900"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Fork chat</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-paddock-400 hover:bg-paddock-100 hover:text-paddock-600 dark:hover:bg-paddock-800"
            aria-label="Close"
          >
            <XIcon width={18} height={18} />
          </button>
        </div>
        <p className="mb-5 text-sm text-paddock-500">
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
