/**
 * Integration tests for the `/mcp` streamable-HTTP transport (#312 M2).
 *
 * Boots the REAL app and speaks JSON-RPC to it, so these cover the wiring the
 * unit tests can't: that the SDK transport is mounted correctly behind the
 * gate, that Fastify's already-drained body reaches it (the `parsedBody`
 * gotcha), and — most importantly — that a principal's SCOPE actually shapes
 * the tool list it is offered over the wire.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

const READER = "pdk_testinstance_reader00000000000000000000";
const WRITER = "pdk_testinstance_writer00000000000000000000";

let app: TestApp | undefined;

afterEach(async () => {
  await app?.teardown();
  app = undefined;
});

async function boot() {
  app = await startTestApp({
    configFile: {
      managementApi: {
        publicUrl: "https://paddock.example.test",
        clients: {
          // No scope block ⇒ the read-only default.
          reader: { auth: { ref: "env:MCP_READER" } },
          writer: {
            auth: { ref: "env:MCP_WRITER" },
            scope: { projects: ["*"], allow: ["list_*", "read_chat", "create_chat"] },
          },
        },
      },
    },
    env: { MCP_READER: READER, MCP_WRITER: WRITER },
  });
  return app;
}

/** POST one JSON-RPC message and parse the SSE-framed result. */
async function rpc(a: TestApp, token: string, body: unknown) {
  const res = await a.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    payload: body as Record<string, unknown>,
  });
  // The transport replies on an SSE stream by default; pull the data frame out.
  const line = res.body.split("\n").find((l) => l.startsWith("data: "));
  return {
    status: res.statusCode,
    json: line ? JSON.parse(line.slice("data: ".length)) : undefined,
    raw: res.body,
  };
}

const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

describe("/mcp transport", () => {
  it("completes an initialize handshake at the current protocol revision", async () => {
    const a = await boot();
    const { json } = await rpc(a, READER, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    expect(json.result.protocolVersion).toBe("2025-11-25");
    expect(json.result.serverInfo.name).toBe("paddock");
  });

  // Regression guard for the `parsedBody` gotcha: Fastify has already drained
  // the socket, so a transport that re-reads it reports "Parse error: Invalid
  // JSON" for input that was perfectly valid.
  it("parses a body Fastify already consumed", async () => {
    const a = await boot();
    const { json } = await rpc(a, READER, LIST);
    expect(json.error).toBeUndefined();
    expect(Array.isArray(json.result.tools)).toBe(true);
  });

  it("rejects GET and DELETE with 405 rather than a stream that never emits", async () => {
    const a = await boot();
    for (const method of ["GET", "DELETE"] as const) {
      const res = await a.app.inject({
        method,
        url: "/mcp",
        headers: { authorization: `Bearer ${READER}` },
      });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe("POST");
    }
  });

  it("still refuses an unauthenticated POST before reaching the transport", async () => {
    const a = await boot();
    const res = await a.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json" },
      payload: LIST,
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
  });
});

describe("/mcp scope shapes the offered toolset", () => {
  const names = (json: { result: { tools: Array<{ name: string }> } }) =>
    json.result.tools.map((t) => t.name).sort();

  it("offers a read-only client only read verbs", async () => {
    const a = await boot();
    const { json } = await rpc(a, READER, LIST);
    expect(names(json)).toEqual(["list_chats", "list_projects", "list_triggers", "read_chat"]);
  });

  it("offers a write-scoped client its granted verb too", async () => {
    const a = await boot();
    const { json } = await rpc(a, WRITER, LIST);
    expect(names(json)).toContain("create_chat");
    // …but nothing it wasn't granted.
    expect(names(json)).not.toContain("send_message");
    expect(names(json)).not.toContain("fork_chat");
  });

  // Defence in depth: even if a client guesses a tool name it was never
  // offered, the call must not execute.
  it("refuses a call to a tool outside the client's scope", async () => {
    const a = await boot();
    const { json } = await rpc(a, READER, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "create_chat", arguments: { project: "demo", prompt: "hi" } },
    });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("Unknown tool");
  });
});

/**
 * #489 — `list_chats` over the REAL ops layer (not a fake context), because the
 * archived annotation is added in `buildManagementOps` and nothing else covers
 * it: `git grep buildManagementOps packages/server/test` was empty before this.
 * Uses its own app (chats need a listening socket for the WS turn) rather than
 * the module-level `boot()`.
 */
