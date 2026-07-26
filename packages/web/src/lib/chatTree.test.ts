import { describe, it, expect } from "vitest";
import { buildChatTree, flattenTree, withAncestors } from "./chatTree";
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
