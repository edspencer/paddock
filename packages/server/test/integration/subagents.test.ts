/**
 * Sub-agent transcript endpoints (issue #37). Boots the real app and hits the
 * `/subagents/:toolUseId/messages` routes against crafted `.chats/` fixtures —
 * exercising route wiring + slug→projectDir resolution + the reader end to end,
 * for both a project chat and a scratch chat. No keeper turn is run: the reader
 * works straight off the on-disk transcript, which is the whole point of #37.
 *
 * Each test uses its own project so nothing races a curation sweep.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";

describe("integration: sub-agent transcript endpoints (issue #37)", () => {
  let t: TestApp;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp({ sweepIntervalMs: 600_000 });
  });
  afterAll(async () => {
    await t.teardown();
  });

  /** Write a sub-agent transcript + meta sidecar under <projectDir>/.chats/<sid>/subagents/. */
  async function writeSubagent(projectDir: string, sid: string, toolUseId: string): Promise<void> {
    const dir = path.join(projectDir, ".chats", sid, "subagents");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "agent-abc.meta.json"),
      JSON.stringify({ agentType: "Explore", description: "map features", toolUseId, spawnDepth: 1 }),
      "utf8",
    );
    await fs.writeFile(
      path.join(dir, "agent-abc.jsonl"),
      [
        { type: "user", message: { role: "user", content: "explore" }, uuid: "u1" },
        {
          type: "assistant",
          message: { id: "m1", role: "assistant", content: [{ type: "text", text: "sub-agent step output" }] },
          uuid: "a1",
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
      "utf8",
    );
  }

  it("serves a project sub-agent's nested steps by toolUseId", async () => {
    const name = `Sub ${++n}`;
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } });
    const slug = name.toLowerCase().replace(/\s+/g, "-");
    const dir = (await t.projects.get(slug)).dir;
    await writeSubagent(dir, "sess-A", "toolu_A");

    const res = await t.app.inject({
      method: "GET",
      url: `/api/projects/${slug}/chats/sess-A/subagents/toolu_A/messages`,
    });
    expect(res.statusCode).toBe(200);
    const { messages } = res.json();
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m: { content: string }) => m.content.includes("sub-agent step output"))).toBe(true);
  });

  it("returns an empty list for an unknown toolUseId", async () => {
    const name = `Sub ${++n}`;
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } });
    const slug = name.toLowerCase().replace(/\s+/g, "-");
    const dir = (await t.projects.get(slug)).dir;
    await writeSubagent(dir, "sess-B", "toolu_B");

    const res = await t.app.inject({
      method: "GET",
      url: `/api/projects/${slug}/chats/sess-B/subagents/toolu_missing/messages`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().messages).toEqual([]);
  });

  it("serves a scratch sub-agent's nested steps too", async () => {
    await writeSubagent(t.herdctl.scratchDir, "sess-S", "toolu_S");
    const res = await t.app.inject({
      method: "GET",
      url: `/api/chats/sess-S/subagents/toolu_S/messages`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().messages.some((m: { content: string }) => m.content.includes("sub-agent step output"))).toBe(true);
  });
});
