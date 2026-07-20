/**
 * Wake-time injected-MCP resolution (edspencer/herdctl#390).
 *
 * Two units under test, both pure enough to exercise with fakes:
 *  1. {@link buildInjectedMcpServers} — the extracted per-turn injection policy that
 *     BOTH the live `startAgentTurn` path and the wake rebuild call. Asserts send_file
 *     is always present and the self-management MCP is gated exactly by
 *     depth + config (identical to the pre-extraction inline construction).
 *  2. {@link createWakeInjectionCache} — the cache/resolver herdctl calls synchronously
 *     on a wake fire: replay-on-hit, background-warm-on-miss, never-throws, LRU bound.
 */
import { describe, it, expect } from "vitest";
import type { InjectedMcpServerDef, SessionWakeEntry } from "@herdctl/core";
import {
  buildInjectedMcpServers,
  createWakeInjectionCache,
  type InjectedMcpBuildContext,
} from "../../src/wake-injection.js";
import { SEND_FILE_SERVER_KEY } from "../../src/send-file-mcp.js";
import { SELF_MCP_SERVER_KEY } from "../../src/self-mcp.js";

const SCRATCH = "scratch";

/** A recognisable stand-in for the self-MCP def, so tests can read back its flags. */
function markerSelfMcp(params: {
  includeWrite: boolean;
  includeTriggers: boolean;
  parentProvenance: { origin: string; depth: number };
  currentProjectSlug: string;
  currentSessionId: () => string | null;
}): InjectedMcpServerDef {
  return {
    name: "self-mcp-marker",
    version: "0.0.0",
    // Smuggle the resolved flags out on the def so assertions can inspect them.
    tools: [],
    __params: params,
  } as unknown as InjectedMcpServerDef;
}

function ctx(overrides: Partial<InjectedMcpBuildContext> = {}): InjectedMcpBuildContext {
  return {
    scratchSlug: SCRATCH,
    cfg: { selfMcpEnabled: true, selfMcpWriteEnabled: true, hooksMcpEnabled: false },
    saveAttachment: async () => "att-id",
    getProvenance: undefined,
    getProjectHooksMcp: async () => undefined,
    buildSelfMcp: markerSelfMcp,
    ...overrides,
  };
}

const BASE_ARGS = {
  projectSlug: "paddock",
  workingDir: "/tmp/paddock",
  resume: null as string | null,
  origin: "human" as const,
  depth: 0,
  maxSpawnDepth: 1,
  currentSessionId: () => null as string | null,
};

function selfParams(servers: Record<string, InjectedMcpServerDef>) {
  const def = servers[SELF_MCP_SERVER_KEY] as unknown as { __params?: Record<string, unknown> };
  return def?.__params;
}

describe("buildInjectedMcpServers", () => {
  it("always includes send_file (a real, tool-bearing def)", async () => {
    const servers = await buildInjectedMcpServers(BASE_ARGS, ctx());
    const sendFile = servers[SEND_FILE_SERVER_KEY];
    expect(sendFile).toBeDefined();
    expect(sendFile.name).toBe(SEND_FILE_SERVER_KEY);
    expect(Array.isArray(sendFile.tools)).toBe(true);
    expect(sendFile.tools.length).toBeGreaterThan(0);
  });

  it("includes the self-MCP for a depth-0 keeper turn when enabled", async () => {
    const servers = await buildInjectedMcpServers(BASE_ARGS, ctx());
    expect(servers[SELF_MCP_SERVER_KEY]).toBeDefined();
    expect(selfParams(servers)).toMatchObject({ includeWrite: true, includeTriggers: false });
  });

  it("omits the self-MCP on a scratch turn (send_file only)", async () => {
    const servers = await buildInjectedMcpServers({ ...BASE_ARGS, projectSlug: SCRATCH }, ctx());
    expect(servers[SEND_FILE_SERVER_KEY]).toBeDefined();
    expect(servers[SELF_MCP_SERVER_KEY]).toBeUndefined();
  });

  it("omits the self-MCP when the instance opt-in is off", async () => {
    const servers = await buildInjectedMcpServers(
      BASE_ARGS,
      ctx({ cfg: { selfMcpEnabled: false, selfMcpWriteEnabled: true, hooksMcpEnabled: true } }),
    );
    expect(servers[SELF_MCP_SERVER_KEY]).toBeUndefined();
  });

  it("omits the self-MCP when the chat's depth exceeds maxSpawnDepth", async () => {
    // depth 2, bound 1 → 2 <= 1 is false → no injection.
    const servers = await buildInjectedMcpServers(
      { ...BASE_ARGS, depth: 2, maxSpawnDepth: 1 },
      ctx(),
    );
    expect(servers[SELF_MCP_SERVER_KEY]).toBeUndefined();
  });

  it("read-only self-MCP when writes are disabled (no trigger tools)", async () => {
    const servers = await buildInjectedMcpServers(
      BASE_ARGS,
      ctx({ cfg: { selfMcpEnabled: true, selfMcpWriteEnabled: false, hooksMcpEnabled: true } }),
    );
    expect(servers[SELF_MCP_SERVER_KEY]).toBeDefined();
    // includeTriggers is only ever resolved when writes are on.
    expect(selfParams(servers)).toMatchObject({ includeWrite: false, includeTriggers: false });
  });

  it("includes trigger tools when the project's hooks-MCP override enables them", async () => {
    const servers = await buildInjectedMcpServers(
      BASE_ARGS,
      ctx({ getProjectHooksMcp: async () => true }),
    );
    expect(selfParams(servers)).toMatchObject({ includeWrite: true, includeTriggers: true });
  });

  it("includes trigger tools via the instance default when there is no override", async () => {
    const servers = await buildInjectedMcpServers(
      BASE_ARGS,
      ctx({ cfg: { selfMcpEnabled: true, selfMcpWriteEnabled: true, hooksMcpEnabled: true } }),
    );
    expect(selfParams(servers)).toMatchObject({ includeTriggers: true });
  });

  it("gates a resume on the chat's OWN recorded depth (not the caller's depth)", async () => {
    // Caller says depth 0, but the recorded chat depth is 2 → beyond bound 1 → no self-MCP.
    const servers = await buildInjectedMcpServers(
      { ...BASE_ARGS, resume: "sess-1", depth: 0, maxSpawnDepth: 1 },
      ctx({ getProvenance: async () => ({ depth: 2 }) }),
    );
    expect(servers[SELF_MCP_SERVER_KEY]).toBeUndefined();
  });

  it("passes the resolved injection depth through as the child parentProvenance", async () => {
    const servers = await buildInjectedMcpServers(
      { ...BASE_ARGS, resume: "sess-1", depth: 0, maxSpawnDepth: 3 },
      ctx({ getProvenance: async () => ({ depth: 1 }) }),
    );
    expect(selfParams(servers)).toMatchObject({ parentProvenance: { origin: "human", depth: 1 } });
  });

  it("does not throw when getProvenance / getProjectHooksMcp reject", async () => {
    const servers = await buildInjectedMcpServers(
      { ...BASE_ARGS, resume: "sess-1" },
      ctx({
        getProvenance: async () => {
          throw new Error("boom");
        },
        getProjectHooksMcp: async () => {
          throw new Error("boom");
        },
      }),
    );
    // send_file still there; self-MCP present (fell back to caller depth 0); triggers off.
    expect(servers[SEND_FILE_SERVER_KEY]).toBeDefined();
    expect(servers[SELF_MCP_SERVER_KEY]).toBeDefined();
    expect(selfParams(servers)).toMatchObject({ includeTriggers: false });
  });
});

