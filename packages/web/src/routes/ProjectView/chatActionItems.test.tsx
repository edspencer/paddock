import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { type ChatActionContext, type ChatActionItem, chatActionItems } from "./chatActionItems";
import type { ChatNode } from "../../lib/chatTree";
import type { Chat } from "../../lib/types";
import { makeChat } from "../../test/factories";

/**
 * The one definition of a chat's actions. ChatActions' DOM is covered through
 * ProjectView; these pin the list itself: which actions apply, their order, and
 * what a Shift-click targets and says.
 */

function ctx(over: Partial<ChatActionContext> = {}): ChatActionContext {
  return {
    unread: new Set(),
    requestFork: vi.fn(),
    setPromotingChat: vi.fn(),
    setRenamingChat: vi.fn(),
    archiveChat: vi.fn(async () => {}),
    requestDeleteChat: vi.fn(),
    toggleUnread: vi.fn(async () => {}),
    starChat: vi.fn(async () => {}),
    detachChat: vi.fn(async () => {}),
    ...over,
  };
}

function node(chat: Chat, depth: number, children: ChatNode[] = []): ChatNode {
  const count = (ns: ChatNode[]): number => ns.reduce((n, c) => n + 1 + count(c.children), 0);
  return { chat, children, depth, descendantCount: count(children) };
}

const ids = (items: ChatActionItem[]) => items.map((i) => i.id);
const find = (items: ChatActionItem[], id: ChatActionItem["id"]) => {
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`no ${id} item`);
  return item;
};
const tooltipText = (item: ChatActionItem) => render(<>{item.tooltip}</>).container.textContent;

const parent = makeChat({ sessionId: "p", name: "Parent" });
const child = makeChat({ sessionId: "c", name: "Child" });
const grandchild = makeChat({ sessionId: "g", name: "Grandchild" });

describe("chatActionItems", () => {
  it("lists the actions in display order, promote included at the root", () => {
    expect(ids(chatActionItems(parent, node(parent, 0), ctx()))).toEqual([
      "fork",
      "promote",
      "rename",
      "archive",
      "delete",
      "unread",
      "star",
    ]);
  });

  it("omits promote when setPromotingChat is undefined (not the root)", () => {
    const items = chatActionItems(parent, node(parent, 0), ctx({ setPromotingChat: undefined }));
    expect(ids(items)).not.toContain("promote");
  });

  it("adds detach last only for a nested chat", () => {
    expect(ids(chatActionItems(child, node(child, 1), ctx())).at(-1)).toBe("detach");
    expect(ids(chatActionItems(parent, node(parent, 0), ctx()))).not.toContain("detach");
    expect(ids(chatActionItems(parent, undefined, ctx()))).not.toContain("detach");
  });

  it("flips archive, read/unread and star with the chat's state", () => {
    const plain = chatActionItems(parent, undefined, ctx());
    expect(find(plain, "archive").ariaLabel).toBe("Archive chat Parent");
    expect(find(plain, "unread").ariaLabel).toBe("Mark chat Parent unread");
    expect(find(plain, "unread").pressed).toBe(false);
    expect(find(plain, "star").ariaLabel).toBe("Star chat Parent");
    expect(find(plain, "star").pressed).toBe(false);

    const flipped = makeChat({ sessionId: "p", name: "Parent", archived: true, starred: true });
    const items = chatActionItems(flipped, undefined, ctx({ unread: new Set(["p"]) }));
    expect(find(items, "archive").ariaLabel).toBe("Unarchive chat Parent");
    expect(find(items, "archive").className).toContain("text-accent");
    expect(find(items, "unread").ariaLabel).toBe("Mark chat Parent read");
    expect(find(items, "unread").pressed).toBe(true);
    expect(find(items, "star").ariaLabel).toBe("Unstar chat Parent");
    expect(find(items, "star").className).toContain("text-warn");
    expect(find(items, "star").pressed).toBe(true);
  });

  it("targets the whole subtree on Shift-click and says so, for a chat with descendants", () => {
    const c = ctx();
    const tree = node(parent, 0, [node(child, 1, [node(grandchild, 2)])]);
    const items = chatActionItems(parent, tree, c);

    expect(find(items, "archive").ariaLabel).toBe(
      "Archive chat Parent (Shift-click to archive all 3)",
    );
    expect(find(items, "delete").ariaLabel).toBe(
      "Delete chat Parent (Shift-click to delete all 3)",
    );
    expect(find(items, "unread").ariaLabel).toBe(
      "Mark chat Parent unread (Shift-click to mark all 3 unread)",
    );
    expect(tooltipText(find(items, "delete"))).toBe("Delete chat · Shift-click to delete all 3");

    find(items, "archive").onActivate({ shiftKey: true });
    expect(c.archiveChat).toHaveBeenCalledWith(parent, ["p", "c", "g"]);
    find(items, "delete").onActivate({ shiftKey: false });
    expect(c.requestDeleteChat).toHaveBeenCalledWith(parent, ["p"]);
    find(items, "unread").onActivate({ shiftKey: true });
    expect(c.toggleUnread).toHaveBeenCalledWith(parent, ["p", "c", "g"]);
  });

  it("treats Shift-click on a leaf as a plain click, with no Shift-click wording", () => {
    const c = ctx();
    const items = chatActionItems(grandchild, node(grandchild, 2), c);

    expect(find(items, "archive").ariaLabel).toBe("Archive chat Grandchild");
    expect(find(items, "delete").ariaLabel).toBe("Delete chat Grandchild");
    expect(tooltipText(find(items, "delete"))).toBe("Delete chat");

    find(items, "archive").onActivate({ shiftKey: true });
    expect(c.archiveChat).toHaveBeenCalledWith(grandchild, ["g"]);
    find(items, "delete").onActivate({ shiftKey: true });
    expect(c.requestDeleteChat).toHaveBeenCalledWith(grandchild, ["g"]);
  });

  it("counts the nested chats detach will carry", () => {
    const withKids = chatActionItems(child, node(child, 1, [node(grandchild, 2)]), ctx());
    expect(find(withKids, "detach").tooltip).toBe(
      "Detach from parent — move this chat and its 1 nested chat to the top level",
    );
    const leaf = chatActionItems(child, node(child, 1), ctx());
    expect(find(leaf, "detach").tooltip).toBe(
      "Detach from parent — move this chat to the top level",
    );
  });
});
