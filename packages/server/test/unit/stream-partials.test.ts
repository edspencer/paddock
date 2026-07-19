/**
 * paddock#315 — the session-mode turn paths opt into partial (streaming)
 * assistant messages so keeper replies stream token-by-token.
 *
 * Verifies `HerdctlService.chatSession` and `runCommand` pass
 * `includePartialMessages: true` to herdctl's `openChatSession`, and that the
 * translator wiring the WS layer uses turns `stream_event` / `text_delta`
 * messages into ordered incremental `chat:response` chunks (no double-emit of
 * the terminal whole-assistant text).
 */
import { describe, it, expect, vi } from "vitest";
import { createSDKMessageHandler } from "@herdctl/chat";
import { HerdctlService, type ChatTurnOptions } from "../../src/herdctl.js";
import type { PaddockConfig } from "../../src/config.js";

/** A fake RuntimeSession whose stream immediately yields a terminal `result`. */
function fakeSession() {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    messages: (async function* () {
      yield { type: "result", subtype: "success", success: true, session_id: "sess-1" };
    })(),
    send: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    listCommands: vi.fn(async () => []),
    setModel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

function serviceWithFakeFleet() {
  const openChatSession = vi.fn(async () => fakeSession());
  const svc = new HerdctlService({} as PaddockConfig);
  // Inject a minimal fake fleet exposing only what the session paths touch.
  (svc as unknown as { fleet: unknown }).fleet = {
    openChatSession,
    invalidateSessions: vi.fn(),
    attributeRunningSession: vi.fn(async () => {}),
  };
  return { svc, openChatSession };
}

describe("session-mode turns request partial messages (paddock#315)", () => {
  it("chatSession opts into includePartialMessages", async () => {
    const { svc, openChatSession } = serviceWithFakeFleet();
    const opts: ChatTurnOptions = { prompt: "hello" };

    await svc.chatSession("keeper-demo", opts);

    expect(openChatSession).toHaveBeenCalledTimes(1);
    expect(openChatSession.mock.calls[0][1]).toMatchObject({ includePartialMessages: true });
  });

  it("runCommand opts into includePartialMessages", async () => {
    const { svc, openChatSession } = serviceWithFakeFleet();

    await svc.runCommand("keeper-demo", { command: "/compact", resume: "sess-1" });

    expect(openChatSession).toHaveBeenCalledTimes(1);
    expect(openChatSession.mock.calls[0][1]).toMatchObject({ includePartialMessages: true });
  });
});

describe("chat:response chunk accretion from stream_event deltas", () => {
  it("emits one chunk per text_delta, in order, without re-emitting the terminal text", async () => {
    const chunks: string[] = [];
    const translate = createSDKMessageHandler({
      onText: (chunk) => {
        if (chunk) chunks.push(chunk);
      },
    });

    // Deltas as the SDK streams them, then the terminal whole-assistant message.
    await translate({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
    } as never);
    await translate({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo!" } },
    } as never);
    await translate({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello!" }] },
    } as never);

    // Two incremental chunks — the terminal assistant text is suppressed.
    expect(chunks).toEqual(["Hel", "lo!"]);
  });
});
