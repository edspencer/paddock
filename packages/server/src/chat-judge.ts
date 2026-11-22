/**
 * JudgeService — after a chat's turn completes, a cheap model judges whether the
 * chat looks "finished" (the work looks done, nothing obvious left) or "could
 * continue" (the assistant asked a question, offered next steps, stopped
 * part-way, or there is clear remaining work). The verdict is stored in the
 * {@link ChatVerdictStore} and announced over the `chat:verdict` WS frame.
 *
 * Driven by the `afterTurn` event (`ws-triggers.ts`), alongside the sweeper:
 *
 *  1. DEBOUNCED per chat: a burst of `afterTurn`s for one session collapses into
 *     one judge run, {@link DEFAULT_DEBOUNCE_MS} after the last of them.
 *  2. SKIPPED when the chat has a turn running again at fire time (a queued
 *     message drained, or the user replied), when the stored verdict already
 *     judged the same completion (the cost guard: one run per completed turn), or
 *     when the transcript holds no assistant message.
 *  3. SERIALISED per project, so a project's one `judge-<slug>` agent never has
 *     two runs in flight.
 *
 * Runs OUT OF BAND via {@link HerdctlService.runJudge} — a tool-less one-shot
 * agent, never the user-chat path — so a judge run cannot emit `afterTurn` and
 * judge itself. Every failure (a run error, unparseable output, a store write)
 * is logged and leaves the previous verdict in place; nothing here can affect
 * the turn, the sweeper, or the queue.
 */
import type { ChatMessage } from "@herdctl/core";
import type { HerdctlService } from "./herdctl.js";
import { keeperAgentName } from "./herdctl.js";
import type { ProjectStore } from "./projects.js";
import type { JudgeConfig } from "./judge-config.js";
import { classifyAgentError } from "./agent-errors.js";
import { lastMessageAt as readLastMessageAt } from "./last-activity.js";
import {
  VERDICT_REASON_MAX,
  toVerdictDto,
  type ChatVerdictDto,
  type ChatVerdictKind,
  type ChatVerdictStore,
} from "./chat-verdict.js";

/** Minimal logger shape (Fastify's logger satisfies this). */
export interface JudgeLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Quiet period after the last `afterTurn` for a chat before it is judged. */
export const DEFAULT_DEBOUNCE_MS = 3000;

/** How many of the chat's last messages the judge is shown. */
export const JUDGE_MAX_MESSAGES = 12;

export interface JudgeServiceOptions {
  herdctl: Pick<HerdctlService, "runJudge" | "sessionMessages">;
  projects: Pick<ProjectStore, "get">;
  verdicts: Pick<ChatVerdictStore, "get" | "set">;
  config: JudgeConfig;
  debounceMs?: number;
  logger?: JudgeLogger;
  /** Test seam: the chat's last-message timestamp (defaults to `last-activity.ts`). */
  lastMessageAt?: (projectDir: string, sessionId: string) => Promise<string | undefined>;
}

/** What one judge attempt did — returned for the tests and the log line. */
export type JudgeOutcome =
  | "disabled"
  | "running"
  | "no-project"
  | "no-messages"
  | "unchanged"
  | "run-failed"
  | "unparseable"
  | "stored";

export class JudgeService {
  /**
   * Whether a session has a model turn in flight. Set by the WS layer, which owns
   * the session hub; until then nothing is treated as running.
   */
  isRunning: (sessionId: string) => boolean = () => false;
  /**
   * Called after a verdict is stored. Set by the WS layer to broadcast the
   * `chat:verdict` frame. Must not throw; a throw is caught and logged.
   */
  onVerdict: (slug: string, sessionId: string, verdict: ChatVerdictDto) => void = () => {};

  private readonly herdctl: JudgeServiceOptions["herdctl"];
  private readonly projects: JudgeServiceOptions["projects"];
  private readonly verdicts: JudgeServiceOptions["verdicts"];
  private readonly config: JudgeConfig;
  private readonly debounceMs: number;
  private readonly log: JudgeLogger;
  private readonly lastMessageAt: NonNullable<JudgeServiceOptions["lastMessageAt"]>;
  /** Pending debounce timers, keyed `slug \0 sessionId`. */
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** The tail of each project's run chain, so one project's runs never overlap. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(opts: JudgeServiceOptions) {
    this.herdctl = opts.herdctl;
    this.projects = opts.projects;
    this.verdicts = opts.verdicts;
    this.config = opts.config;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.log = opts.logger ?? consoleLogger();
    this.lastMessageAt = opts.lastMessageAt ?? readLastMessageAt;
  }

