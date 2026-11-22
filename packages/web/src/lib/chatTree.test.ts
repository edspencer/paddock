import { describe, it, expect } from "vitest";
import {
  type ChatSort,
  buildChatTree,
  countNodes,
  currentOrders,
  groupKey,
  descendantIds,
  flatForest,
  flattenTree,
  subtreeIds,
  withAncestors,
} from "./chatTree";
import type { Chat } from "./types";

/** Minimal chat; `at` is a bare hour so orderings read plainly. */
function chat(sessionId: string, at: string, parent?: string, extra: Partial<Chat> = {}): Chat {
  return {
    sessionId,
    workingDirectory: "/w",
    name: sessionId,
    updatedAt: `2026-07-25T${at}:00:00.000Z`,
    resumable: true,
    archived: false,
    starred: false,
    ...(parent ? { parent: { project: "p", sessionId: parent } } : {}),
    ...extra,
  } as Chat;
}

const ids = (nodes: { chat: Chat }[]) => nodes.map((n) => n.chat.sessionId);

describe("buildChatTree", () => {
  it("nests a child under its parent", () => {
    const roots = buildChatTree([chat("parent", "10"), chat("child", "11", "parent")]);
    expect(ids(roots)).toEqual(["parent"]);
    expect(ids(roots[0].children)).toEqual(["child"]);
    expect(roots[0].children[0].depth).toBe(1);
  });

  it("sorts a subtree by its newest DESCENDANT, not the parent's own mtime", () => {
    // `old` last spoke at 08:00 but its child is the freshest chat in the list;
    // flat mtime-desc would bury the family below `recent`.
    const roots = buildChatTree([
      chat("recent", "12"),
      chat("old", "08"),
      chat("busy-child", "14", "old"),
    ]);
    expect(ids(roots)).toEqual(["old", "recent"]);
  });

  it("floats a star within its sibling group only, never out of the family", () => {
    const roots = buildChatTree([
      chat("parent", "12"),
      chat("child-new", "13", "parent"),
      chat("child-starred", "09", "parent", { starred: true }),
    ]);
    expect(ids(roots)).toEqual(["parent"]);
    // Starred child leads its siblings despite being the oldest...
    expect(ids(roots[0].children)).toEqual(["child-starred", "child-new"]);
    // ...and critically did NOT get promoted to a root.
    expect(roots).toHaveLength(1);
  });

  it("promotes a chat whose parent is absent to a root", () => {
    // The cross-project case: parent lives in another project's list.
    const roots = buildChatTree([chat("orphan", "10", "elsewhere")]);
    expect(ids(roots)).toEqual(["orphan"]);
    expect(roots[0].depth).toBe(0);
  });

  it("counts all descendants, not just direct children", () => {
    const roots = buildChatTree([
      chat("a", "10"),
      chat("b", "11", "a"),
      chat("c", "12", "b"),
    ]);
    expect(roots[0].descendantCount).toBe(2);
    expect(roots[0].children[0].descendantCount).toBe(1);
  });

  it("breaks a cycle instead of dropping the chats or hanging", () => {
    // A corrupt sidecar could describe a→b→a; neither may vanish from the list.
    const roots = buildChatTree([chat("a", "10", "b"), chat("b", "11", "a")]);
    expect(ids(roots).sort()).toEqual(["a", "b"].slice(0, roots.length).sort());
    expect(roots.length).toBeGreaterThanOrEqual(1);
    const seen = new Set<string>();
    const walk = (ns: ReturnType<typeof buildChatTree>) =>
      ns.forEach((n) => {
        expect(seen.has(n.chat.sessionId)).toBe(false);
        seen.add(n.chat.sessionId);
        walk(n.children);
      });
    walk(roots);
    expect(seen.size).toBe(2);
  });

  it("does not let a self-parenting chat disappear", () => {
    const roots = buildChatTree([chat("self", "10", "self")]);
    expect(ids(roots)).toEqual(["self"]);
  });
});

describe("flattenTree", () => {
  const tree = () =>
    buildChatTree([chat("a", "10"), chat("b", "11", "a"), chat("c", "12", "b"), chat("d", "13")]);

  it("yields every row in depth-first order when nothing is collapsed", () => {
    expect(ids(flattenTree(tree(), new Set()))).toEqual(["d", "a", "b", "c"]);
  });

  it("hides a collapsed parent's whole subtree, not just its direct children", () => {
    expect(ids(flattenTree(tree(), new Set(["a"])))).toEqual(["d", "a"]);
  });

  it("keeps the collapsed parent itself visible", () => {
    expect(ids(flattenTree(tree(), new Set(["b"])))).toEqual(["d", "a", "b"]);
  });
});

