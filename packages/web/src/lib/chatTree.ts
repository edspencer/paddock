/**
 * Chat-tree construction for the nested sidebar: turns the flat, mtime-ordered
 * chat list into a forest where a chat created by another chat is filed under it.
 *
 * The parent edge arrives on `chat.parent` (recorded at creation, or backfilled
 * server-side from the injected kickoff message). Everything here is pure so the
 * ordering rules can be tested without rendering.
 *
 * Three rules earn their keep, because the flat list's behaviour does not survive
 * nesting unchanged:
 *
 *  1. **Sort by newest DESCENDANT, not own time.** Nest naively and a burst of
 *     fresh children strands their parent far down the list — you'd see the
 *     activity but not the chat that owns it. In the default "most recent reply"
 *     mode each subtree therefore sorts by the newest reply anywhere within it,
 *     so an active family rises as a unit.
 *  2. **Star floats within a sibling group, not globally.** A global float (the
 *     flat list's rule) would tear a starred child out from under its parent.
 *  3. **A parent outside the visible set becomes a root.** Cross-project parents,
 *     archived parents, and search-filtered parents would otherwise silently
 *     swallow their children.
 *
 * Every sibling group is ordered by one of three {@link SortMode}s:
 *
 *  - `recent` (the default): starred first, then by the newest REPLY in the
 *    subtree — `lastTurnCompletedAt`, else `updatedAt` for a chat with no
 *    completed-turn record (session-mode chats may have none).
 *  - `created`: starred first, then by the chat's OWN creation time
 *    (`createdAt`, else `updatedAt`), newest first. No family roll-up: a
 *    creation time never changes, and spawning a child is not a reason for the
 *    parent to move.
 *  - `manual`: the user's drag order for that group (see {@link groupKey}).
 *    Stars do not float. A chat the order does not name yet — a new chat, or one
 *    just archived into the other population — goes at the top of its group,
 *    newest reply first, until it is placed.
 */
import type { Chat, SortMode } from "./types";

export interface ChatNode {
  chat: Chat;
  children: ChatNode[];
  /** Nesting level; 0 for roots. Drives indentation. */
  depth: number;
  /** Total descendants, all levels — the collapsed-row count. */
  descendantCount: number;
}

/**
 * How one forest is ordered: the mode, the stored manual orders, and the scope
 * — `<population>:<layout>`, e.g. `active:nested` — that prefixes each of this
 * forest's group keys, so the active and Archived lists, and the nested and flat
 * views, keep separate manual orders.
 */
export interface ChatSort {
  mode: SortMode;
  orders: Readonly<Record<string, readonly string[]>>;
  scope: string;
}

const DEFAULT_SORT: ChatSort = { mode: "recent", orders: {}, scope: "" };

/**
 * The key of one sibling group's manual order: the scope plus the parent's
 * session id, empty for the top level. The server relies on the parent id being
 * the LAST colon-separated segment, to drop a deleted parent's group.
 */
export function groupKey(scope: string, parentId: string | null): string {
  return `${scope}:${parentId ?? ""}`;
}