  /**
   * Request a judgement of one chat after its turn completed. Debounced per chat;
   * safe to call on every turn. Never throws.
   */
  enqueue(slug: string, sessionId: string): void {
    if (!this.config.enabled) return;
    const key = `${slug}\u0000${sessionId}`;
    const pending = this.timers.get(key);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.serial(slug, () => this.judgeNow(slug, sessionId));
    }, this.debounceMs);
    // Don't keep the process alive just for a pending judgement.
    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(key, timer);
  }

  /** Stop all pending timers (call on shutdown). */
  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Run `task` after every earlier task for the same project has settled. */
  private serial(slug: string, task: () => Promise<JudgeOutcome>): Promise<JudgeOutcome> {
    const prev = this.chains.get(slug) ?? Promise.resolve();
    const next = prev.then(task, task).catch((err: unknown) => {
      this.log.warn({ err, slug }, "judge: run failed (non-fatal)");
      return "run-failed" as const;
    });
    this.chains.set(slug, next);
    void next.finally(() => {
      if (this.chains.get(slug) === next) this.chains.delete(slug);
    });
    return next;
  }

  /**
   * Judge one chat now, without the debounce. Exposed for the tests; the
   * production path reaches it only through {@link enqueue}.
   */
  async judgeNow(slug: string, sessionId: string): Promise<JudgeOutcome> {
    if (!this.config.enabled) return "disabled";
    // A turn running again means the chat moved on; the next `afterTurn` judges it.
    if (this.isRunning(sessionId)) return "running";
    const project = await this.projects.get(slug).catch(() => null);
    if (!project) return "no-project";
    const keeper = keeperAgentName(slug);

    const previous = await this.verdicts.get(keeper, sessionId);
    const lastAt = await this.lastMessageAt(project.dir, sessionId).catch(() => undefined);
    if (lastAt !== undefined && previous?.turnCompletedAt === lastAt) return "unchanged";

    const messages = await this.herdctl.sessionMessages(keeper, sessionId).catch(() => []);
    if (!messages.some((m) => m.role === "assistant")) return "no-messages";
    // No datable last message (the DTO then shows any verdict unfiltered): fall
    // back to the parsed transcript's own last timestamp for the cost guard.
    const turnCompletedAt = lastAt ?? messages[messages.length - 1].timestamp;
    if (previous?.turnCompletedAt === turnCompletedAt) return "unchanged";

    let text: string;
    try {
      const run = await this.herdctl.runJudge(slug, buildJudgePrompt(messages));
      if (!run.result.success) throw run.result.error ?? new Error("judge run reported failure");
      text = run.text;
    } catch (err) {
      // As in SweepService (#684): a recognised cause is one line, an unknown one
      // keeps the error object for whoever has to debug it.
      const cause = classifyAgentError(err);
      if (cause === undefined) this.log.error({ err, slug, sessionId }, "judge: run errored");
      else this.log.warn({ slug, sessionId }, `judge: skipped, ${cause} (non-fatal)`);
      return "run-failed";
    }

    const parsed = parseJudgeOutput(text);
    if (!parsed) {
      this.log.warn(
        { slug, sessionId, output: text.slice(0, 200) },
        "judge: output unparseable — keeping the previous verdict",
      );
      return "unparseable";
    }

    const verdict = {
      ...parsed,
      turnCompletedAt,
      judgedAt: new Date().toISOString(),
      model: this.config.model,
    };
    try {
      await this.verdicts.set(keeper, sessionId, verdict);
    } catch (err) {
      this.log.warn({ err, slug, sessionId }, "judge: could not store the verdict (non-fatal)");
      return "run-failed";
    }
    try {
      this.onVerdict(slug, sessionId, toVerdictDto(verdict));
    } catch (err) {
      this.log.warn({ err, slug, sessionId }, "judge: verdict broadcast failed (non-fatal)");
    }
    this.log.info({ slug, sessionId, verdict: parsed.verdict }, "judge: stored a verdict");
    return "stored";
  }
}

