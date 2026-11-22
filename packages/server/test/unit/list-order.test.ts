import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ListOrderError,
  ListOrderStore,
  MAX_IDS_PER_GROUP,
  parseListOrderPatch,
} from "../../src/list-order.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/**
 * Unit coverage for the list-order sidecar: defaults, patch semantics,
 * persistence across restarts, corruption tolerance, and the delete cleanups
 * that keep a recycled chat id or project slug from inheriting a slot.
 */
describe("ListOrderStore", () => {
  let dir: string;
  const stateFile = () => path.join(dir, "list-order.json");

  beforeEach(async () => {
    dir = await makeTmpDir("paddock-list-order-");
  });
  afterEach(async () => {
    await rmTmpDir(dir);
  });

  it("defaults to most recent reply with no manual groups, writing nothing on read", async () => {
    const store = new ListOrderStore(dir);
    expect(await store.getChatOrder("p")).toEqual({ mode: "recent", orders: {} });
    expect(await store.getProjectOrder()).toEqual({ mode: "recent", orders: {} });
    await expect(fs.access(stateFile())).rejects.toBeTruthy();
  });

  it("patches mode and groups independently, and persists across a restart", async () => {
    const store = new ListOrderStore(dir);
    await store.patchChatOrder("p", { mode: "manual", orders: { "active:nested:": ["a", "b"] } });
    await store.patchChatOrder("p", { orders: { "active:nested:a": ["c"] } });
    await store.patchProjectOrder({ mode: "created" });
    const reopened = new ListOrderStore(dir);
    expect(await reopened.getChatOrder("p")).toEqual({
      mode: "manual",
      orders: { "active:nested:": ["a", "b"], "active:nested:a": ["c"] },
    });
    expect(await reopened.getChatOrder("other")).toEqual({ mode: "recent", orders: {} });
    expect((await reopened.getProjectOrder()).mode).toBe("created");
  });

  it("deletes a group on null or [], and drops a list back at its default", async () => {
    const store = new ListOrderStore(dir);
    await store.patchChatOrder("p", { orders: { g1: ["a"], g2: ["b"] } });
    await store.patchChatOrder("p", { orders: { g1: null, g2: [] } });
    const raw = JSON.parse(await fs.readFile(stateFile(), "utf8"));
    expect(raw.chats).toEqual({});
  });

  it("keeps the root workspace's key ('') distinct from every project", async () => {
    const store = new ListOrderStore(dir);
    await store.patchChatOrder("", { mode: "created" });
    expect((await store.getChatOrder("")).mode).toBe("created");
    expect((await store.getChatOrder("p")).mode).toBe("recent");
  });

  it("returns copies, so a caller mutating a result cannot change the store", async () => {
    const store = new ListOrderStore(dir);
    await store.patchChatOrder("p", { orders: { g: ["a"] } });
    (await store.getChatOrder("p")).orders.g.push("x");
    expect((await store.getChatOrder("p")).orders.g).toEqual(["a"]);
  });

  it("tolerates a corrupt file, and coerces an unknown mode to the default", async () => {
    await fs.writeFile(stateFile(), "{ not json", "utf8");
    expect(await new ListOrderStore(dir).getChatOrder("p")).toEqual({ mode: "recent", orders: {} });
    await fs.writeFile(
      stateFile(),
      JSON.stringify({ chats: { p: { mode: "sideways", orders: { g: ["a", 3] } } } }),
      "utf8",
    );
    expect(await new ListOrderStore(dir).getChatOrder("p")).toEqual({
      mode: "recent",
      orders: { g: ["a"] },
    });
  });

  it("forgetChats drops the ids from every group, and the groups they parented", async () => {
    const store = new ListOrderStore(dir);
    await store.patchChatOrder("p", {
      mode: "manual",
      orders: {
        "active:nested:": ["a", "b", "c"],
        "active:nested:b": ["b1", "b2"],
        "active:flat:": ["b1", "a"],
        "archived:nested:": ["b"],
      },
    });
    await store.forgetChats("p", ["b", "b1"]);
    expect(await store.getChatOrder("p")).toEqual({
      mode: "manual",
      orders: { "active:nested:": ["a", "c"], "active:flat:": ["a"] },
    });
  });

  it("forgetProject drops the project and those nested in it from both lists", async () => {
    const store = new ListOrderStore(dir);
    await store.patchChatOrder("a", { mode: "manual" });
    await store.patchChatOrder("a/b", { mode: "created" });
    await store.patchChatOrder("ab", { mode: "created" });
    await store.patchProjectOrder({
      mode: "manual",
      orders: { homelab: ["a", "a/b", "ab"], house: ["a/b"] },
    });
    await store.forgetProject("a");
    expect((await store.getChatOrder("a")).mode).toBe("recent");
    expect((await store.getChatOrder("a/b")).mode).toBe("recent");
    // A slug that merely starts with the same letters is a different project.
    expect((await store.getChatOrder("ab")).mode).toBe("created");
    expect(await store.getProjectOrder()).toEqual({ mode: "manual", orders: { homelab: ["ab"] } });
  });

  it("serialises overlapping patches so none is lost", async () => {
    const store = new ListOrderStore(dir);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.patchChatOrder("p", { orders: { [`g${i}`]: ["x"] } }),
      ),
    );
    const reopened = new ListOrderStore(dir);
    expect(Object.keys((await reopened.getChatOrder("p")).orders)).toHaveLength(10);
  });
});

describe("parseListOrderPatch", () => {
  it("accepts a mode and orders, de-duplicating ids first-wins", () => {
    const body = { mode: "manual", orders: { g: ["a", "b", "a"], h: null } };
    expect(parseListOrderPatch(body)).toEqual({
      mode: "manual",
      orders: { g: ["a", "b"], h: null },
    });
    expect(parseListOrderPatch({})).toEqual({});
  });

  it.each([
    ["a non-object body", null],
    ["an array body", []],
    ["an unknown mode", { mode: "alphabetical" }],
    ["orders as an array", { orders: [] }],
    ["a non-array group", { orders: { g: "a" } }],
    ["a non-string id", { orders: { g: [1] } }],
    ["an empty id", { orders: { g: [""] } }],
    [
      "an oversized group",
      { orders: { g: Array.from({ length: MAX_IDS_PER_GROUP + 1 }, (_, i) => `${i}`) } },
    ],
  ])("rejects %s", (_label, body) => {
    expect(() => parseListOrderPatch(body)).toThrow(ListOrderError);
  });
});
