import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

/**
 * Regression for issue #31: Claude Code writes injected context — a skill's
 * SKILL.md, slash-command output — as its own `type:"user"` JSONL line flagged
 * `isMeta:true`, and older @herdctl/core surfaced that body as an ordinary user
 * message (a giant "user" bubble). @herdctl/core >=5.13.2 skips `isMeta` user
 * lines in `parseSessionMessages`, so history hydration no longer includes them.
 * This exercises the REAL parser end-to-end, verifying the upstream fix through
 * paddock's message route (no paddock-side filtering involved).
 */
describe("integration: injected (isMeta) user lines are stripped from history (#31)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;

  const isComplete = (slug: string) => (e: WsEvent) =>
    e.type === "chat:complete" &&
    e.payload?.projectSlug === slug &&
    typeof e.payload?.sessionId === "string";

  beforeAll(async () => {
    t = await startTestApp({ script: { "Hello there": "Hi! I am the fake keeper." } });
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Meta Proj" } });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  async function findSessionFile(root: string, sessionId: string): Promise<string> {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name === `${sessionId}.jsonl`) return full;
      }
    }
    throw new Error(`transcript for ${sessionId} not found under ${root}`);
  }

  it("hides a skill's SKILL.md but keeps the real user + assistant turns", async () => {
    // A real turn writes a genuine transcript (real user + assistant lines).
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "meta-proj", sessionId: null, message: "Hello there" },
    });
    const complete = await ws.waitFor(isComplete("meta-proj"), { from: mark });
    const sessionId = complete.payload?.sessionId as string;
    expect(sessionId).toBeTruthy();

    // Simulate Claude Code injecting a skill body as an isMeta user line.
    const skillBody =
      "Base directory for this skill: /tmp/bundled-skills/claude-api\n\n" +
      "# Building LLM-Powered Applications with Claude\n\nMODEL TABLE …";
    const file = await findSessionFile(t.projectsRoot, sessionId);
    const injected = JSON.stringify({
      type: "user",
      isMeta: true,
      timestamp: new Date(0).toISOString(),
      message: { role: "user", content: skillBody },
    });
    await fs.appendFile(file, injected + "\n", "utf8");

    // History hydration must drop the injected line but keep the real turns.
    const messages = (
      await t.app.inject({
        method: "GET",
        url: `/api/projects/meta-proj/chats/${sessionId}/messages`,
      })
    ).json().messages as { role: string; content: string }[];

    const userContents = messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(userContents).toContain("Hello there");
    expect(userContents.some((c) => c.includes("Building LLM-Powered Applications"))).toBe(false);
    // The real assistant reply is untouched.
    expect(messages.some((m) => m.role === "assistant" && m.content.includes("fake keeper"))).toBe(
      true,
    );
  });
});
