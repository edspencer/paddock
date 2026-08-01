import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DiscoveredSession } from "@herdctl/core";
import { buildProjectChats } from "../../src/chat-dto.js";
import { projectChatsDir } from "../../src/transcripts.js";
import { PRELOAD_CONTEXT_OPEN, PRELOAD_REQUEST_MARKER } from "../../src/preload.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/**
 * A machine-prepended wrapper must never become a chat's display name (#62) —
 * including when it arrives as the engine's `autoName` rather than its `preview`.
 *
 * The cleanup used to be gated on `!s.autoName`, which was a sound proxy while
 * @herdctl/core left `autoName` undefined for a transcript with no title entry
 * (nearly every CLI transcript). Core now falls back to the first user message
 * (`custom-title` → `ai-title` → `summary` → preview), so a preload chat arrives
 * with `autoName` ALREADY set to the `<project-context>` block — and the gate,
 * left as an absence check, made the whole cleanup branch unreachable. Every
 * preload chat was then titled with the injected project overview.
 *
 * This pins the behaviour to the SHAPE of the value rather than to whether the
 * engine happened to supply one.
 */
describe("chat display names vs. injected wrappers (#62)", () => {
  let projectDir: string;

  const WRAPPED =
    `${PRELOAD_CONTEXT_OPEN}\n# Project Overview\nlots of curated context\n` +
    `${PRELOAD_REQUEST_MARKER}how do I add a new keeper agent?`;

  const session = (over: Partial<DiscoveredSession> = {}): DiscoveredSession =>
    ({
      sessionId: "s-1",
      mtime: new Date().toISOString(),
      customName: undefined,
      autoName: undefined,
      preview: undefined,
      ...over,
    }) as DiscoveredSession;

  beforeEach(async () => {
    projectDir = await makeTmpDir("paddock-chatname-");
    const dir = projectChatsDir(projectDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "s-1.jsonl"),
      JSON.stringify({ type: "user", message: { content: WRAPPED } }) + "\n",
      "utf8",
    );
  });
  afterEach(async () => {
    await rmTmpDir(projectDir);
  });

  const nameOf = async (s: DiscoveredSession) =>
    (await buildProjectChats(projectDir, [s]))[0] as { name: string; preview?: string };

  it("recovers the real request when the wrapper arrives as the PREVIEW", async () => {
    const chat = await nameOf(session({ preview: WRAPPED.slice(0, 100) }));
    expect(chat.name).toBe("how do I add a new keeper agent?");
  });

  it("recovers it when the wrapper arrives as the AUTONAME (core's preview fallback)", async () => {
    const chat = await nameOf(session({ autoName: WRAPPED.slice(0, 100) }));
    expect(chat.name).toBe("how do I add a new keeper agent?");
    expect(chat.name).not.toContain("<project-context>");
    expect(chat.preview ?? "").not.toContain("<project-context>");
  });

  it("leaves a REAL title alone — this must not eat legitimate names", async () => {
    const chat = await nameOf(
      session({ autoName: "Auth middleware rewrite", preview: WRAPPED.slice(0, 100) }),
    );
    expect(chat.name).toBe("Auth middleware rewrite");
  });

  it("a user's custom name still beats everything", async () => {
    const chat = await nameOf(session({ customName: "My chat", autoName: WRAPPED.slice(0, 100) }));
    expect(chat.name).toBe("My chat");
  });
});