describe("withAncestors", () => {
  const all = [chat("root", "10"), chat("mid", "11", "root"), chat("leaf", "12", "mid")];

  it("keeps ancestors of a match so the child isn't orphaned", () => {
    const kept = withAncestors(all, [all[2]]);
    expect(kept.map((c) => c.sessionId)).toEqual(["root", "mid", "leaf"]);
  });

  it("does not pull in descendants of a match", () => {
    const kept = withAncestors(all, [all[0]]);
    expect(kept.map((c) => c.sessionId)).toEqual(["root"]);
  });

  it("terminates on a cyclic ancestry chain", () => {
    const cyclic = [chat("x", "10", "y"), chat("y", "11", "x")];
    expect(withAncestors(cyclic, [cyclic[0]]).map((c) => c.sessionId)).toEqual(["x", "y"]);
  });
});

describe("countNodes (#491)", () => {
  it("counts every chat in the forest, not just the roots", () => {
    // Five chats under one parent: `roots.length` is 1, the answer is 6.
    const siblings = ["c1", "c2", "c3", "c4", "c5"].map((id) => chat(id, "11", "p"));
    const roots = buildChatTree([chat("p", "10"), ...siblings]);
    expect(roots).toHaveLength(1);
    expect(countNodes(roots)).toBe(6);
  });

  it("counts across several levels and several roots", () => {
    const roots = buildChatTree([
      chat("a", "10"),
      chat("b", "11", "a"),
      chat("c", "12", "b"),
      chat("d", "13"),
    ]);
    expect(countNodes(roots)).toBe(4);
  });

  it("is 0 for an empty forest", () => {
    expect(countNodes([])).toBe(0);
  });
});

describe("flatForest", () => {
  it("never nests, even when the parent edge is right there", () => {
    // The case naive filtering gets wrong: a running child under its running
    // parent. buildChatTree would indent it; the flat view must not.
    const roots = flatForest([chat("parent", "10"), chat("child", "11", "parent")]);
    expect(ids(roots)).toEqual(["child", "parent"]);
    expect(roots.every((n) => n.children.length === 0)).toBe(true);
    expect(roots.every((n) => n.depth === 0)).toBe(true);
    expect(roots.every((n) => n.descendantCount === 0)).toBe(true);
  });

  it("floats stars GLOBALLY — the flat list's rule, not the tree's", () => {
    // Nested, `child-starred` could only float within its sibling group. Flat,
    // there are no groups, so it goes to the very top despite being oldest.
    const roots = flatForest([
      chat("parent", "12"),
      chat("child-new", "13", "parent"),
      chat("child-starred", "09", "parent", { starred: true }),
    ]);
    expect(ids(roots)).toEqual(["child-starred", "child-new", "parent"]);
  });

  it("orders by each chat's OWN mtime — no subtree roll-up", () => {
    // `old` has the freshest descendant, which is what lifts it to the top of
    // the tree. Flat, nothing rolls up and it sorts on its own 08:00.
    const roots = flatForest([
      chat("recent", "12"),
      chat("old", "08"),
      chat("busy-child", "14", "old"),
    ]);
    expect(ids(roots)).toEqual(["busy-child", "recent", "old"]);
  });

  it("counts every chat, and flattenTree passes it straight through", () => {
    const roots = flatForest([chat("a", "10"), chat("b", "11", "a"), chat("c", "12", "b")]);
    expect(countNodes(roots)).toBe(3);
    // Collapse is inert with no children — a collapsed id hides nothing.
    expect(ids(flattenTree(roots, new Set(["a"])))).toEqual(["c", "b", "a"]);
  });

  it("is empty for an empty list", () => {
    expect(flatForest([])).toEqual([]);
  });
});

/**
 * subtreeIds (#508) — what a Shift-click on archive / delete / mark-read applies
 * to. The contract that matters is that it agrees with `descendantCount`: the
 * collapsed-row pill and the tooltips promise a number, the confirm dialog
 * repeats it, and the delete is unrecoverable.
 */
