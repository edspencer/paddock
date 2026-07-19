/**
 * SweepService — the post-turn overview + changelog curation engine
 * (GitHub issues #2 + #6).
 *
 * After a USER chat turn completes, ws.ts calls `enqueue(slug)`. The service:
 *
 *  1. COALESCES bursts per project: at most one sweep per project per
 *     `minIntervalMs` (default 5 min). Rapid turns collapse into a single
 *     trailing sweep that runs once the interval has elapsed.
 *  2. SKIPS when there's no new activity since the last sweep — tracked by a
 *     per-project watermark (the max keeper-session mtime + the time of the
 *     last successful sweep) persisted in a small state file under the data
 *     dir, so it survives restarts.
 *  3. Runs OUT OF BAND via a dedicated lightweight sweeper agent (cheap model,
 *     Read/Write/Glob/Grep only) whose working_directory is the project dir.
 *     The trigger uses HerdctlService.runSweeper (triggerType "manual"), NOT
 *     the WS user-chat path, so a sweep can NEVER enqueue another sweep — no
 *     recursion.
 *
 * The sweeper is TOOL-LESS: it returns the curated content as plain text in
 * marked sections (`<<<OVERVIEW>>> ... <<<CHANGELOG>>> [ <<<CLAUDE>>> ... ]
 * <<<END>>>`), and THIS service parses that text and writes the files itself —
 * replacing OVERVIEW.md wholesale (current synthesized state for an LLM to read
 * at the start of a new chat), appending ONE dated bullet to CHANGELOG.md
 * (append-only narrative), and — only when the sweeper reports a genuinely NEW
 * durable fact (issue #177) — AMENDING CLAUDE.md (durable project identity &
 * conventions; append-only, never a wholesale rewrite, so human-authored content
 * is preserved). If the returned text is unparseable the sweep throws (so the
 * mtime watermark doesn't advance and the next sweep retries) — no
 * partial/garbage writes. All sweep failures are non-fatal: they're logged and
 * never break chat.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { HerdctlService } from "./herdctl.js";
import { keeperAgentName } from "./herdctl.js";
import type { ProjectStore, Project } from "./projects.js";
import {
  curatorTriggerOf,
  triggerPromptFileAbsPath,
  type PaddockTrigger,
} from "./trigger-config.js";

/** Minimal logger shape (Fastify's logger satisfies this). */
export interface SweepLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface SweepServiceOptions {
  herdctl: HerdctlService;
  projects: ProjectStore;
  /** Absolute path to the data dir (where the watermark state file lives). */
  dataDir: string;
  /** Minimum ms between sweeps for a single project. Default 5 min. */
  minIntervalMs?: number;
  logger?: SweepLogger;
}

/** Per-project watermark, persisted across restarts. */
interface Watermark {
  /** ISO mtime of the newest keeper session seen at the last sweep. */
  lastSweptSessionMtime: string | null;
  /** Epoch ms of the last sweep that actually ran (success or fail). */
  lastSweptAt: number;
}

