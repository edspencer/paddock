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
  /** Apply a patch optimistically, then persist it; rolls back on failure. */
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
 * optimistic with rollback, the same shape as starring a chat: the list moves at
 * once, and returns to where it was if the server refuses.
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
  // can overlap) so each one builds on the last and rolls back exactly.
  const current = useRef(order);
  current.current = order;
  // Bumped by every update, so a load that lands AFTER the user already changed
  // something does not overwrite their change with the older server state.
  const edits = useRef(0);

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

  const update = useCallback(async (patch: ListOrderPatch) => {
    edits.current += 1;
    const before = current.current;
    const next = applyListOrderPatch(before, patch);
    current.current = next;
    setOrder(next);
    try {
      await io.current.save(patch);
    } catch (e) {
      // Only roll back if nothing newer landed on top in the meantime.
      if (current.current === next) {
        current.current = before;
        setOrder(before);
      }
      setError(e instanceof Error ? e.message : "Failed to save the list order");
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { order, update, error, clearError };
}