describe("subtreeIds (#508)", () => {
  it("is just the chat itself for a leaf", () => {
    const [root] = buildChatTree([chat("a", "10")]);
    expect(subtreeIds(root)).toEqual(["a"]);
  });

  it("includes descendants at EVERY level, not just direct children", () => {
    // a → b → c → d. A non-recursive walk would return three ids and the confirm
    // dialog would then under-count what it is about to delete.
    const [root] = buildChatTree([
      chat("a", "10"),
      chat("b", "11", "a"),
      chat("c", "12", "b"),
      chat("d", "13", "c"),
    ]);
    expect(subtreeIds(root).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("matches descendantCount + 1 — the number the pill and tooltips promise", () => {
    const roots = buildChatTree([
      chat("p", "10"),
      chat("c1", "11", "p"),
      chat("c2", "12", "p"),
      chat("g1", "13", "c1"),
    ]);
    const p = roots[0];
    expect(p.descendantCount).toBe(3);
    expect(subtreeIds(p)).toHaveLength(p.descendantCount + 1);
  });

  it("takes only the clicked chat's branch, never a sibling's", () => {
    const roots = buildChatTree([
      chat("p", "10"),
      chat("c1", "11", "p"),
      chat("c2", "12", "p"),
      chat("g1", "13", "c1"),
    ]);
    const c1 = roots[0].children.find((n) => n.chat.sessionId === "c1")!;
    expect(subtreeIds(c1).sort()).toEqual(["c1", "g1"]);
  });

  it("puts the chat itself first, so the caller can read the target off the head", () => {
    const roots = buildChatTree([chat("p", "10"), chat("c1", "11", "p")]);
    expect(subtreeIds(roots[0])[0]).toBe("p");
  });
});

/**
 * descendantIds (#508 review follow-up) — the flat-list counterpart to
 * `subtreeIds`. `subtreeIds` answers "what will this action touch" from the
 * RENDERED tree; this answers "what else is attached" from the full list, which
 * is what lets the delete dialog disclose the chats it will orphan rather than
 * delete.
 */
describe("descendantIds (#508)", () => {
  const all = [
    chat("p", "10"),
    chat("c1", "11", "p"),
    chat("c2", "12", "p"),
    chat("g1", "13", "c1"),
    chat("other", "14"),
  ];

  it("finds every descendant at every level, and never the chat itself", () => {
    expect(descendantIds(all, "p").sort()).toEqual(["c1", "c2", "g1"]);
    expect(descendantIds(all, "c1")).toEqual(["g1"]);
  });

  it("is empty for a leaf and for an unknown id", () => {
    expect(descendantIds(all, "g1")).toEqual([]);
    expect(descendantIds(all, "nope")).toEqual([]);
  });

  it("sees descendants a filtered TREE would have dropped", () => {
    // The search case: only one child survived the filter, so the rendered tree
    // knows about one descendant while the real family has three.
    const filtered = [all[0], all[1]];
    expect(subtreeIds(buildChatTree(filtered)[0])).toHaveLength(2);
    expect(descendantIds(all, "p")).toHaveLength(3);
  });

  it("terminates on a corrupt parent cycle instead of hanging", () => {
    // A hand-edited sidecar can close a loop; the dialog must still open.
    const cyclic = [chat("a", "10", "b"), chat("b", "11", "a"), chat("c", "12", "a")];
    expect(descendantIds(cyclic, "a").sort()).toEqual(["b", "c"]);
  });
});

describe("sort modes", () => {
  const at = (h: string) => `2026-07-25T${h}:00:00.000Z`;
  const sort = (mode: ChatSort["mode"], orders: ChatSort["orders"] = {}, scope = "active:nested") =>
    ({ mode, orders, scope }) as ChatSort;

  it("groupKey is the scope plus the parent id, empty at the top level", () => {
    expect(groupKey("active:nested", null)).toBe("active:nested:");
    expect(groupKey("archived:flat", "p")).toBe("archived:flat:p");
  });

  describe("most recent reply (the default)", () => {
    it("orders by lastTurnCompletedAt, not by updatedAt", () => {
      // `sent` has the newest message — the user's own, unanswered — but the
      // oldest reply. Reply order is what this mode promises.
      const roots = buildChatTree([
        chat("sent", "15", undefined, { lastTurnCompletedAt: at("09") }),
        chat("replied", "12", undefined, { lastTurnCompletedAt: at("12") }),
      ]);
      expect(ids(roots)).toEqual(["replied", "sent"]);
    });

    it("falls back to updatedAt for a chat with no completed-turn record", () => {
      const roots = flatForest([
        chat("session-mode", "11"),
        chat("replied", "12", undefined, { lastTurnCompletedAt: at("10") }),
      ]);
      expect(ids(roots)).toEqual(["session-mode", "replied"]);
    });

    it("lifts a family by its newest REPLY anywhere in the subtree", () => {
      const roots = buildChatTree([
        chat("quiet", "08", undefined, { lastTurnCompletedAt: at("08") }),
        chat("busy-child", "09", "quiet", { lastTurnCompletedAt: at("14") }),
        chat("other", "12", undefined, { lastTurnCompletedAt: at("12") }),
      ]);
      expect(ids(roots)).toEqual(["quiet", "other"]);
    });
  });

  describe("created", () => {
    it("orders by createdAt newest first, falling back to updatedAt", () => {
      const roots = flatForest(
        [
          chat("old-but-busy", "15", undefined, { createdAt: at("01") }),
          chat("new", "10", undefined, { createdAt: at("09") }),
          chat("undated", "05"),
        ],
        sort("created", {}, "active:flat"),
      );
      expect(ids(roots)).toEqual(["new", "undated", "old-but-busy"]);
    });

    it("does not roll a child's time up into its parent", () => {
      const roots = buildChatTree(
        [
          chat("parent", "08", undefined, { createdAt: at("01") }),
          chat("child", "14", "parent", { createdAt: at("14") }),
          chat("other", "09", undefined, { createdAt: at("05") }),
        ],
        sort("created"),
      );
      expect(ids(roots)).toEqual(["other", "parent"]);
    });

    it("still floats stars within their sibling group", () => {
      const roots = buildChatTree(
        [
          chat("new", "10", undefined, { createdAt: at("09") }),
          chat("starred", "10", undefined, { createdAt: at("01"), starred: true }),
        ],
        sort("created"),
      );
      expect(ids(roots)).toEqual(["starred", "new"]);
    });
  });

  describe("manual", () => {
    it("follows each sibling group's own order in the nested view", () => {
      const roots = buildChatTree(
        [chat("a", "10"), chat("b", "11"), chat("a1", "12", "a"), chat("a2", "13", "a")],
        sort("manual", { "active:nested:": ["a", "b"], "active:nested:a": ["a2", "a1"] }),
      );
      expect(ids(roots)).toEqual(["a", "b"]);
      expect(ids(roots[0].children)).toEqual(["a2", "a1"]);
    });

    it("uses one group in the flat view, separate from the nested one", () => {
      const chats = [chat("a", "10"), chat("b", "11"), chat("c", "12", "a")];
      const orders = { "active:flat:": ["c", "a", "b"], "active:nested:": ["b", "a"] };
      const flat = flatForest(chats, sort("manual", orders, "active:flat"));
      expect(ids(flat)).toEqual(["c", "a", "b"]);
      expect(ids(buildChatTree(chats, sort("manual", orders)))).toEqual(["b", "a"]);
    });

    it("lets the manual order beat a star", () => {
      const roots = flatForest(
        [chat("a", "10"), chat("b", "11", undefined, { starred: true })],
        sort("manual", { "active:flat:": ["a", "b"] }, "active:flat"),
      );
      expect(ids(roots)).toEqual(["a", "b"]);
    });

    it("puts a chat the order does not name at the top, newest reply first", () => {
      const roots = flatForest(
        [chat("placed", "15"), chat("new-old", "10"), chat("new-newer", "11")],
        sort("manual", { "active:flat:": ["placed"] }, "active:flat"),
      );
      expect(ids(roots)).toEqual(["new-newer", "new-old", "placed"]);
    });

    it("keeps the Archived list's order separate from the active list's", () => {
      const orders = { "active:flat:": ["a", "b"], "archived:flat:": ["b", "a"] };
      const chats = [chat("a", "10"), chat("b", "11")];
      expect(ids(flatForest(chats, sort("manual", orders, "active:flat")))).toEqual(["a", "b"]);
      expect(ids(flatForest(chats, sort("manual", orders, "archived:flat")))).toEqual(["b", "a"]);
    });
  });

  it("currentOrders captures every sibling group, ready to seed Manual", () => {
    const chats = [chat("a", "10"), chat("b", "11"), chat("a1", "12", "a"), chat("a2", "13", "a")];
    const roots = buildChatTree(chats, sort("recent"));
    const seeded = currentOrders(roots, "active:nested");
    expect(seeded).toEqual({ "active:nested:": ["a", "b"], "active:nested:a": ["a2", "a1"] });
    // Seeding changes nothing on screen.
    const again = buildChatTree(chats, sort("manual", seeded));
    expect(ids(again)).toEqual(ids(roots));
    expect(ids(again[0].children)).toEqual(ids(roots[0].children));
    expect(currentOrders([], "active:nested")).toEqual({});
  });
});
