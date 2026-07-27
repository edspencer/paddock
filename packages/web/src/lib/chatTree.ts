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
 *  1. **Sort by newest DESCENDANT, not own mtime.** The flat list is mtime-desc.
 *     Nest naively and a burst of fresh children strands their parent far down the
 *     list — you'd see the activity but not the chat that owns it. Each subtree
 *     therefore sorts by the newest timestamp anywhere within it, so an active
 *     family rises as a unit.
 *  2. **Star floats within a sibling group, not globally.** A global float (the
 *     flat list's rule) would tear a starred child out from under its parent.
 *  3. **A parent outside the visible set becomes a root.** Cross-project parents,
 *     archived parents, and search-filtered parents would otherwise silently
 *     swallow their children.
 */
import type { Chat } from "./types";

export interface ChatNode {
  chat: Chat;
  children: ChatNode[];
  /** Nesting level; 0 for roots. Drives indentation. */
  depth: number;
  /** Total descendants, all levels — the collapsed-row count. */
  descendantCount: number;
}

/** Newest activity anywhere in this subtree, as epoch ms. */
function subtreeMtime(node: ChatNode): number {
  const own = Date.parse(node.chat.updatedAt ?? "") || 0;
  return node.children.reduce((max, c) => Math.max(max, subtreeMtime(c)), own);
}

/**
 * Order one sibling group: starred first (rule 2), then newest subtree first.
 * Mutates in place and recurses, so the whole forest is ordered in one pass.
 */
function sortGroup(nodes: ChatNode[]): void {
  for (const n of nodes) sortGroup(n.children);
  nodes.sort((a, b) => {
    if (!!a.chat.starred !== !!b.chat.starred) return a.chat.starred ? -1 : 1;
    return subtreeMtime(b) - subtreeMtime(a);
  });
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
export function buildChatTree(chats: readonly Chat[]): ChatNode[] {
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

  sortGroup(roots);
  annotate(roots, 0);
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
