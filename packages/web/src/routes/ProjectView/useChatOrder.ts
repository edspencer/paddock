import { useCallback, useMemo } from "react";
import { api } from "../../lib/api";
import { buildChatTree, currentOrders, flatForest, type ChatSort } from "../../lib/chatTree";
import type { Chat, ListOrder, SortMode } from "../../lib/types";
import { useListOrder } from "../../lib/useListOrder";
import type { ChatViewPrefs } from "./useChatViewPrefs";

/** The two populations and two layouts that keep separate manual orders. */
const POPULATIONS = ["active", "archived"] as const;
const LAYOUTS = ["nested", "flat"] as const;

/**
 * Every sibling group's current order, for both populations in both layouts,
 * as ordered by `order` right now. Seeding Manual from this is what keeps the
 * list still at the moment it switches — including the layout not on screen,
 * so flipping nested/flat afterwards does not reshuffle either.
 */
export function seedChatOrders(chats: readonly Chat[], order: ListOrder): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const population of POPULATIONS) {
    const members = chats.filter((c) => !!c.archived === (population === "archived"));
    for (const layout of LAYOUTS) {
      const scope = `${population}:${layout}`;
      const sort: ChatSort = { ...order, scope };
      const forest = layout === "nested" ? buildChatTree(members, sort) : flatForest(members, sort);
      Object.assign(out, currentOrders(forest, scope));
    }
  }
  return out;
}

export interface ChatOrder {
  mode: SortMode;
  /** How the active list's forest is ordered. */
  activeSort: ChatSort;
  /** How the Archived list's forest is ordered. */
  archivedSort: ChatSort;
  /**
   * Switch mode. Switching TO Manual keeps any group the user already placed
   * and seeds every other group from its current order, so the groups nobody
   * has arranged stay where they are.
   */
  setMode: (mode: SortMode) => void;
  /** The last failed save, for a toast. */
  error: string | null;
  clearError: () => void;
}

/**
 * The open workspace's chat-list ordering: server-backed (`/chat-order`), so it
 * follows the user across devices, and re-loaded per workspace.
 *
 * The running-only filter renders one flat list that mixes both populations;
 * it borrows the active flat order, so an archived chat that is running sits
 * at the top as unplaced.
 */
export function useChatOrder(
  slug: string,
  chats: readonly Chat[],
  viewPrefs: Pick<ChatViewPrefs, "nested" | "runningOnly">,
): ChatOrder {
  const { order, update, error, clearError } = useListOrder(
    slug,
    () => api.getChatOrder(slug),
    (patch) => api.patchChatOrder(slug, patch),
  );

  const layout = viewPrefs.runningOnly || !viewPrefs.nested ? "flat" : "nested";
  const activeSort = useMemo(() => ({ ...order, scope: `active:${layout}` }), [order, layout]);
  const archivedSort = useMemo(() => ({ ...order, scope: `archived:${layout}` }), [order, layout]);

  const setMode = useCallback(
    (mode: SortMode) => {
      if (mode !== "manual" || order.mode === "manual") {
        void update({ mode });
        return;
      }
      const seed = seedChatOrders(chats, order);
      for (const key of Object.keys(order.orders)) delete seed[key];
      void update({ mode, orders: seed });
    },
    [chats, order, update],
  );

  return { mode: order.mode, activeSort, archivedSort, setMode, error, clearError };
}
