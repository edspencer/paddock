/**
 * The post-turn chat-verdict judge (`chat-judge.ts`): the output parser, the
 * prompt builder, the JudgeService's debounce/skip/failure rules against a mocked
 * herdctl, and the `afterTurn` listener in `ws-triggers.ts` that feeds it. No
 * model is called: `runJudge` is a stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChatMessage } from "@herdctl/core";
import {
  JudgeService,
  buildJudgePrompt,
  parseJudgeOutput,
  JUDGE_MAX_MESSAGES,
  type JudgeServiceOptions,
} from "../../src/chat-judge.js";
import { JUDGE_SYSTEM_PROMPT } from "../../src/herdctl-agent-config.js";
import { PaddockEventBus } from "../../src/event-bus.js";
import { makeTriggerCluster } from "../../src/ws-triggers.js";
import type { ChatHandlerDeps, StartAgentTurn } from "../../src/ws-context.js";
import type { ChatVerdict } from "../../src/chat-verdict.js";

const msg = (role: ChatMessage["role"], content: string, timestamp = "2026-11-05T10:00:00Z") =>
  ({ role, content, timestamp }) as ChatMessage;

describe("parseJudgeOutput", () => {
  it("reads the two-line format", () => {
    expect(parseJudgeOutput("VERDICT: finished\nREASON: The fix landed and tests pass.")).toEqual({
      verdict: "finished",
      reason: "The fix landed and tests pass.",
    });
    expect(
      parseJudgeOutput("VERDICT: could-continue\nREASON: Asked which option to take."),
    ).toEqual({ verdict: "could-continue", reason: "Asked which option to take." });
  });

  it("tolerates case, markdown emphasis, a preamble and spelling variants", () => {
    const out = parseJudgeOutput(
      "Here is my answer.\n**Verdict:** Could continue\n**Reason:** offered *next* steps",
    );
    expect(out).toEqual({ verdict: "could-continue", reason: "offered next steps" });
    expect(parseJudgeOutput("- VERDICT: could_continue")?.verdict).toBe("could-continue");
  });

  it("accepts a missing reason as empty", () => {
    expect(parseJudgeOutput("VERDICT: finished")).toEqual({ verdict: "finished", reason: "" });
  });

  it("caps the reason at 120 characters", () => {
    const out = parseJudgeOutput(`VERDICT: finished\nREASON: ${"word ".repeat(60)}`);
    expect(out?.reason.length).toBeLessThanOrEqual(120);
    expect(out?.reason.endsWith("…")).toBe(true);
  });

  it("rejects output with no verdict, an unknown one, or the echoed template", () => {
    expect(parseJudgeOutput("")).toBeNull();
    expect(parseJudgeOutput("The chat looks finished to me.")).toBeNull();
    expect(parseJudgeOutput("VERDICT: unsure\nREASON: hard to say")).toBeNull();
    expect(parseJudgeOutput("VERDICT: finished|could-continue\nREASON: <x>")).toBeNull();
  });
});

describe("buildJudgePrompt", () => {
  it("shows the last messages oldest first, with tool calls as one-liners", () => {
    const prompt = buildJudgePrompt([
      msg("user", "Fix the   flaky test"),
      {
        ...msg("tool", ""),
        toolCall: { toolName: "Bash", inputSummary: "npm test", output: "", isError: true },
      },
      msg("assistant", "Fixed it. Want me to also add a regression test?"),
    ]);
    const chat = prompt.slice(prompt.indexOf("=== CHAT"), prompt.indexOf("=== END CHAT"));
    expect(chat).toContain("user: Fix the flaky test");
    expect(chat).toContain("[tool Bash npm test] (error)");
    expect(chat).toContain("assistant: Fixed it. Want me to also add a regression test?");
    expect(chat.indexOf("user:")).toBeLessThan(chat.indexOf("assistant:"));
  });

  it("keeps only the last messages and drops background-task notifications", () => {
    const many = Array.from({ length: 30 }, (_, i) => msg("user", `message ${i}`));
    const note = { ...msg("user", "task finished"), origin: { kind: "task-notification" } };
    const prompt = buildJudgePrompt([...many, note as ChatMessage]);
    expect(prompt).not.toContain("task finished");
    expect(prompt).not.toContain("message 17\n");
    expect(prompt).toContain(`message ${30 - JUDGE_MAX_MESSAGES}`);
    expect(prompt).toContain("message 29");
  });

  it("keeps the END of a long final reply, where the next steps sit", () => {
    const long = `${"intro ".repeat(2000)}Next steps: shall I open the PR?`;
    const prompt = buildJudgePrompt([msg("user", "go"), msg("assistant", long)]);
    expect(prompt).toContain("shall I open the PR?");
    expect(prompt.length).toBeLessThan(long.length);
  });

  it("asks for the format the parser reads, in both the prompt and the system prompt", () => {
    for (const text of [buildJudgePrompt([msg("assistant", "done")]), JUDGE_SYSTEM_PROMPT]) {
      expect(text).toContain("VERDICT: finished|could-continue");
      expect(text).toContain("REASON:");
    }
    // A model that echoes the format line verbatim is NOT read as a verdict.
    expect(parseJudgeOutput("VERDICT: finished|could-continue")).toBeNull();
  });
});

describe("JudgeService", () => {
  const LAST = "2026-11-05T10:00:00.000Z";
  let stored: Map<string, ChatVerdict>;
  let forgets: Map<string, number>;
  let runJudge: ReturnType<typeof vi.fn>;
  let sessionMessages: ReturnType<typeof vi.fn>;
  let lastMessageAt: ReturnType<typeof vi.fn>;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const make = (over: Partial<JudgeServiceOptions> = {}) =>
    new JudgeService({
      herdctl: { runJudge, sessionMessages } as unknown as JudgeServiceOptions["herdctl"],
      projects: {
        get: async (slug: string) => {
          if (slug === "gone") throw new Error("not_found");
          return { slug, dir: `/tmp/${slug}` };
        },
      } as unknown as JudgeServiceOptions["projects"],
      verdicts: {
        get: async (agent: string, id: string) => stored.get(`${agent}/${id}`),
        set: async (agent: string, id: string, v: ChatVerdict, ifForgetCount?: number) => {
          const n = forgets.get(`${agent}/${id}`) ?? 0;
          if (ifForgetCount !== undefined && ifForgetCount !== n) return false;
          stored.set(`${agent}/${id}`, v);
          return true;
        },
        forgetCount: (agent: string, id: string) => forgets.get(`${agent}/${id}`) ?? 0,
      },
      config: { enabled: true, model: "claude-haiku-4-5-20251001" },
      debounceMs: 1000,
      logger,
      lastMessageAt,
      ...over,
    });

  beforeEach(() => {
    stored = new Map();
    forgets = new Map();
    runJudge = vi.fn(async () => ({
      result: { success: true },
      text: "VERDICT: could-continue\nREASON: Offered to open a PR.",
    }));
    sessionMessages = vi.fn(async () => [msg("user", "go"), msg("assistant", "Done. Open a PR?")]);
    lastMessageAt = vi.fn(async () => LAST);
    logger.info.mockReset();
    logger.warn.mockReset();
    logger.error.mockReset();
  });

  it("stores a parsed verdict for the completion it judged, and announces it", async () => {
    const judge = make();
    const onVerdict = vi.fn();
    judge.onVerdict = onVerdict;
    expect(await judge.judgeNow("demo", "s1")).toBe("stored");
    expect(sessionMessages).toHaveBeenCalledWith("keeper-demo", "s1");
    expect(runJudge).toHaveBeenCalledWith("demo", expect.stringContaining("Open a PR?"));
    const v = stored.get("keeper-demo/s1");
    expect(v).toMatchObject({
      verdict: "could-continue",
      reason: "Offered to open a PR.",
      turnCompletedAt: LAST,
      model: "claude-haiku-4-5-20251001",
    });
    expect(onVerdict).toHaveBeenCalledWith("demo", "s1", {
      verdict: "could-continue",
      reason: "Offered to open a PR.",
      turnCompletedAt: LAST,
      judgedAt: v?.judgedAt,
    });
  });

  it("runs at most once per completed turn (the cost guard)", async () => {
    const judge = make();
    expect(await judge.judgeNow("demo", "s1")).toBe("stored");
    expect(await judge.judgeNow("demo", "s1")).toBe("unchanged");
    expect(runJudge).toHaveBeenCalledTimes(1);
    // A later completion is judged again.
    lastMessageAt.mockResolvedValue("2026-11-05T11:00:00.000Z");
    expect(await judge.judgeNow("demo", "s1")).toBe("stored");
    expect(runJudge).toHaveBeenCalledTimes(2);
  });

  it("falls back to the transcript's last timestamp when there is no datable message", async () => {
    lastMessageAt.mockResolvedValue(undefined);
    sessionMessages.mockResolvedValue([msg("assistant", "done", "2026-11-05T09:00:00.000Z")]);
    const judge = make();
    expect(await judge.judgeNow("demo", "s1")).toBe("stored");
    expect(stored.get("keeper-demo/s1")?.turnCompletedAt).toBe("2026-11-05T09:00:00.000Z");
    expect(await judge.judgeNow("demo", "s1")).toBe("unchanged");
  });

  it("skips a running chat, a missing project, and a reply-less transcript", async () => {
    const judge = make();
    judge.isRunning = (id) => id === "busy";
    expect(await judge.judgeNow("demo", "busy")).toBe("running");
    expect(await judge.judgeNow("gone", "s1")).toBe("no-project");
    sessionMessages.mockResolvedValue([msg("user", "hello?")]);
    expect(await judge.judgeNow("demo", "s1")).toBe("no-messages");
    expect(runJudge).not.toHaveBeenCalled();
  });

  it("discards a verdict the chat moved past while the judge ran", async () => {
    const judge = make();
    const onVerdict = vi.fn();
    judge.onVerdict = onVerdict;
    let busy = false;
    judge.isRunning = () => busy;

    runJudge.mockImplementationOnce(async () => {
      busy = true; // the user replied mid-run
      return { result: { success: true }, text: "VERDICT: finished\nREASON: done" };
    });
    expect(await judge.judgeNow("demo", "s1")).toBe("superseded");

    busy = false;
    runJudge.mockImplementationOnce(async () => {
      // A queued message landed and its turn already finished mid-run.
      lastMessageAt.mockResolvedValue("2026-11-05T10:05:00.000Z");
      return { result: { success: true }, text: "VERDICT: finished\nREASON: done" };
    });
    expect(await judge.judgeNow("demo", "s1")).toBe("superseded");

    expect(stored.size).toBe(0);
    expect(onVerdict).not.toHaveBeenCalled();
  });

  it("does not re-add a verdict for a chat deleted while its judgement waited or ran", async () => {
    const judge = make();
    const onVerdict = vi.fn();
    judge.onVerdict = onVerdict;
    runJudge.mockImplementationOnce(async () => {
      forgets.set("keeper-demo/s1", 1); // DELETE /chats/s1 mid-run
      return { result: { success: true }, text: "VERDICT: finished\nREASON: done" };
    });
    expect(await judge.judgeNow("demo", "s1")).toBe("deleted");
    // Deleted after the turn completed but before the run started.
    expect(await judge.judgeNow("demo", "s1", 0)).toBe("deleted");
    expect(stored.size).toBe(0);
    expect(onVerdict).not.toHaveBeenCalled();
    // A chat forgotten BEFORE its turn completed (a recycled id) is judged as normal.
    expect(await judge.judgeNow("demo", "s1")).toBe("stored");
  });

  it("does nothing at all when disabled", async () => {
    const judge = make({ config: { enabled: false, model: "x" } });
    expect(await judge.judgeNow("demo", "s1")).toBe("disabled");
    vi.useFakeTimers();
    try {
      judge.enqueue("demo", "s1");
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
    }
    expect(runJudge).not.toHaveBeenCalled();
  });

  it("keeps the previous verdict when the run fails, throws, or returns garbage", async () => {
    const previous: ChatVerdict = {
      verdict: "finished",
      reason: "old",
      turnCompletedAt: "2026-11-05T08:00:00.000Z",
      judgedAt: "2026-11-05T08:00:01.000Z",
      model: "m",
    };
    stored.set("keeper-demo/s1", previous);
    const judge = make();
    const onVerdict = vi.fn();
    judge.onVerdict = onVerdict;

    runJudge.mockResolvedValueOnce({ result: { success: false }, text: "" });
    expect(await judge.judgeNow("demo", "s1")).toBe("run-failed");
    runJudge.mockRejectedValueOnce(new Error("spawn claude ENOENT"));
    expect(await judge.judgeNow("demo", "s1")).toBe("run-failed");
    runJudge.mockResolvedValueOnce({ result: { success: true }, text: "I think it's done." });
    expect(await judge.judgeNow("demo", "s1")).toBe("unparseable");

    expect(stored.get("keeper-demo/s1")).toEqual(previous);
    expect(onVerdict).not.toHaveBeenCalled();
  });

  it("survives a throwing broadcast: the verdict is still stored", async () => {
    const judge = make();
    judge.onVerdict = () => {
      throw new Error("socket gone");
    };
    expect(await judge.judgeNow("demo", "s1")).toBe("stored");
    expect(stored.has("keeper-demo/s1")).toBe(true);
  });

  describe("enqueue (debounce + coalesce)", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("collapses a burst for one chat into one run after the quiet period", async () => {
      const judge = make();
      judge.enqueue("demo", "s1");
      await vi.advanceTimersByTimeAsync(600);
      judge.enqueue("demo", "s1");
      await vi.advanceTimersByTimeAsync(600);
      expect(runJudge).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(runJudge).toHaveBeenCalledTimes(1);
    });

    it("re-checks the running state when the timer fires", async () => {
      const judge = make();
      let busy = false;
      judge.isRunning = () => busy;
      judge.enqueue("demo", "s1");
      busy = true; // the user replied during the quiet period
      await vi.advanceTimersByTimeAsync(1500);
      expect(runJudge).not.toHaveBeenCalled();
    });

    it("runs one project's judgements one at a time", async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      runJudge.mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 100));
        inFlight--;
        return { result: { success: true }, text: "VERDICT: finished\nREASON: done" };
      });
      const judge = make();
      judge.enqueue("demo", "s1");
      judge.enqueue("demo", "s2");
      await vi.advanceTimersByTimeAsync(1500);
      expect(runJudge).toHaveBeenCalledTimes(2);
      expect(maxInFlight).toBe(1);
    });

    it("caps runs in flight across projects, queueing the rest", async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      runJudge.mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 100));
        inFlight--;
        return { result: { success: true }, text: "VERDICT: finished\nREASON: done" };
      });
      const judge = make({ maxConcurrent: 2 });
      for (const slug of ["a", "b", "c", "d", "e"]) judge.enqueue(slug, "s1");
      await vi.advanceTimersByTimeAsync(1050);
      expect(runJudge).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(500);
      expect(runJudge).toHaveBeenCalledTimes(5);
      expect(maxInFlight).toBe(2);
    });

    it("re-checks a queued chat's running state when its slot frees", async () => {
      let release = () => {};
      runJudge.mockImplementationOnce(
        () =>
          new Promise((r) => {
            release = () => r({ result: { success: true }, text: "VERDICT: finished\nREASON: x" });
          }),
      );
      const judge = make({ maxConcurrent: 1 });
      let busy = false;
      judge.isRunning = (id) => id === "s2" && busy;
      judge.enqueue("a", "s1");
      judge.enqueue("b", "s2");
      await vi.advanceTimersByTimeAsync(1050);
      expect(runJudge).toHaveBeenCalledTimes(1);
      busy = true; // s2's user replied while it waited for a slot
      release();
      await vi.advanceTimersByTimeAsync(10);
      expect(runJudge).toHaveBeenCalledTimes(1);
      expect(stored.has("keeper-b/s2")).toBe(false);
    });

    it("stop() cancels pending judgements", async () => {
      const judge = make();
      judge.enqueue("demo", "s1");
      judge.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(runJudge).not.toHaveBeenCalled();
    });
  });
});

describe("afterTurn → judge listener (ws-triggers)", () => {
  const setup = () => {
    const events = new PaddockEventBus();
    const judge = { enqueue: vi.fn() };
    const sweep = { enqueue: vi.fn() };
    const deps = {
      herdctl: { onScheduleTrigger: () => undefined },
      events,
      judge,
      sweep,
    } as unknown as ChatHandlerDeps;
    const cluster = makeTriggerCluster(deps, (async () => "x") as StartAgentTurn);
    return { cluster, judge, sweep };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("enqueues the judged session for a keeper turn, alongside the sweeper", async () => {
    const { cluster, judge, sweep } = setup();
    cluster.emitAfterTurn("demo", "s1", "keeper-demo");
    cluster.emitAfterTurn("", "r1", "keeper-_root");
    await tick();
    expect(judge.enqueue.mock.calls).toEqual([
      ["demo", "s1"],
      ["", "r1"],
    ]);
    expect(sweep.enqueue).toHaveBeenCalledTimes(2);
  });

  it("skips a trigger-agent turn and a turn with no session", async () => {
    const { cluster, judge, sweep } = setup();
    cluster.emitAfterTurn("demo", "s1", "trigger-demo-cleanup");
    cluster.emitAfterTurn("demo", null, "keeper-demo");
    await tick();
    expect(judge.enqueue).not.toHaveBeenCalled();
    // The sweeper is unaffected by the judge's filter.
    expect(sweep.enqueue).toHaveBeenCalledTimes(2);
  });
});