/** The first of `stamps` that parses, as epoch ms; 0 when none does. */
function firstTime(...stamps: (string | undefined)[]): number {
  for (const s of stamps) {
    const t = s ? Date.parse(s) : NaN;
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/** When the assistant last replied in a chat, as epoch ms. */
export function replyAt(chat: Chat): number {
  return firstTime(chat.lastTurnCompletedAt, chat.updatedAt);
}

/** When a chat was created, as epoch ms. */
export function createdAt(chat: Chat): number {
  return firstTime(chat.createdAt, chat.updatedAt);
}

/** Newest reply anywhere in this subtree, as epoch ms. */
function subtreeReplyAt(node: ChatNode): number {
  return node.children.reduce((max, c) => Math.max(max, subtreeReplyAt(c)), replyAt(node.chat));
}

/**
 * Order one sibling group by `sort` (see the module comment), then recurse into
 * each node's children. Mutates in place, so the whole forest is ordered in one
 * pass.
 */
function sortGroup(nodes: ChatNode[], sort: ChatSort, parentId: string | null): void {
  for (const n of nodes) sortGroup(n.children, sort, n.chat.sessionId);
  if (sort.mode === "manual") {
    const rank = new Map(
      (sort.orders[groupKey(sort.scope, parentId)] ?? []).map((id, i) => [id, i]),
    );
    nodes.sort((a, b) => {
      const ra = rank.get(a.chat.sessionId) ?? -1;
      const rb = rank.get(b.chat.sessionId) ?? -1;
      if (ra !== rb) return ra - rb;
      return subtreeReplyAt(b) - subtreeReplyAt(a);
    });
    return;
  }
  nodes.sort((a, b) => {
    if (!!a.chat.starred !== !!b.chat.starred) return a.chat.starred ? -1 : 1;
    return sort.mode === "created"
      ? createdAt(b.chat) - createdAt(a.chat)
      : subtreeReplyAt(b) - subtreeReplyAt(a);
  });
}

/**
 * Every sibling group's CURRENT order in a forest, keyed by {@link groupKey}:
 * the top level, and the children of each node that has any. Switching a list
 * to Manual seeds its orders from this, so nothing moves at the switch.
 */
export function currentOrders(roots: readonly ChatNode[], scope: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const walk = (nodes: readonly ChatNode[], parentId: string | null) => {
    out[groupKey(scope, parentId)] = nodes.map((n) => n.chat.sessionId);
    for (const n of nodes) if (n.children.length > 0) walk(n.children, n.chat.sessionId);
  };
  if (roots.length > 0) walk(roots, null);
  return out;
}

/** Depth + descendant totals, assigned once the shape is final. */
function annotate(nodes: ChatNode[], depth: number): number {
  let total = 0;
  for (const n of nodes) {
    n.depth = depth;
    n.descendantCount = annotate(n.children, depth + 1);
    total += 1 + n.descendantCount;
  }
  return total;
}

/**
 * Build the forest for one population (active or archived).
 *
 * `chats` is the already-filtered set — the caller decides what's visible, and any
 * chat whose parent isn't in that set surfaces as a root rather than vanishing.
 * Cycles (which a corrupt or hand-edited sidecar could introduce) are broken by
 * walking to the root before linking: a chat that reaches itself becomes a root.
 */
export function buildChatTree(chats: readonly Chat[], sort: ChatSort = DEFAULT_SORT): ChatNode[] {
  const byId = new Map<string, ChatNode>();
  for (const chat of chats) {
    byId.set(chat.sessionId, { chat, children: [], depth: 0, descendantCount: 0 });
  }

  const roots: ChatNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.chat.parent?.sessionId;
    const parent = parentId ? byId.get(parentId) : undefined;
    // No edge, or a parent outside this population (cross-project, archived,
    // filtered out) — rule 3.
    if (!parent || parent === node || createsCycle(node, parent, byId)) {
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }

  sortGroup(roots, sort, null);
  annotate(roots, 0);
  return roots;
}

/**
 * The same population as a FLAT list: every chat its own root, nothing nested.
 *
 * Used by the flat view option and by the running-only filter, which must render
 * flat — a running child sitting under its running parent would reintroduce the
 * indentation the filter exists to strip away.
 *
 * Ordering comes from the same `sortGroup` the tree uses, which is the point: a
 * forest with no children reduces it to "starred first, then newest first", i.e.
 * exactly the global star float that was the flat list's rule before nesting
 * arrived (rule 2 above describes what nesting had to change it to). Reusing the
 * comparator rather than restating it is what keeps the two views consistent.
 * In Manual the flat list is one group, keyed `<scope>:`.
 */
export function flatForest(chats: readonly Chat[], sort: ChatSort = DEFAULT_SORT): ChatNode[] {
  const roots: ChatNode[] = chats.map((chat) => ({
    chat,
    children: [],
    depth: 0,
    descendantCount: 0,
  }));
  sortGroup(roots, sort, null);
  return roots;
}

/** Would linking `node` under `parent` close a loop? Walks parent's ancestry. */
function createsCycle(node: ChatNode, parent: ChatNode, byId: Map<string, ChatNode>): boolean {
  const seen = new Set<string>([node.chat.sessionId]);
  let cur: ChatNode | undefined = parent;
  while (cur) {
    if (seen.has(cur.chat.sessionId)) return true;
    seen.add(cur.chat.sessionId);
    const nextId: string | undefined = cur.chat.parent?.sessionId;
    cur = nextId ? byId.get(nextId) : undefined;
  }
  return false;
}

/**
 * How many CHATS a forest holds, all levels — not how many roots (#491).
 *
 * `ChatNode[]` reads like the old flat chat array but isn't one: `roots.length`
 * counts only top-level chats, so any sidebar count taken from it silently
 * undercounts the moment one chat nests under another (a search matching five
 * siblings of one parent read `1/40`). Every count the UI shows is a chat count,
 * so it goes through here.
 */
export function countNodes(nodes: readonly ChatNode[]): number {
  // Walks `children` rather than trusting `descendantCount`, so it is correct for
  // a forest that hasn't been through annotate() (tests, or a partial subtree).
  return nodes.reduce((n, node) => n + 1 + countNodes(node.children), 0);
}

/**
 * The session ids of a subtree: the node itself first, then every descendant at
 * every level (#508). This is what a Shift-click on archive / delete / mark-read
 * applies to, so it must match the `descendantCount` the collapsed-row pill and
 * the tooltips promise — `subtreeIds(n).length === n.descendantCount + 1`.
 *
 * Recursive by construction. Depth ≥ 2 is unreachable while `maxSpawnDepth`
 * defaults to 1, so today's trees are one level deep in practice — but a config
 * bump or a fork-of-a-child produces deeper ones, and "delete this chat and its
 * nested chats" silently missing a grandchild is not a bug anyone would notice
 * until it had already happened.
 */
export function subtreeIds(node: ChatNode): string[] {
  const out: string[] = [node.chat.sessionId];
  const walk = (nodes: readonly ChatNode[]) => {
    for (const n of nodes) {
      out.push(n.chat.sessionId);
      walk(n.children);
    }
  };
  walk(node.children);
  return out;
}

/**
 * Every descendant of `rootId` within `all`, at every level — computed from the
 * FLAT chat list rather than a built tree (#508).
 *
 * {@link subtreeIds} answers "what will this action touch", and is read off the
 * rendered tree so it can never promise more than the user can see. This answers
 * the different question "what else is attached to this chat", including chats
 * a search has filtered out of the rendered tree — which is what lets the delete
 * dialog disclose the children that will be ORPHANED rather than deleted.
 *
 * `all` should already be narrowed to one population (active or archived), since
 * that is the granularity `buildChatTree` nests at. The seen-set makes a corrupt
 * or hand-edited parent cycle terminate instead of hanging the dialog.
 */
export function descendantIds(all: readonly Chat[], rootId: string): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const c of all) {
    const parentId = c.parent?.sessionId;
    if (!parentId) continue;
    const siblings = childrenOf.get(parentId);
    if (siblings) siblings.push(c.sessionId);
    else childrenOf.set(parentId, [c.sessionId]);
  }
  const out: string[] = [];
  const seen = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length) {
    for (const kid of childrenOf.get(stack.pop()!) ?? []) {
      if (seen.has(kid)) continue;
      seen.add(kid);
      out.push(kid);
      stack.push(kid);
    }
  }
  return out;
}