/** Collapse whitespace and cap at `max` chars (an ellipsis marks the cut). */
function trim(s: string, max: number): string {
  if (!s) return "";
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/**
 * Collapse whitespace and keep the head and the tail. Used for the final reply,
 * whose END is where a question or a list of next steps usually sits.
 */
function headTail(s: string, head: number, tail: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= head + tail) return flat;
  return `${flat.slice(0, head)} … ${flat.slice(flat.length - tail)}`;
}

/**
 * The judge's user prompt: the chat's last {@link JUDGE_MAX_MESSAGES} messages,
 * trimmed the way the sweeper's digest trims them, then the output format.
 * Background-task notifications are dropped: nobody in the chat wrote them.
 */
export function buildJudgePrompt(messages: readonly ChatMessage[]): string {
  const recent = messages
    .filter((m) => m.origin?.kind !== "task-notification")
    .slice(-JUDGE_MAX_MESSAGES);
  let lastReply = -1;
  recent.forEach((m, i) => {
    if (m.role === "assistant") lastReply = i;
  });
  const lines: string[] = [];
  recent.forEach((m, i) => {
    if (m.role === "tool") {
      const t = m.toolCall;
      const summary = t?.inputSummary ? ` ${trim(t.inputSummary, 80)}` : "";
      lines.push(`[tool ${t?.toolName ?? "?"}${summary}]${t?.isError ? " (error)" : ""}`);
      return;
    }
    const text = i === lastReply ? headTail(m.content, 600, 1400) : trim(m.content, 400);
    if (text) lines.push(`${m.role}: ${text}`);
  });
  return [
    "Below are the last messages of a chat between a user and an AI coding assistant. " +
      "The assistant's final reply is where the chat stopped.",
    "",
    "=== CHAT (oldest first) ===",
    ...lines,
    "=== END CHAT ===",
    "",
    "Is this chat finished, or could the user continue it?",
    "- finished: the user's request looks done and nothing obvious is left to do.",
    "- could-continue: the assistant asked the user a question, offered next steps or " +
      "options, stopped part-way, left an error unresolved, or there is clear remaining " +
      "work the user could pick up.",
    "",
    "Do not use any tools. Reply with exactly these two lines and nothing else:",
    "VERDICT: finished|could-continue",
    "REASON: <one short sentence, under 15 words>",
  ].join("\n");
}

/** A `VERDICT:` line, tolerating markdown emphasis and a list/quote marker. */
const VERDICT_LINE_RE = /^[ \t>*_`#-]*VERDICT[ \t*_`]*:(.*)$/im;
/** A `REASON:` line, same tolerance. */
const REASON_LINE_RE = /^[ \t>*_`#-]*REASON[ \t*_`]*:(.*)$/im;

/**
 * Parse the judge's reply. Returns `null` (store nothing) unless exactly one of
 * the two verdicts can be read off the first `VERDICT:` line — so a reply that
 * echoes the template (`finished|could-continue`) is rejected rather than read
 * as `finished`. A missing `REASON:` line yields an empty reason.
 */
export function parseJudgeOutput(
  text: string,
): { verdict: ChatVerdictKind; reason: string } | null {
  if (!text) return null;
  const line = VERDICT_LINE_RE.exec(text)?.[1]?.toLowerCase();
  if (line === undefined) return null;
  const finished = /\bfinished\b/.test(line);
  const more = /\bcould[\s_-]?continue\b/.test(line);
  if (finished === more) return null;
  const rawReason = REASON_LINE_RE.exec(text)?.[1] ?? "";
  const reason = trim(rawReason.replace(/[*_`]+/g, " "), VERDICT_REASON_MAX - 1);
  return { verdict: finished ? "finished" : "could-continue", reason };
}

function consoleLogger(): JudgeLogger {
  /* eslint-disable no-console */
  return {
    info: (o, m) => console.log("[judge]", m ?? "", o),
    warn: (o, m) => console.warn("[judge]", m ?? "", o),
    error: (o, m) => console.error("[judge]", m ?? "", o),
  };
  /* eslint-enable no-console */
}
