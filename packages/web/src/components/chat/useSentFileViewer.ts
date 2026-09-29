import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SentFile } from "../../lib/types";
import type { Turn } from "./turnModel";
import { sentFileStableKey } from "../SentFileBlock";
import type { SentFileViewerProps } from "../SentFileViewer";

interface Current {
  id: string;
  file: SentFile;
  /** Opened from a file the list doesn't hold (a sub-agent's step): no ←/→. */
  single: boolean;
}

/**
 * State for the chat's full-screen sent-file viewer (#944).
 *
 * The list it steps through is derived from the RENDERED turns and nothing else.
 * That is deliberate, because of the render cap (#914): the server withholds
 * everything older than the cap, and a list sourced anywhere else could hold a
 * file with no row on screen to scroll back to. Instead, stepping back past the
 * oldest loaded file — when the cap withheld anything — asks the pane to load
 * the rest (`loadEarlier`), which puts those files in the transcript AND the
 * list in the same update, then carries on.
 */
export function useSentFileViewer({
  turns,
  omitted,
  loadEarlier,
  reveal,
}: {
  turns: Turn[];
  /** How many older messages the render cap withheld (0 ⇒ the whole chat is here). */
  omitted: number;
  /** Load the withheld messages into the transcript; absent where there is no history. */
  loadEarlier?: () => Promise<void>;
  /** Bring the sent file's row into view behind the viewer. */
  reveal: (turnId: string) => void;
}) {
  const items = useMemo(
    () =>
      turns.flatMap((t) => (t.kind === "file" ? [{ id: t.id, file: t.file }] : [])),
    [turns],
  );
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const [current, setCurrent] = useState<Current | null>(null);
  const [earlier, setEarlier] = useState<"idle" | "loading" | "none" | "error">("idle");
  const [pendingBack, setPendingBack] = useState(false);
  // A request, not state: the nonce makes stepping to the same row twice
  // (→ then ←) scroll again.
  const [revealReq, setRevealReq] = useState<{ id: string; nonce: number } | null>(null);

  // Find the current file by turn id, falling back to the file's own identity:
  // a reload re-keys a turn that was live (its counter id becomes the transcript
  // uuid), and the viewer should stay on the same file across that.
  const index = useMemo(() => {
    if (!current || current.single) return -1;
    const byId = items.findIndex((i) => i.id === current.id);
    if (byId !== -1) return byId;
    const key = sentFileStableKey(current.file);
    return items.findIndex((i) => sentFileStableKey(i.file) === key);
  }, [items, current]);

  // The file left the transcript (a revert cut it away): nothing to show.
  useEffect(() => {
    if (current && !current.single && index === -1) setCurrent(null);
  }, [current, index]);

  const go = useCallback((i: number) => {
    const item = itemsRef.current[i];
    if (!item) return;
    setCurrent({ id: item.id, file: item.file, single: false });
    setEarlier("idle");
    setRevealReq((prev) => ({ id: item.id, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    if (revealReq) reveal(revealReq.id);
  }, [revealReq, reveal]);

  const withheld = omitted > 0 && !!loadEarlier;
  const prev = useCallback(() => {
    if (!current || current.single) return;
    if (index > 0) return go(index - 1);
    if (index !== 0 || !withheld || earlier === "loading") return;
    setEarlier("loading");
    loadEarlier!()
      .then(() => setPendingBack(true))
      .catch(() => setEarlier("error"));
  }, [current, index, go, withheld, earlier, loadEarlier]);

  // The rest of the chat has landed: step onto the file before the one we were
  // on, if the older messages held one.
  useEffect(() => {
    if (!pendingBack) return;
    setPendingBack(false);
    if (index > 0) go(index - 1);
    else setEarlier("none");
  }, [pendingBack, index, go]);

  const next = useCallback(() => {
    if (current && !current.single && index < items.length - 1) go(index + 1);
  }, [current, index, items.length, go]);

  const close = useCallback(() => {
    setCurrent(null);
    setEarlier("idle");
  }, []);

  const context = useMemo(
    () => ({
      open: (turnId: string, file: SentFile) => {
        const single = !itemsRef.current.some((i) => i.id === turnId);
        setCurrent({ id: turnId, file, single });
        setEarlier("idle");
      },
    }),
    [],
  );

  const viewer: SentFileViewerProps | null = current
    ? {
        // Prefer the list's copy: it is the freshest render of this file.
        file: index === -1 ? current.file : items[index].file,
        position: index === -1 ? null : { index, total: items.length },
        canPrev: index > 0 || (index === 0 && withheld),
        canNext: index !== -1 && index < items.length - 1,
        earlier: index === 0 ? (withheld && earlier === "idle" ? "withheld" : earlier) : "idle",
        onPrev: prev,
        onNext: next,
        onClose: close,
      }
    : null;

  return { context, viewer };
}