/**
 * Flatten the forest to the rows actually rendered, skipping the subtrees of
 * collapsed parents. Returning a flat array (rather than recursing in the
 * component) keeps the row markup — and its absolutely-positioned hover action
 * strip — exactly as it is today; only left padding changes per depth.
 */
export function flattenTree(
  roots: readonly ChatNode[],
  collapsed: ReadonlySet<string>,
): ChatNode[] {
  const out: ChatNode[] = [];
  const walk = (nodes: readonly ChatNode[]) => {
    for (const n of nodes) {
      out.push(n);
      if (!collapsed.has(n.chat.sessionId)) walk(n.children);
    }
  };
  walk(roots);
  return out;
}

/**
 * Keep every chat matching `predicate` PLUS its ancestors, so a matching child is
 * never orphaned by a non-matching parent. Ancestors kept only as scaffolding
 * still render (greyed by the caller if desired) — dropping them would reparent
 * matches to the root and lose the grouping the search is being read against.
 *
 * `all` must be the unfiltered list: an ancestor can sit outside the matches.
 */
export function withAncestors(all: readonly Chat[], matches: readonly Chat[]): Chat[] {
  const byId = new Map(all.map((c) => [c.sessionId, c]));
  const keep = new Set<string>();
  for (const m of matches) {
    let cur: Chat | undefined = m;
    const guard = new Set<string>();
    while (cur && !guard.has(cur.sessionId)) {
      guard.add(cur.sessionId);
      keep.add(cur.sessionId);
      const pid: string | undefined = cur.parent?.sessionId;
      cur = pid ? byId.get(pid) : undefined;
    }
  }
  // Preserve the input order; the tree builder re-sorts anyway.
  return all.filter((c) => keep.has(c.sessionId));
}
