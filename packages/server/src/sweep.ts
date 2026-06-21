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
 * The sweeper rewrites OVERVIEW.md (replaced wholesale = current synthesized
 * state for an LLM to read at the start of a new chat) and appends ONE dated
 * bullet to CHANGELOG.md (append-only narrative). All sweep failures are
 * non-fatal: they're logged and never break chat.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { HerdctlService } from "./herdctl.js";
import type { ProjectStore, Project } from "./projects.js";

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
    this.minIntervalMs =
      opts.minIntervalMs ?? envIntervalMs() ?? DEFAULT_MIN_INTERVAL_MS;
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
    const [overview, changelog, digest] = await Promise.all([
      this.projects.readOverview(project.slug),
      this.projects.readFile(project.slug, "CHANGELOG.md").catch(() => ""),
      this.buildDigest(project, sessions),
    ]);

    const prompt = this.curationPrompt({
      project,
      overview,
      changelog,
      digest,
    });

    const result = await this.herdctl.runSweeper(project.slug, prompt);
    if (!result.success) {
      throw result.error ?? new Error("sweeper trigger reported failure");
    }
    this.log.info(
      { slug: project.slug, sessionId: result.sessionId, jobId: result.jobId },
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
        .sessionMessages(project.dir, s.sessionId)
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

  /** The curation prompt handed to the sweeper agent. */
  private curationPrompt(args: {
    project: Project;
    overview: string;
    changelog: string;
    digest: string;
  }): string {
    const { project, overview, changelog, digest } = args;
    const today = new Date().toISOString().slice(0, 10);
    return [
      `Project: ${project.name} (slug: ${project.slug})`,
      project.summary ? `Summary: ${project.summary}` : "",
      "",
      "You are curating two files in this project directory based on recent chat activity.",
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
      "=== YOUR TASKS ===",
      "1. REWRITE OVERVIEW.md in full (use the Write tool) as a concise, " +
        "synthesized snapshot of the project's CURRENT state — written for an " +
        "LLM to read at the start of a NEW chat. Include: what the project is, " +
        "key decisions/facts established, open questions, and next steps. " +
        "Prefer a short markdown doc with clear sections. Do NOT include a " +
        "changelog or per-session history here — this is the living current state, " +
        "replaced each sweep.",
      "2. APPEND exactly ONE dated bullet to CHANGELOG.md summarizing what " +
        `happened in this recent activity, under a \`## ${today}\` heading ` +
        "(create the heading if today's is not already present; otherwise add " +
        "the bullet under it). Keep existing entries untouched — this file is " +
        "append-only.",
      "",
      "Read the files first if you need their exact current contents. Be factual " +
        "and terse; do not invent details not supported by the activity. When done, " +
        "stop — do not ask questions.",
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

function envIntervalMs(): number | undefined {
  const v = process.env.PADDOCK_SWEEP_MIN_INTERVAL_MS;
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function consoleLogger(): SweepLogger {
  /* eslint-disable no-console */
  return {
    info: (o, m) => console.log("[sweep]", m ?? "", o),
    warn: (o, m) => console.warn("[sweep]", m ?? "", o),
    error: (o, m) => console.error("[sweep]", m ?? "", o),
  };
  /* eslint-enable no-console */
}
