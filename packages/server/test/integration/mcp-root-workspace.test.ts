/**
 * #560 — the self-MCP surface can see and reach the ROOT workspace.
 *
 * This is the scenario from the ticket, end-to-end against the REAL app + fleet
 * (a fake `claude` on PATH): one project, one root chat, then the four MCP calls
 * that all got the root wrong. It is deliberately an INTEGRATION test rather than
 * only a unit one, because the failure spanned three layers that each looked
 * locally reasonable — the handler's arg parsing, the ops layer's target
 * selection, and `ProjectStore.list()`'s (correct, deliberate) exclusion of the
 * root. Only driving the whole stack proves a root chat is actually reachable.
 *
 * The load-bearing invariant this must NOT break: the root stays out of
 * enumeration (`root-workspace.test.ts`). It is reached by KEY, exactly as the
 * `/api/root` mount reaches it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

const READER = "pdk_testinstance_reader00000000000000000000";

describe("integration: /mcp reaches the root workspace (#560)", () => {
  let t: TestApp;
  let ws: WsClient;
  let rootSessionId: string;
  let alphaSessionId: string;

  /** POST one JSON-RPC message and parse the SSE-framed result. */
  async function rpc(body: unknown) {
    const res = await t.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${READER}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: body as Record<string, unknown>,
    });
    const line = res.body.split("\n").find((l) => l.startsWith("data: "));
    return line ? JSON.parse(line.slice("data: ".length)) : undefined;
  }

  /** Call one MCP tool and return its parsed JSON payload. */
  async function tool(name: string, args: Record<string, unknown> = {}) {
    const json = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    return {
      isError: json.result.isError === true,
      text: json.result.content[0].text as string,
      json: json.result.isError ? null : JSON.parse(json.result.content[0].text),
    };
  }

  const isComplete = (slug: string) => (e: WsEvent) =>
    e.type === "chat:complete" &&
    e.payload?.projectSlug === slug &&
    typeof e.payload?.sessionId === "string";

  async function chatIn(slug: string, message: string): Promise<string> {
    const mark = ws.mark();
    ws.send({ type: "chat:send", payload: { projectSlug: slug, sessionId: null, message } });
    return (await ws.waitFor(isComplete(slug), { from: mark })).payload?.sessionId as string;
  }

  beforeAll(async () => {
    t = await startTestApp({
      script: { "Hello root": "I am the root keeper.", "Hello alpha": "I am alpha's keeper." },
      configFile: {
        managementApi: {
          publicUrl: "https://paddock.example.test",
          // No scope block ⇒ the read-only default (`projects: ["*"]`), which
          // matches the root's empty key as well as every project's slug.
          clients: { reader: { auth: { ref: "env:MCP_READER" } } },
        },
      },
      env: { MCP_READER: READER, PADDOCK_AUTH_MODE: "none" },
    });
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Alpha" } });
    const { port } = await listen(t.app);
    ws = await connectWs(port);
    // The root workspace needs no creation step — it always exists.
    rootSessionId = await chatIn("", "Hello root");
    alphaSessionId = await chatIn("alpha", "Hello alpha");
  });
  afterAll(async () => {
    ws?.close();
    await t?.teardown();
  });

  it("REST already sees the root chat (the premise these tests are about)", async () => {
    const chats = (await t.app.inject({ method: "GET", url: "/api/root/chats" })).json().chats;
    expect(chats.map((c: { sessionId: string }) => c.sessionId)).toContain(rootSessionId);
  });

  it("list_projects advertises the root without enumerating it as a project", async () => {
    const { json } = await tool("list_projects");
    expect(json.projects.map((p: { slug: string }) => p.slug)).toEqual(["alpha"]);
    expect(json.count).toBe(1);
    // Before: no `root` at all, so a caller had no way to learn the root existed.
    expect(json.root.slug).toBe("");
    expect(typeof json.root.name).toBe("string");
  });

  it('list_chats {"project":""} returns the ROOT\'s chats, not every workspace\'s', async () => {
    const { json } = await tool("list_chats", { project: "" });
    // Before: `{"count":0,"project":""}` — silently answered for all projects
    // (and then reported zero, because the root's chat isn't in any project).
    expect(json.project).toBe("");
    expect(json.chats.map((c: { sessionId: string }) => c.sessionId)).toEqual([rootSessionId]);
    expect(json.count).toBe(1);
  });

  it("list_chats with no filter includes the root chat alongside the project's", async () => {
    const { json } = await tool("list_chats");
    const ids = json.chats.map((c: { sessionId: string }) => c.sessionId);
    // Before: the root chat was absent, which made it undiscoverable —
    // `list_chats` is the only source of session ids.
    expect(ids).toContain(rootSessionId);
    expect(ids).toContain(alphaSessionId);
    // The root chat reports the key you pass BACK to read_chat, verbatim.
    expect(json.chats.find((c: { sessionId: string }) => c.sessionId === rootSessionId).project).toBe("");
  });

  it('read_chat {"project":""} reads the root chat instead of claiming the arg is missing', async () => {
    const { isError, json } = await tool("read_chat", {
      project: "",
      session_id: rootSessionId,
    });
    // Before: "Error: `project` (a project slug) is required." — for an argument
    // that WAS supplied.
    expect(isError).toBe(false);
    expect(json.project).toBe("");
    expect(json.messages.map((m: { text: string }) => m.text).join("\n")).toContain(
      "I am the root keeper.",
    );
  });

  it("still errors when `project` is genuinely absent", async () => {
    const { isError, text } = await tool("read_chat", { session_id: rootSessionId });
    expect(isError).toBe(true);
    expect(text).toContain("`project`");
  });

  it("does not confuse the root with a project: each lists only its own chats", async () => {
    const { json: alpha } = await tool("list_chats", { project: "alpha" });
    expect(alpha.chats.map((c: { sessionId: string }) => c.sessionId)).toEqual([alphaSessionId]);
    const { json: root } = await tool("list_chats", { project: "" });
    expect(root.chats.map((c: { sessionId: string }) => c.sessionId)).toEqual([rootSessionId]);
  });
});
