/**
 * Unit tests for `enforceManagementPolicy` (#312 M1) — the wrapper that actually
 * refuses out-of-scope calls.
 *
 * The predicates are covered in management-policy.test.ts; what matters HERE is
 * that the wrapper wires them to every operation, that the underlying op is
 * never even invoked on a denial (a check that ran after the side effect would
 * be worthless), and that the in-process keeper path is left untouched.
 */
import { describe, it, expect, vi } from "vitest";
import {
  enforceManagementPolicy,
  managementToolFilter,
  type ManagementOps,
} from "../../src/management-ops.js";
import {
  INTERNAL_PRINCIPAL,
  ManagementDeniedError,
  DEFAULT_READ_ONLY_SCOPE,
  FULL_SCOPE,
  type ManagementPrincipal,
  type ManagementScope,
} from "../../src/management-policy.js";

/** A fully-stubbed ops bag whose every callback records that it ran. */
function stubOps() {
  const calls: string[] = [];
  const rec =
    <T>(name: string, value: T) =>
    async (..._args: unknown[]): Promise<T> => {
      calls.push(name);
      return value;
    };
  const ops: ManagementOps = {
    read: {
      listProjects: rec("listProjects", [
        { slug: "alpha", name: "Alpha", status: "active" },
        { slug: "beta", name: "Beta", status: "active" },
      ]),
      listChats: rec("listChats", [
        { project: "alpha", sessionId: "s1", name: "one", updatedAt: "t", running: false, archived: false },
        { project: "beta", sessionId: "s2", name: "two", updatedAt: "t", running: false, archived: false },
      ]),
      readChat: rec("readChat", []),
    },
    write: {
      currentProjectSlug: "alpha",
      currentSessionId: () => "s1",
      createChat: rec("createChat", { sessionId: "new" }),
      forkChat: rec("forkChat", { sessionId: "fork" }),
      sendMessage: rec("sendMessage", undefined),
      setArchived: rec("setArchived", undefined),
      triggersMcpEnabled: true,
      listTriggers: rec("listTriggers", []),
      setTrigger: rec("setTrigger", {} as never),
      removeTrigger: rec("removeTrigger", true),
      runTrigger: rec("runTrigger", null),
    },
  };
  return { ops, calls };
}

const principal = (scope: ManagementScope): ManagementPrincipal => ({
  clientId: "client",
  kind: "token",
  scope,
});

describe("the internal keeper principal is untouched", () => {
  it("returns the very same ops object (no wrapper at all)", () => {
    const { ops } = stubOps();
    expect(enforceManagementPolicy(ops, INTERNAL_PRINCIPAL)).toBe(ops);
  });

  it("offers every tool", () => {
    const filter = managementToolFilter(INTERNAL_PRINCIPAL);
    expect(filter("create_chat")).toBe(true);
    expect(filter("fork_chat_batch")).toBe(true);
  });
});

describe("a read-only principal", () => {
  const readOnly = principal(DEFAULT_READ_ONLY_SCOPE);

  // The default read-only scope's `list_*` covers `list_triggers`, which is a
  // READ verb that happens to be implemented on the write context — so the bag
  // survives to serve it. What must hold is that every MUTATING callback on it
  // refuses, and that no write tool is offered at all.
  it("keeps the write bag only to serve list_triggers, and refuses every mutation", async () => {
    const { ops, calls } = stubOps();
    const w = enforceManagementPolicy(ops, readOnly).write!;
    await w.listTriggers("alpha");
    expect(calls).toContain("listTriggers");

    await expect(w.createChat("alpha", "x")).rejects.toBeInstanceOf(ManagementDeniedError);
    await expect(w.sendMessage("alpha", "s1", "x")).rejects.toBeInstanceOf(ManagementDeniedError);
    await expect(w.setArchived("alpha", "s1", true)).rejects.toBeInstanceOf(ManagementDeniedError);
    await expect(w.setTrigger("alpha", "t", {})).rejects.toBeInstanceOf(ManagementDeniedError);
    await expect(w.runTrigger("alpha", "t")).rejects.toBeInstanceOf(ManagementDeniedError);
    expect(calls).toEqual(["listTriggers"]);
  });

  // A scope with no trigger verb at all has nothing left to serve, so the bag
  // goes entirely — tools absent rather than present-and-refusing.
  it("drops the write bag entirely when not even a trigger read is granted", () => {
    const strictRead = principal({ projects: ["*"], allow: ["read_chat"], deny: [] });
    const { ops } = stubOps();
    expect(enforceManagementPolicy(ops, strictRead).write).toBeUndefined();
  });

  it("still reads", async () => {
    const { ops, calls } = stubOps();
    const policed = enforceManagementPolicy(ops, readOnly);
    await policed.read.readChat("alpha", "s1");
    expect(calls).toContain("readChat");
  });

  it("is offered no write tool", () => {
    const filter = managementToolFilter(readOnly);
    expect(filter("read_chat")).toBe(true);
    expect(filter("list_chats")).toBe(true);
    expect(filter("create_chat")).toBe(false);
    expect(filter("send_message")).toBe(false);
    expect(filter("run_trigger")).toBe(false);
  });
});