describe("/mcp list_chats hides archived chats", () => {
  let t: TestApp;
  let ws: WsClient;
  let n = 0;

  const isComplete = (slug: string) => (e: WsEvent) =>
    e.type === "chat:complete" && e.payload?.projectSlug === slug;

  /** A fresh project with one chat — fresh so the chat is its FIRST session and
   *  surfaces immediately (a later chat can lag herdctl's 30s discovery cache). */
  async function projectWithChat(): Promise<{ slug: string; id: string }> {
    const slug = `mcparch-${++n}`;
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: slug } });
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: slug, sessionId: null, message: "hello archive" },
    });
    const id = (await ws.waitFor(isComplete(slug), { from: mark })).payload?.sessionId as string;
    return { slug, id };
  }

  const listChats = async (args: Record<string, unknown> = {}) => {
    const { json } = await rpc(t, READER, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "list_chats", arguments: args },
    });
    return JSON.parse(json.result.content[0].text) as {
      count: number;
      omittedArchived: number;
      chats: Array<{ sessionId: string; archived: boolean }>;
    };
  };

  beforeAll(async () => {
    t = await startTestApp({
      script: { "hello archive": "hi from the keeper" },
      configFile: {
        managementApi: {
          publicUrl: "https://paddock.example.test",
          clients: { reader: { auth: { ref: "env:MCP_READER" } } },
        },
      },
      env: {
        MCP_READER: READER,
        // Hermetic: this is the only test here that opens a real socket, and the
        // browser-auth hook guards `/ws` app-wide. A dev box that exports
        // PADDOCK_AUTH_MODE=jwt (the projects box does) would 401 the upgrade,
        // so pin the mode the way the helper already pins HOST/drive-mode. CI
        // has it unset, where `none` is the default anyway.
        PADDOCK_AUTH_MODE: "none",
      },
    });
    const { port } = await listen(t.app);
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t?.teardown();
  });

  it("omits an archived chat by default, counts it, and returns it on request", async () => {
    const active = await projectWithChat();
    const filed = await projectWithChat();
    await t.app.inject({
      method: "POST",
      url: `/api/projects/${filed.slug}/chats/${filed.id}/archive`,
      payload: { archived: true },
    });

    const hidden = await listChats();
    const ids = hidden.chats.map((c) => c.sessionId);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(filed.id);
    expect(hidden.count).toBe(hidden.chats.length);
    expect(hidden.omittedArchived).toBe(1);
    // Everything still listed reports the flag the UI has always had.
    expect(hidden.chats.every((c) => c.archived === false)).toBe(true);

    const shown = await listChats({ include_archived: true });
    expect(shown.chats.map((c) => c.sessionId)).toContain(filed.id);
    expect(shown.chats.find((c) => c.sessionId === filed.id)?.archived).toBe(true);
    expect(shown.omittedArchived).toBe(0);
  });
});

describe("/.well-known/oauth-protected-resource", () => {
  // Token-only deployments have no authorization server, and the MCP spec makes
  // `authorization_servers` mandatory — so no document is published rather than
  // an invalid one that sends clients hunting for an AS that doesn't exist.
  it("404s when no authorization server is configured", async () => {
    const a = await boot();
    for (const url of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const res = await a.app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(404);
    }
  });

  it("serves a complete document once an authorization server is configured", async () => {
    app = await startTestApp({
      configFile: {
        managementApi: {
          publicUrl: "https://paddock.example.test",
          authorizationServers: ["https://idp.example.test/application/o/paddock"],
          clients: { reader: { auth: { ref: "env:MCP_READER" } } },
        },
      },
      env: { MCP_READER: READER },
    });
    // The path-inserted form is the one real clients request.
    const res = await app.app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource/mcp",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.json()).toMatchObject({
      resource: "https://paddock.example.test/mcp",
      authorization_servers: ["https://idp.example.test/application/o/paddock"],
      scopes_supported: ["paddock:read", "paddock:write"],
    });
    // Served unauthenticated — a client fetches it before holding a credential.
    expect(res.headers["www-authenticate"]).toBeUndefined();
  });
});
