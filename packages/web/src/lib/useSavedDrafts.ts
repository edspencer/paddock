import { useEffect, useRef, useState } from "react";
import { DRAFTS_CHANGED_EVENT, draftPreview, isDraftKey, listDrafts } from "./draft";

/**
 * Every unsent draft saved in this browser, as draft id -> preview, minus
 * `exclude` (the chat open in this tab, whose draft is already on screen in
 * its composer) and minus whitespace-only drafts.
 *
 * Rescans on the same-tab {@link DRAFTS_CHANGED_EVENT} and on a cross-tab
 * `storage` event for a draft key. A rescan is one prefix-filtered pass over
 * localStorage, and it is skipped outright for writes to `exclude` — which is
 * every keystroke in the open composer. State changes only when the result
 * does, so a rescan that finds the same previews re-renders nothing.
 */
export function useSavedDrafts(exclude: string | null): ReadonlyMap<string, string> {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map());
  const digestRef = useRef("");
  useEffect(() => {
    const scan = () => {
      const next = new Map<string, string>();
      for (const [id, text] of listDrafts()) {
        if (id === exclude) continue;
        const preview = draftPreview(text);
        if (preview) next.set(id, preview);
      }
      const digest = JSON.stringify([...next]);
      if (digest === digestRef.current) return;
      digestRef.current = digest;
      setDrafts(next);
    };
    const onChanged = (e: Event) => {
      const ids = (e as CustomEvent<{ ids?: string[] }>).detail?.ids ?? [];
      if (ids.length > 0 && ids.every((id) => id === exclude)) return;
      scan();
    };
    // `key` is null when another tab cleared the whole store.
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || isDraftKey(e.key)) scan();
    };
    scan();
    window.addEventListener(DRAFTS_CHANGED_EVENT, onChanged);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(DRAFTS_CHANGED_EVENT, onChanged);
      window.removeEventListener("storage", onStorage);
    };
  }, [exclude]);
  return drafts;
}