describe("project scoping", () => {
  const scoped = principal({ projects: ["alpha"], allow: ["*"], deny: [] });

  it("FILTERS enumerations rather than denying them", async () => {
    const { ops } = stubOps();
    const policed = enforceManagementPolicy(ops, scoped);
    expect((await policed.read.listProjects()).map((p) => p.slug)).toEqual(["alpha"]);
    expect((await policed.read.listChats()).map((c) => c.project)).toEqual(["alpha"]);
  });

  it("DENIES an explicitly addressed out-of-scope project", async () => {
    const { ops, calls } = stubOps();
    const policed = enforceManagementPolicy(ops, scoped);
    await expect(policed.read.readChat("beta", "s2")).rejects.toBeInstanceOf(ManagementDeniedError);
    // The underlying op must never have run.
    expect(calls).not.toContain("readChat");
  });

  it("denies a write into an out-of-scope project without invoking it", async () => {
    const { ops, calls } = stubOps();
    const policed = enforceManagementPolicy(ops, scoped);
    await expect(policed.write!.createChat("beta", "hi")).rejects.toBeInstanceOf(
      ManagementDeniedError,
    );
    expect(calls).not.toContain("createChat");
  });

  it("permits the same write into an in-scope project", async () => {
    const { ops, calls } = stubOps();
    const policed = enforceManagementPolicy(ops, scoped);
    await policed.write!.createChat("alpha", "hi");
    expect(calls).toContain("createChat");
  });
});

describe("per-operation scoping within writes", () => {
  // Granted exactly one write verb: everything else must refuse.
  const narrow = principal({ projects: ["*"], allow: ["list_*", "send_message"], deny: [] });

  it("permits the granted verb", async () => {
    const { ops, calls } = stubOps();
    const policed = enforceManagementPolicy(ops, narrow);
    await policed.write!.sendMessage("alpha", "s1", "hello");
    expect(calls).toContain("sendMessage");
  });

  it("refuses the others without invoking them", async () => {
    const { ops, calls } = stubOps();
    const w = enforceManagementPolicy(ops, narrow).write!;
    await expect(w.createChat("alpha", "x")).rejects.toBeInstanceOf(ManagementDeniedError);
    await expect(
      w.forkChat({ projectSlug: "alpha", sourceSessionId: "s1" }),
    ).rejects.toBeInstanceOf(ManagementDeniedError);
    await expect(w.runTrigger("alpha", "t")).rejects.toBeInstanceOf(ManagementDeniedError);
    expect(calls).toEqual([]);
  });

  it("maps archive and unarchive to their own distinct grants", async () => {
    const archiveOnly = principal({ projects: ["*"], allow: ["archive_chat"], deny: [] });
    const { ops, calls } = stubOps();
    const w = enforceManagementPolicy(ops, archiveOnly).write!;
    await w.setArchived("alpha", "s1", true);
    expect(calls).toContain("setArchived");
    await expect(w.setArchived("alpha", "s1", false)).rejects.toBeInstanceOf(
      ManagementDeniedError,
    );
  });

  it("hides the trigger tools when no trigger verb is granted", () => {
    const { ops } = stubOps();
    const policed = enforceManagementPolicy(ops, narrow);
    // `list_*` grants list_triggers, so they stay on here…
    expect(policed.write!.triggersMcpEnabled).toBe(true);
    // …but a principal with no trigger verb at all turns them off.
    const noTriggers = principal({ projects: ["*"], allow: ["send_message"], deny: [] });
    const p2 = enforceManagementPolicy(stubOps().ops, noTriggers);
    expect(p2.write!.triggersMcpEnabled).toBe(false);
  });
});

describe("fork_chat_batch visibility", () => {
  it("is hidden unless fork_chat is also granted (it executes through it)", () => {
    const batchOnly = principal({ projects: ["*"], allow: ["fork_chat_batch"], deny: [] });
    expect(managementToolFilter(batchOnly)("fork_chat_batch")).toBe(false);

    const both = principal({ projects: ["*"], allow: ["fork_chat", "fork_chat_batch"], deny: [] });
    expect(managementToolFilter(both)("fork_chat_batch")).toBe(true);
  });
});

describe("a full-scope external principal", () => {
  it("is still wrapped (not the internal short-circuit) but permits everything", async () => {
    const { ops, calls } = stubOps();
    const external = principal(FULL_SCOPE);
    const policed = enforceManagementPolicy(ops, external);
    expect(policed).not.toBe(ops);
    await policed.write!.createChat("anything", "x");
    await policed.read.readChat("anything", "s");
    expect(calls).toEqual(["createChat", "readChat"]);
  });
});