const STATE_FILE = "sweep-state.json";
const DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Optional per-project sweeper-instruction file (issue #G2). Project-relative
 * (resolved inside the project's metadata dir, the sweeper's cwd); git-tracked
 * and keeper-editable. When present, its content is appended to the sweeper's
 * curation prompt; when absent, sweep behaviour is unchanged.
 */
const SWEEP_INSTRUCTIONS_FILE = ".paddock/hooks/sweep.md";

/**
 * Generous size cap (chars) for the appended sweep-instruction file. Every other
 * project-controlled field folded into the curation prompt is bounded
 * (changelog/claudeMd via `trim(_, 2000)`, digest via `slice(-40)`/`trim(_, 600)`)
 * so prompt/token cost stays predictable; this keeps a pathologically large
 * `.paddock/hooks/sweep.md` from bloating every sweep. The cap is large enough
 * that any realistic instruction file passes through untouched — and unlike the
 * `trim(...)` helper (which flattens all whitespace to single spaces), it
 * preserves the file's markdown line structure and only truncates the overflow.
 */
const SWEEP_INSTRUCTIONS_MAX = 8000;

/**
 * Whether post-turn curation is ON for a project. A project that has NOT overridden the
 * default (no curator trigger) → ON (behaves exactly as today). A project that DECLARES
 * a `curate-overview` trigger uses its `enabled` flag authoritatively — so curation can
 * be switched OFF by declaring the trigger `enabled: false` (and, per the frozen T1
 * default of `enabled: false`, a declared curator must set `enabled: true` to sweep).
 */
export function isCurationEnabled(project: {
  triggers?: Record<string, PaddockTrigger>;
}): boolean {
  const t = curatorTriggerOf(project.triggers);
  return t ? t.enabled === true : true;
}

export class SweepService {
  private readonly herdctl: HerdctlService;
  private readonly projects: ProjectStore;
  private readonly stateFile: string;
  private readonly minIntervalMs: number;
  private readonly log: SweepLogger;

  /** In-memory watermark cache (loaded lazily, written through on change). */
  private state: Record<string, Watermark> | null = null;

  /** Pending trailing-sweep timers, keyed by slug (coalescing/debounce). */
  private timers = new Map<string, NodeJS.Timeout>();
  /** Slugs with a sweep currently executing (prevents overlap). */
  private running = new Set<string>();

  constructor(opts: SweepServiceOptions) {
    this.herdctl = opts.herdctl;
    this.projects = opts.projects;
    this.stateFile = path.join(opts.dataDir, STATE_FILE);
    // `PADDOCK_SWEEP_MIN_INTERVAL_MS` is now folded into PaddockConfig (issue
    // #269) and passed in as `minIntervalMs`; the default applies when unset.
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.log = opts.logger ?? consoleLogger();
  }

  /**
   * Request a sweep for a project after a user turn completed. Coalesced and
   * debounced: schedules a single trailing sweep at most once per
   * `minIntervalMs`. Safe to call on every turn. Never throws.
   */
  enqueue(slug: string): void {
    void this.schedule(slug).catch((err) => {
      this.log.warn({ err, slug }, "sweep: enqueue failed (non-fatal)");
    });
  }

  /** Stop all pending timers (call on shutdown). */
  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // --- scheduling --------------------------------------------------------

  private async schedule(slug: string): Promise<void> {
    // Already a trailing sweep pending for this project -> this turn is folded
    // into it (coalesced). Nothing more to do.
    if (this.timers.has(slug)) return;

    const wm = await this.watermark(slug);
    const elapsed = Date.now() - wm.lastSweptAt;
    const delay = Math.max(0, this.minIntervalMs - elapsed);

    // Schedule the (single) trailing sweep. If we're past the interval, delay
    // is 0 and it runs on the next tick; otherwise it waits out the remainder
    // so bursts within the window collapse into one sweep at the boundary.
    const timer = setTimeout(() => {
      this.timers.delete(slug);
      void this.runIfActivity(slug).catch((err) => {
        this.log.warn({ err, slug }, "sweep: run failed (non-fatal)");
      });
    }, delay);
    // Don't keep the process alive just for a pending sweep.
    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(slug, timer);
  }

  /** Run a sweep only if there's new activity since the last one. */
  private async runIfActivity(slug: string): Promise<void> {
    if (this.running.has(slug)) {
      // A sweep is mid-flight; coalesce by re-arming once it finishes.
      this.enqueue(slug);
      return;
    }

    let project: Project;
    try {
      project = await this.projects.get(slug);
    } catch {
      return; // project deleted between enqueue and run — drop silently.
    }

    // T5: the sweeper is the default `curate-overview` (event/afterTurn) trigger. A
    // project that declares it `enabled: false` has switched curation OFF — skip
    // entirely (no sweep, no watermark churn). Absent trigger ⇒ implicit default ⇒ ON,
    // so an un-customised project is unaffected.
    if (!isCurationEnabled(project)) {
      this.log.info({ slug }, "sweep: skipped (curate-overview trigger disabled)");
      return;
    }

    const sessions = await this.herdctl.recentSessions(project, 10).catch(() => []);
    const newestMtime = sessions.reduce<string | null>((max, s) => {
      return !max || s.mtime > max ? s.mtime : max;
    }, null);

    const wm = await this.watermark(slug);

    // Skip if nothing newer than the last sweep watermark.
    if (newestMtime !== null && wm.lastSweptSessionMtime !== null) {
      if (newestMtime <= wm.lastSweptSessionMtime) {
        this.log.info({ slug }, "sweep: skipped (no new activity)");
        return;
      }
    }
    if (newestMtime === null) {
      this.log.info({ slug }, "sweep: skipped (no sessions yet)");
      return;
    }

    this.running.add(slug);
    try {
      await this.runSweep(project, sessions);
      // Stamp the watermark so a follow-up sweep with no new activity is
      // skipped, and the interval clock restarts.
      await this.setWatermark(slug, {
        lastSweptSessionMtime: newestMtime,
        lastSweptAt: Date.now(),
      });
    } catch (err) {
      // Non-fatal: still stamp lastSweptAt so we don't hot-loop on a failing
      // project, but DON'T advance the session-mtime watermark (so the next
      // sweep retries the same activity).
      await this.setWatermark(slug, {
        lastSweptSessionMtime: wm.lastSweptSessionMtime,
        lastSweptAt: Date.now(),
      });
      this.log.error({ err, slug }, "sweep: sweeper run errored (non-fatal)");
    } finally {
      this.running.delete(slug);
    }
  }

  // --- the sweep itself --------------------------------------------------

  private async runSweep(
    project: Project,
    sessions: Awaited<ReturnType<HerdctlService["recentSessions"]>>,
  ): Promise<void> {
    const [overview, changelog, claudeMd, digest, fileInstructions, triggerInstructions] =
      await Promise.all([
        this.projects.readOverview(project.slug),
        this.projects.readFile(project.slug, "CHANGELOG.md").catch(() => ""),
        this.projects.readClaudeMd(project.slug).catch(() => ""),
        this.buildDigest(project, sessions),
        this.readSweepInstructions(project.slug),
        this.readTriggerInstructions(project),
      ]);

    // The curator trigger's own prompt extension (design §2.1 #4) and the git-tracked
    // `.paddock/hooks/sweep.md` are two channels of the SAME per-project curator
    // guidance — fold both under the one `=== EXTRA … ===` heading (trigger first).
    const extraInstructions = [triggerInstructions, fileInstructions]
      .filter((s) => s.length > 0)
      .join("\n\n");

    const prompt = this.curationPrompt({
      project,
      overview,
      changelog,
      claudeMd,
      digest,
      extraInstructions,
    });

    const { result, text } = await this.herdctl.runSweeper(project.slug, prompt);
    if (!result.success) {
      throw result.error ?? new Error("sweeper trigger reported failure");
    }

    // The sweeper returns text only (tool-less); parse its two marked sections
    // and write the files ourselves. Throw on unparseable output so the
    // watermark doesn't advance and the next sweep retries (no partial writes).
    const parsed = parseSweeperOutput(text);
    if (!parsed) {
      this.log.warn(
        { slug: project.slug, sessionId: result.sessionId, jobId: result.jobId },
        "sweep: sweeper output missing/unparseable markers — not writing",
      );
      throw new Error("sweeper output missing OVERVIEW/CHANGELOG markers");
    }

    await this.projects.writeOverview(project.slug, stripBoxConventions(parsed.overview));
    if (parsed.changelog) {
      // appendChangelog adds the leading "- " + dated heading, so the sweeper
      // returns the bare line.
      await this.projects.appendChangelog(project.slug, parsed.changelog);
    }
    // CLAUDE.md (issue #177): only when the sweeper returned a genuinely-new
    // durable fact (a <<<CLAUDE>>> section that wasn't NOCHANGE). Amend-only —
    // never clobbers human-authored conventions. A failure here is non-fatal:
    // OVERVIEW/CHANGELOG are already written and the watermark should still
    // advance, so warn rather than throw.
    //
    // REPO-BACKED projects (issue #187): the CLAUDE.md is the external repo's
    // OWN, upstream-owned file — the sweeper must NEVER write it (that would
    // dirty the checkout and, if pushed, leak curation upstream). OVERVIEW.md +
    // CHANGELOG.md are still curated (sidecarred in the metadata dir), just not
    // CLAUDE.md. So skip the amend entirely for repo-backed projects.
    if (parsed.claude && !project.repoBacked) {
      await this.projects.appendClaudeMd(project.slug, parsed.claude).catch((err) => {
        this.log.warn({ err, slug: project.slug }, "sweep: CLAUDE.md append failed (non-fatal)");
      });
    }

    this.log.info(
      {
        slug: project.slug,
        sessionId: result.sessionId,
        jobId: result.jobId,
        wroteChangelog: Boolean(parsed.changelog),
        wroteClaude: Boolean(parsed.claude),
      },
      "sweep: completed",
    );
  }

  /**
   * Build a compact digest of recent session activity to hand to the sweeper,
   * so it doesn't have to discover transcripts itself. We read the messages of
   * the few most-recently-active sessions and summarize roles + tool usage +
   * trimmed text.
   */
  private async buildDigest(
    project: Project,
    sessions: Awaited<ReturnType<HerdctlService["recentSessions"]>>,
  ): Promise<string> {
    const recent = sessions.slice(0, 3); // newest few are enough for a sweep.
    const parts: string[] = [];
    for (const s of recent) {
      const messages = await this.herdctl
        .sessionMessages(keeperAgentName(project.slug), s.sessionId)
        .catch(() => []);
      if (messages.length === 0) continue;
      const lines: string[] = [];
      for (const m of messages.slice(-40)) {
        if (m.role === "tool") {
          const t = m.toolCall;
          const summary = t?.inputSummary ? ` ${trim(t.inputSummary, 120)}` : "";
          lines.push(`  [tool ${t?.toolName ?? "?"}${summary}]${t?.isError ? " (error)" : ""}`);
        } else {
          const text = trim(m.content, 600);
          if (text) lines.push(`  ${m.role}: ${text}`);
        }
      }
      if (lines.length > 0) {
        const label = s.autoName ?? s.preview ?? s.sessionId.slice(0, 8);
        parts.push(`Session "${label}" (updated ${s.mtime}):\n${lines.join("\n")}`);
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : "(no readable recent transcripts)";
  }

  /**
   * Read the OPTIONAL per-project sweeper-instruction file
   * (`.paddock/hooks/sweep.md`, issue #G2) — extra curator guidance a
   * user/keeper commits to shape THIS project's OVERVIEW/CHANGELOG curation.
   *
   * The file is git-tracked and keeper-editable, and lives alongside the
   * project's `project.yaml`/OVERVIEW.md/CHANGELOG.md in the metadata dir — the
   * same directory the sweeper agent runs in (its cwd) and that `readFile`
   * resolves against (traversal-guarded). When absent or blank the sweep behaves
   * exactly as before (no append). Never throws: a read error is treated as "no
   * extra instructions" so curation is never broken by a bad/removed file.
   *
   * This is a sweeper-LOCAL convenience: it only appends text to the tool-less
   * curator's prompt (shaping its output), granting no new capability. It is
   * deliberately NOT routed through the generic hook framework.
   */
  private async readSweepInstructions(slug: string): Promise<string> {
    const raw = await this.projects
      .readFile(slug, SWEEP_INSTRUCTIONS_FILE)
      .catch(() => "");
    const text = raw.trim();
    // Bound the size like every sibling prompt field so a huge file can't bloat
    // every sweep's token cost. Realistic instruction files are well under the
    // cap; only pathological ones truncate (with a warning so it's not silent).
    if (text.length > SWEEP_INSTRUCTIONS_MAX) {
      this.log.warn(
        { slug, length: text.length, cap: SWEEP_INSTRUCTIONS_MAX },
        "sweep: .paddock/hooks/sweep.md exceeds cap — truncating for the prompt",
      );
      return text.slice(0, SWEEP_INSTRUCTIONS_MAX) + "\n…[truncated]";
    }
    return text;
  }

  /**
   * Read the OPTIONAL curator-trigger prompt extension (T5) — the `run.prompt` /
   * `run.promptFile` of the project's `curate-overview` (event/afterTurn) trigger,
   * appended to the sweeper's curation prompt exactly like `.paddock/hooks/sweep.md`.
   * This is how the design's #4 example (`"Also maintain GLOSSARY.md of domain terms."`)
   * extends the built-in sweep. `run.promptFile` resolves under `.paddock/triggers/`
   * (traversal-guarded, `.md`-only) and is read fresh at fire time, exactly as the
   * generic trigger fire path does. Absent trigger / neither field / a read error ⇒ ""
   * (no extra instructions), so curation is never broken by a bad/removed file. Capped
   * like every sibling prompt field so it can't bloat the sweep's token cost.
   */
  private async readTriggerInstructions(project: Project): Promise<string> {
    const trigger = curatorTriggerOf(project.triggers);
    if (!trigger) return "";
    let body = typeof trigger.run.prompt === "string" ? trigger.run.prompt : "";
    if (trigger.run.promptFile) {
      const abs = triggerPromptFileAbsPath(project.workingDir, trigger.run.promptFile);
      if (abs) {
        const content = await fs.readFile(abs, "utf8").catch(() => null);
        if (content !== null) body = content;
      }
    }
    const text = body.trim();
    if (text.length > SWEEP_INSTRUCTIONS_MAX) {
      this.log.warn(
        { slug: project.slug, length: text.length, cap: SWEEP_INSTRUCTIONS_MAX },
        "sweep: curate-overview trigger prompt exceeds cap — truncating",
      );
      return text.slice(0, SWEEP_INSTRUCTIONS_MAX) + "\n…[truncated]";
    }
    return text;
  }

  /** The curation prompt handed to the sweeper agent. */
  private curationPrompt(args: {
    project: Project;
    overview: string;
    changelog: string;
    claudeMd: string;
    digest: string;
    /** Optional per-project curator instructions (`.paddock/hooks/sweep.md`). */
    extraInstructions: string;
  }): string {
    const { project, overview, changelog, claudeMd, digest, extraInstructions } = args;
    const today = new Date().toISOString().slice(0, 10);
    return [
      `Project: ${project.name} (slug: ${project.slug})`,
      project.summary ? `Summary: ${project.summary}` : "",
      "",
      "You are curating project context files based on recent chat activity.",
      "",
      "=== RECENT SESSION ACTIVITY (digest) ===",
      digest,
      "",
      "=== CURRENT OVERVIEW.md ===",
      overview || "(none yet — you are creating it for the first time)",
      "",
      "=== RECENT CHANGELOG.md (tail) ===",
      trim(changelog, 2000) || "(empty)",
      "",
      "=== CURRENT CLAUDE.md (durable identity & conventions) ===",
      trim(claudeMd, 2000) || "(none yet)",
      "",
      "=== YOUR TASKS ===",
      "Do NOT use any tools. Output ONLY the three sections below, nothing else " +
        "(no preamble, no explanation). Use these LITERAL markers exactly:",
      "",
      "<<<OVERVIEW>>>",
      "Then the FULL markdown OVERVIEW.md, which REPLACES the current one " +
        "wholesale: a concise, synthesized snapshot of the project's CURRENT " +
        "state — written for an LLM to read at the start of a NEW chat. Include " +
        "what the project is, key decisions/facts established, open questions, " +
        "and next steps. Prefer a short markdown doc with clear sections. Do NOT " +
        "include a changelog or per-session history here — this is the living " +
        "current state, replaced each sweep.",
      "<<<CHANGELOG>>>",
      "Then EXACTLY ONE bullet line summarizing what happened in this recent " +
        'activity, with NO leading "- " and no date heading — just the bare ' +
        "sentence. (The system adds the bullet marker and today's " +
        `\`## ${today}\` heading.)`,
      "<<<CLAUDE>>>",
      "Then ONLY genuinely NEW, DURABLE facts about the project's identity or " +
        "conventions to APPEND to CLAUDE.md — long-lived things (what the " +
        "project fundamentally is, key architectural decisions, how we work on " +
        "it) that are NOT already present in the CURRENT CLAUDE.md above. Return " +
        "bare markdown (e.g. one or a few bullet lines). This file is amend-only " +
        "and rarely changes: do NOT restate current state, tasks, or history " +
        "(those belong in OVERVIEW.md / CHANGELOG.md), and do NOT rewrite what is " +
        "already there. If there is nothing genuinely new and durable to add, " +
        "output exactly NOCHANGE and nothing else in this section.",
      "<<<END>>>",
      "",
      "IMPORTANT — OVERVIEW.md describes the PROJECT, not the box it runs on. Do " +
        "NOT record box/environment operational conventions: how to run, build, " +
        "start, preview, or expose a dev server; port numbers; localhost vs. dev " +
        "hostnames or URLs; where to clone repos; process managers. Those are " +
        "governed authoritatively by the box's own CLAUDE.md and must never be " +
        "re-described, pinned, or contradicted here — a past chat mentioning a " +
        "specific port or a localhost URL is NOT a project fact to record. Capture " +
        "what the project IS plus its decisions, open questions, and next steps.",
      "",
      // Optional per-project curator instructions (`.paddock/hooks/sweep.md`,
      // issue #G2): appended verbatim so a project can steer its own curation
      // (e.g. "always keep a Glossary section", "note API changes prominently").
      // These refine HOW to curate; they do NOT override the literal output
      // markers or the box-conventions rule above.
      extraInstructions
        ? "=== EXTRA PROJECT-SPECIFIC CURATOR INSTRUCTIONS ===\n" +
          "The following instructions were provided by this project to guide its " +
          "curation. Honor them while still obeying the output format and rules " +
          "above.\n\n" +
          extraInstructions
        : "",
      "",
      "Be factual and terse; do not invent details not supported by the activity.",
    ]
      .filter((l) => l !== "")
      .join("\n");
  }

  // --- watermark state ---------------------------------------------------

  private async watermark(slug: string): Promise<Watermark> {
    const state = await this.loadState();
    return state[slug] ?? { lastSweptSessionMtime: null, lastSweptAt: 0 };
  }

  private async setWatermark(slug: string, wm: Watermark): Promise<void> {
    const state = await this.loadState();
    state[slug] = wm;
    await this.saveState(state);
  }

  private async loadState(): Promise<Record<string, Watermark>> {
    if (this.state) return this.state;
    try {
      const raw = await fs.readFile(this.stateFile, "utf8");
      const parsed = JSON.parse(raw) as Record<string, Watermark>;
      this.state = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      this.state = {};
    }
    return this.state;
  }

  private async saveState(state: Record<string, Watermark>): Promise<void> {
    this.state = state;
    try {
      await fs.writeFile(this.stateFile, JSON.stringify(state, null, 2), "utf8");
    } catch (err) {
      this.log.warn({ err }, "sweep: failed to persist watermark state (non-fatal)");
    }
  }
}

function trim(s: string, max: number): string {
  if (!s) return "";
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/**
 * Parse the tool-less sweeper's marked output into the overview body + a single
 * changelog line.
 *
 * Expected shape (markers are literal; `<<<CLAUDE>>>` is OPTIONAL, issue #177):
 *
 *   <<<OVERVIEW>>>
 *   ...full markdown overview (replaces OVERVIEW.md wholesale)...
 *   <<<CHANGELOG>>>
 *   ...one bullet line (no leading "- ")...
 *   <<<CLAUDE>>>
 *   ...NEW durable facts to append to CLAUDE.md, or the literal NOCHANGE...
 *   <<<END>>>
 *
 * Returns null if the OVERVIEW/CHANGELOG markers are absent or the overview is
 * empty — the caller treats that as a failure and retries (no partial writes).
 * The `<<<END>>>` marker is optional (EOF is accepted). The changelog line is
 * trimmed to a single line; an empty changelog is allowed (overview-only write).
 *
 * `claude` is the amend-only CLAUDE.md addition (issue #177): non-null ONLY when
 * a real `<<<CLAUDE>>>` section carries non-empty content that isn't `NOCHANGE`.
 * Backward-compatible: a reply with no `<<<CLAUDE>>>` marker yields `claude:
 * null` (older sweeper output, or nothing durable to add).
 */
function parseSweeperOutput(
  text: string,
): { overview: string; changelog: string; claude: string | null } | null {
  if (!text) return null;
  const overviewIdx = text.indexOf("<<<OVERVIEW>>>");
  const changelogIdx = text.indexOf("<<<CHANGELOG>>>");
  if (overviewIdx === -1 || changelogIdx === -1 || changelogIdx < overviewIdx) return null;

  const overview = text
    .slice(overviewIdx + "<<<OVERVIEW>>>".length, changelogIdx)
    .trim();
  if (overview.length === 0) return null;

  const endIdx = text.indexOf("<<<END>>>", changelogIdx);
  // The CLAUDE section (if present) closes the changelog; otherwise <<<END>>> or
  // EOF does. Match "<<<CLAUDE" so the `<<<CLAUDE:NOCHANGE>>>` variant also
  // delimits the changelog rather than leaking into it.
  const claudeMarkerIdx = text.indexOf("<<<CLAUDE", changelogIdx);
  const changelogEnd = [claudeMarkerIdx, endIdx]
    .filter((i) => i !== -1)
    .reduce<number | undefined>((min, i) => (min === undefined || i < min ? i : min), undefined);
  const rawChangelog = text.slice(changelogIdx + "<<<CHANGELOG>>>".length, changelogEnd);
  // Collapse to the first non-empty line, stripping any leading "- " the model
  // added despite instructions (appendChangelog adds its own bullet marker).
  const changelog =
    rawChangelog
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0)
      ?.replace(/^[-*]\s+/, "")
      .trim() ?? "";

  // CLAUDE.md addition (#177): only a full `<<<CLAUDE>>>` marker (not the
  // `:NOCHANGE` variant) with non-empty, non-NOCHANGE content counts.
  let claude: string | null = null;
  const claudeIdx = text.indexOf("<<<CLAUDE>>>", changelogIdx);
  if (claudeIdx !== -1) {
    const claudeEnd = text.indexOf("<<<END>>>", claudeIdx);
    const rawClaude = text
      .slice(claudeIdx + "<<<CLAUDE>>>".length, claudeEnd === -1 ? undefined : claudeEnd)
      .trim();
    if (rawClaude.length > 0 && !/^NOCHANGE$/i.test(rawClaude)) claude = rawClaude;
  }

  return { overview, changelog, claude };
}

/**
 * Belt-and-suspenders normalizer for issue #42: keep box/environment
 * operational conventions out of a curated OVERVIEW.md even when the sweeper
 * slips them in despite the prompt. OVERVIEW.md is prepended to every new chat,
 * so a stray "run the dev server on localhost:4100" line there silently
 * overrides the box CLAUDE.md — a self-reinforcing wrong-setup loop.
 *
 * This drops whole markdown sections whose heading denotes "how to run / build /
 * expose a dev server on this box" (heading + body, down to the next heading of
 * the same or higher level). Scope is deliberately narrow: only sections headed
 * by a recognized dev-ops phrase are removed; prose elsewhere is untouched. If
 * stripping would empty the document, the original is returned (we never write a
 * blank OVERVIEW).
 */
export function stripBoxConventions(overview: string): string {
  if (!overview) return overview;
  const out: string[] = [];
  let dropAtLevel: number | null = null; // set while inside a dropped section
  for (const line of overview.split("\n")) {
    const h = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (h) {
      const level = h[1].length;
      // A heading at the same or higher level closes the dropped section.
      if (dropAtLevel !== null && level <= dropAtLevel) dropAtLevel = null;
      if (dropAtLevel === null && BOX_OPS_HEADING.test(h[2])) {
        dropAtLevel = level;
        continue; // drop the heading itself
      }
    }
    if (dropAtLevel !== null) continue; // inside a dropped section
    out.push(line);
  }
  const stripped = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return stripped.length > 0 ? stripped : overview;
}

/** Headings that denote box-level "how to run a dev server here" content. */
const BOX_OPS_HEADING =
  /\b(local[-\s]dev(elopment)?|dev(elopment)?\s+server|preview\s+server|running\s+locally|run\s+locally|running\s+the\s+app|serving\s+the\s+app|how\s+to\s+run|local\s+setup|dev\s+environment)\b/i;

function consoleLogger(): SweepLogger {
  /* eslint-disable no-console */
  return {
    info: (o, m) => console.log("[sweep]", m ?? "", o),
    warn: (o, m) => console.warn("[sweep]", m ?? "", o),
    error: (o, m) => console.error("[sweep]", m ?? "", o),
  };
  /* eslint-enable no-console */
}
