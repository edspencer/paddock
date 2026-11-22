import { useCallback, useEffect, useRef, useState } from "react";
import type { ListOrder, ListOrderPatch } from "./types";

const DEFAULT_ORDER: ListOrder = { mode: "recent", orders: {} };

/** Apply a patch the way the server does: replace named groups, delete `null` / `[]` ones. */
export function applyListOrderPatch(order: ListOrder, patch: ListOrderPatch): ListOrder {
  const orders = { ...order.orders };
  for (const [key, ids] of Object.entries(patch.orders ?? {})) {
    if (ids === null || ids.length === 0) delete orders[key];
    else orders[key] = ids;
  }
  return { mode: patch.mode ?? order.mode, orders };
}

export interface ListOrderState {
  order: ListOrder;
  /**
   * Apply a patch optimistically, then persist it after every earlier save;
   * on failure, resyncs from the server. Resolves once that is done.
   */
  update: (patch: ListOrderPatch) => Promise<void>;
  /** The last failed save's message, for a toast; cleared by `clearError`. */
  error: string | null;
  clearError: () => void;
}

/**
 * One sidebar list's server-backed ordering (server `list-order.ts`).
 *
 * Loads on mount and whenever `key` changes (the chat list re-keys per
 * workspace), showing the default meanwhile. A failed load also leaves the
 * default — the list still renders, just by most recent reply. A save is
 * optimistic: the list moves at once. Saves go to the server one at a time, in
 * the order they were made, so a slow PATCH cannot land after a newer one; and
 * since a failed save leaves no exact state to roll back to once others have
 * been made on top, a failure reloads the server's order and re-applies the
 * saves still queued behind it.
 *
 * `load` and `save` are read through a ref, so callers may pass inline closures.
 */
export function useListOrder(
  key: string,
  load: () => Promise<ListOrder>,
  save: (patch: ListOrderPatch) => Promise<unknown>,
): ListOrderState {
  const [order, setOrder] = useState<ListOrder>(DEFAULT_ORDER);
  const [error, setError] = useState<string | null>(null);
  const io = useRef({ load, save });
  io.current = { load, save };
  // The order on screen, readable synchronously inside `update` (two updates
  // can overlap) so each one builds on the last.
  const current = useRef(order);
  current.current = order;
  // Bumped by every update, so a load that lands AFTER the user already changed
  // something does not overwrite their change with the older server state.
  const edits = useRef(0);
  const keyRef = useRef(key);
  keyRef.current = key;
  // The tail of the save queue (it never rejects), how many saves are in it
  // (each counting until its post-failure reload is done), and the patches made
  // but not yet acknowledged, oldest first.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const queued = useRef(0);
  const unsaved = useRef<ListOrderPatch[]>([]);

  useEffect(() => {
    let live = true;
    const since = edits.current;
    setOrder(DEFAULT_ORDER);
    void (async () => {
      try {
        const loaded = await io.current.load();
        if (live && edits.current === since) setOrder(loaded);
      } catch {
        /* keep the default */
      }
    })();
    return () => {
      live = false;
    };
  }, [key]);

  const update = useCallback((patch: ListOrderPatch) => {
    edits.current += 1;
    const next = applyListOrderPatch(current.current, patch);
    current.current = next;
    setOrder(next);
    unsaved.current = [...unsaved.current, patch];
    // Bound now: a re-keyed list must not receive this list's save or reload.
    const { load, save } = io.current;
    const forKey = keyRef.current;
    const run = async () => {
      try {
        let failed = false;
        try {
          await save(patch);
        } catch (e) {
          failed = true;
          setError(e instanceof Error ? e.message : "Failed to save the list order");
        }
        unsaved.current = unsaved.current.slice(1);
        if (!failed || keyRef.current !== forKey) return;
        try {
          const shown = unsaved.current.reduce(applyListOrderPatch, await load());
          if (keyRef.current !== forKey) return;
          current.current = shown;
          setOrder(shown);
        } catch {
          /* the error is already shown; leave the list as it is */
        }
      } finally {
        queued.current -= 1;
      }
    };
    // With nothing ahead of it, the save starts now rather than a tick later.
    const done = queued.current++ === 0 ? run() : queue.current.then(run);
    queue.current = done;
    return done;
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { order, update, error, clearError };
}