function entry(sessionId: string, agent = "keeper-paddock"): SessionWakeEntry {
  return {
    id: `wake-${sessionId}`,
    agent,
    sessionId,
    schedule: "* * * * *",
    recurring: false,
    prompt: "wake up",
  } as SessionWakeEntry;
}

const SET_A: Record<string, InjectedMcpServerDef> = {
  [SEND_FILE_SERVER_KEY]: { name: SEND_FILE_SERVER_KEY, version: "0", tools: [] } as InjectedMcpServerDef,
};

describe("createWakeInjectionCache", () => {
  it("replays a remembered set on a wake fire (cache hit)", () => {
    const cache = createWakeInjectionCache({ rebuild: async () => undefined });
    cache.remember("s1", SET_A);
    expect(cache.resolve(entry("s1"))).toBe(SET_A);
  });

  it("returns undefined on a cold miss, then warms so the NEXT fire hits", async () => {
    let calls = 0;
    const cache = createWakeInjectionCache({
      rebuild: async () => {
        calls++;
        return SET_A;
      },
    });
    // First fire: cold cache → no injection this fire, but a warm is kicked.
    expect(cache.resolve(entry("s1"))).toBeUndefined();
    // Let the background warm settle.
    await cache.warm(entry("s1"));
    expect(calls).toBe(1); // warm deduped with the resolve-kicked warm
    expect(cache.resolve(entry("s1"))).toBe(SET_A); // next fire hits
  });

  it("deduplicates concurrent warms for the same session", async () => {
    let calls = 0;
    const cache = createWakeInjectionCache({
      rebuild: async () => {
        calls++;
        return SET_A;
      },
    });
    const [a, b] = await Promise.all([cache.warm(entry("s1")), cache.warm(entry("s1"))]);
    expect(calls).toBe(1);
    expect(a).toBe(SET_A);
    expect(b).toBe(SET_A);
  });

  it("stays empty when rebuild yields undefined (scratch/unknown/disabled)", async () => {
    const cache = createWakeInjectionCache({ rebuild: async () => undefined });
    expect(cache.resolve(entry("s1"))).toBeUndefined();
    await cache.warm(entry("s1"));
    expect(cache.has("s1")).toBe(false);
    expect(cache.resolve(entry("s1"))).toBeUndefined();
  });

  it("never throws — a rejecting rebuild degrades to no-injection", async () => {
    const cache = createWakeInjectionCache({
      rebuild: async () => {
        throw new Error("rebuild failed");
      },
    });
    expect(() => cache.resolve(entry("s1"))).not.toThrow();
    await expect(cache.warm(entry("s1"))).resolves.toBeUndefined();
  });

  it("returns undefined for an entry with no session id", () => {
    const cache = createWakeInjectionCache({ rebuild: async () => SET_A });
    expect(cache.resolve(entry(""))).toBeUndefined();
  });

  it("evicts least-recently-used entries past the limit", () => {
    const cache = createWakeInjectionCache({ rebuild: async () => undefined, limit: 2 });
    cache.remember("s1", SET_A);
    cache.remember("s2", SET_A);
    // Touch s1 so s2 becomes the LRU.
    expect(cache.resolve(entry("s1"))).toBe(SET_A);
    cache.remember("s3", SET_A); // over the cap → evicts the LRU (s2)
    expect(cache.size()).toBe(2);
    expect(cache.has("s1")).toBe(true);
    expect(cache.has("s2")).toBe(false);
    expect(cache.has("s3")).toBe(true);
  });
});
