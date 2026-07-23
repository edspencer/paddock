/**
 * herdctl-jobs — the on-disk `job-*.yaml` reads (run history + the unread badge)
 * and the adoption/attribution writes, split out of {@link HerdctlService}
 * (issue #403).
 *
 * Every function here depends only on the shared jobs directory (`<stateDir>/jobs`)
 * plus fs/YAML and the pure agent-name helpers — NO `fleet`/live-session state —
 * so the cluster is isolated + testable on its own. {@link HerdctlService} keeps
 * thin public wrappers (`lastTurnCompletedAt`, `listProjectRuns`, …) that thread
 * `this.cfg.stateDir`, and its internal fork/promote/attribute methods call the
 * write helpers here directly.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { listJobs, type JobMetadata } from "@herdctl/core";
import type { Project } from "./projects.js";
import { keeperAgentName, keeperSlugFromAgent } from "./herdctl-agent-names.js";

/** The shared jobs directory herdctl writes `job-*.yaml` records into. */
function jobsDirOf(stateDir: string): string {
  return path.join(stateDir, "jobs");
}

/**
 * Map each chat session id to the ISO timestamp of its most recent COMPLETED
 * turn, read cheaply from herdctl's job-metadata records (NOT by parsing
 * transcripts). In the default batch drive mode every keeper turn runs via
 * `trigger()`, which writes a `job-*.yaml` whose `finished_at` is stamped when
 * the turn finishes and whose `session_id` is filled in on completion — so the
 * latest `finished_at` across a session's records is exactly "the agent last
 * finished a turn." This is the server signal for the unread affordance (#160,
 * reused per-project by #161): unlike the transcript mtime (`DiscoveredSession.
 * mtime`) it does NOT tick on the user's own sends.
 *
 * Records still running (no `finished_at`) or not yet session-resolved (no
 * `session_id`) are skipped. The synthetic adoption records paddock writes
 * carry an earlier, mid-turn `finished_at`, so the max naturally prefers the
 * real completion. Session-mode turns (`openChatSession`) write no job record,
 * so their chats have no server timestamp and rely on the client live event.
 *
 * One `readdir` + per-file parse of the shared jobs dir — the same access
 * pattern as {@link reattributeSession}, far cheaper than a transcript scan.
 */
export async function lastTurnCompletedAt(stateDir: string): Promise<Map<string, string>> {
  const jobsDir = jobsDirOf(stateDir);
  const out = new Map<string, string>();
  let entries: string[];
  try {
    entries = await fs.readdir(jobsDir);
  } catch {
    return out; // no jobs dir yet (fresh instance)
  }
  await Promise.all(
    entries.map(async (name) => {
      if (!name.endsWith(".yaml")) return;
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = YAML.parse(await fs.readFile(path.join(jobsDir, name), "utf8")) as
          | Record<string, unknown>
          | null;
      } catch {
        return; // skip an unreadable/half-written record
      }
      const sid = parsed?.session_id;
      const finished = parsed?.finished_at;
      if (typeof sid !== "string" || typeof finished !== "string") return;
      // ISO-8601 UTC strings sort lexicographically in chronological order.
      const prev = out.get(sid);
      if (!prev || finished > prev) out.set(sid, finished);
    }),
  );
  return out;
}

/**
 * Per-project variant of {@link lastTurnCompletedAt} for the sidebar unread
 * badge (#161): group the same cheap job-record scan by the KEEPER agent that
 * owns each session, so the projects-list payload can carry a compact
 * `{ sessionId, lastTurnCompletedAt }` list per project WITHOUT the N+1
 * `listSessions` fan-out or any transcript parse. Returns `slug -> (sessionId
 * -> latest finished_at)`.
 *
 * Only keeper-attributed records (`agent: keeper-<slug>`) are kept — scratch
 * and sweeper records carry their own session ids that are not project chats,
 * so `keeperSlugFromAgent` returning `null` naturally filters them out. A chat
 * promoted from scratch is grouped under its keeper slug (its keeper record).
 */
export async function lastTurnCompletedAtByProject(
  stateDir: string,
): Promise<Map<string, Map<string, string>>> {
  const jobsDir = jobsDirOf(stateDir);
  const out = new Map<string, Map<string, string>>();
  let entries: string[];
  try {
    entries = await fs.readdir(jobsDir);
  } catch {
    return out; // no jobs dir yet (fresh instance)
  }
  await Promise.all(
    entries.map(async (name) => {
      if (!name.endsWith(".yaml")) return;
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = YAML.parse(await fs.readFile(path.join(jobsDir, name), "utf8")) as
          | Record<string, unknown>
          | null;
      } catch {
        return; // skip an unreadable/half-written record
      }
      const sid = parsed?.session_id;
      const finished = parsed?.finished_at;
      const agent = parsed?.agent;
      if (typeof sid !== "string" || typeof finished !== "string" || typeof agent !== "string") {
        return;
      }
      const slug = keeperSlugFromAgent(agent);
      if (!slug) return; // only keeper (project) chats — skip scratch/sweeper
      let bySession = out.get(slug);
      if (!bySession) {
        bySession = new Map<string, string>();
        out.set(slug, bySession);
      }
      // ISO-8601 UTC strings sort lexicographically in chronological order.
      const prev = bySession.get(sid);
      if (!prev || finished > prev) bySession.set(sid, finished);
    }),
  );
  return out;
}

/**
 * The raw herdctl job records for one project's keeper agent, most-recent
 * first — the data source for the "while you were away" run-history view (E3 /
 * #268 / DD-6). Each `trigger()` (batch drive mode) turn writes one
 * `job-*.yaml` carrying `trigger_type`, `status`, `started_at`/`finished_at`,
 * `duration_seconds`, `session_id`, `schedule` and `forked_from`; this reads
 * them via core's `listJobs` (importable from `@herdctl/core`, sorted by
 * `started_at` descending) filtered to `keeper-<slug>`, so scratch/sweeper
 * records are excluded.
 *
 * The true human/scheduled/spawned provenance is carried by Paddock's
 * {@link RunProvenanceStore} (origin/depth keyed by `session_id`), NOT by
 * `trigger_type` — paddock-initiated turns still write `trigger_type:"manual"`
 * (see ws.ts). The caller joins the two.
 *
 * Caveat (documented at {@link lastTurnCompletedAt}): session-mode turns
 * (`openChatSession`) write NO job record, so runs driven that way don't
 * appear here — only batch `trigger()` turns and paddock's synthetic adoption
 * records do. Cost columns (DD-4) are P3 and not yet on the record.
 */
export async function listProjectRuns(
  stateDir: string,
  project: Project,
  limit = 100,
): Promise<JobMetadata[]> {
  const jobsDir = jobsDirOf(stateDir);
  const agent = keeperAgentName(project.slug);
  const { jobs } = await listJobs(jobsDir, { agent }).catch(() => ({ jobs: [], errors: 0 }));
  return limit > 0 ? jobs.slice(0, limit) : jobs;
}

/**
 * Job records for a SET of agents, most-recent first (Epic T follow-up / #327) —
 * the data source for the Triggers tab's per-trigger last-run column. Used to pull
 * one project's keeper AND every scoped `trigger-<slug>-<name>` agent in a single
 * pass so {@link import("./trigger-runtime.js").buildTriggerRuntime} can attribute a
 * scoped trigger's newest run by agent name. `listJobs` has no multi-agent filter,
 * so this scans the jobs dir once (unfiltered) and keeps only the requested agents;
 * order (started_at descending) is preserved. Errors swallow to `[]` so the runtime
 * view degrades to config-only rather than failing to render.
 */
export async function listRunsForAgents(
  stateDir: string,
  agents: string[],
  limit = 200,
): Promise<JobMetadata[]> {
  if (agents.length === 0) return [];
  const jobsDir = jobsDirOf(stateDir);
  const wanted = new Set(agents);
  const { jobs } = await listJobs(jobsDir).catch(() => ({ jobs: [], errors: 0 }));
  const filtered = jobs.filter((j) => wanted.has(j.agent));
  return limit > 0 ? filtered.slice(0, limit) : filtered;
}

/**
 * Point every herdctl job record for `sessionId` at the project's keeper so
 * the core attribution index (last-write-wins per session) lists the session
 * under the project. A scratch chat writes one job record PER TURN (all
 * `agent: scratch`); simply adding a keeper record alongside them is not
 * enough — whichever record the index visits last wins. So we rewrite the
 * `agent` field of all existing records for the session. When none exist
 * (e.g. a transcript migrated from outside paddock), we synthesize one.
 */
export async function reattributeSession(
  stateDir: string,
  sessionId: string,
  project: Project,
  when: Date,
): Promise<void> {
  const jobsDir = jobsDirOf(stateDir);
  await fs.mkdir(jobsDir, { recursive: true });
  const keeper = keeperAgentName(project.slug);

  let entries: string[] = [];
  try {
    entries = await fs.readdir(jobsDir);
  } catch {
    entries = [];
  }

  let matched = 0;
  for (const name of entries) {
    if (!name.endsWith(".yaml")) continue;
    const file = path.join(jobsDir, name);
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = YAML.parse(await fs.readFile(file, "utf8")) as Record<string, unknown> | null;
    } catch {
      continue;
    }
    if (!parsed || parsed.session_id !== sessionId) continue;
    matched++;
    if (parsed.agent === keeper) continue;
    parsed.agent = keeper;
    await fs.writeFile(file, YAML.stringify(parsed), "utf8");
  }

  // No existing job records for the session — synthesize one (migration path).
  if (matched === 0) await writeAdoptionJob(stateDir, sessionId, project, when);
}

/**
 * Write a herdctl job-metadata YAML mapping `sessionId -> keeper agent` so the
 * core attribution index lists the session under the project. Mirrors the
 * shape `scripts/migrate-chat.sh` writes (and the JobMetadataSchema: the id
 * must match `job-YYYY-MM-DD-[a-z0-9]{6}`).
 */
export async function writeAdoptionJob(
  stateDir: string,
  sessionId: string,
  project: Project,
  when: Date,
): Promise<void> {
  await writeAgentAdoptionJob(stateDir, sessionId, keeperAgentName(project.slug), when);
}

/**
 * Underlying adoption-record writer, parametrized by the target agent name so
 * it serves both project keepers (fork/promote/adopt) and the scratch agent
 * (see {@link attributeRunningSession}). Writes a `<jobId>.yaml` mapping the
 * session id to `agentName` plus a matching empty `.jsonl` output file.
 */
export async function writeAgentAdoptionJob(
  stateDir: string,
  sessionId: string,
  agentName: string,
  when: Date,
): Promise<void> {
  const jobsDir = jobsDirOf(stateDir);
  await fs.mkdir(jobsDir, { recursive: true });
  const iso = (Number.isNaN(when.getTime()) ? new Date() : when).toISOString();
  const date = iso.slice(0, 10);
  const jobId = `job-${date}-${sessionId.slice(0, 6).toLowerCase()}`;
  const outputFile = path.join(jobsDir, `${jobId}.jsonl`);
  const record = {
    id: jobId,
    agent: agentName,
    schedule: null,
    trigger_type: "web",
    status: "completed",
    exit_reason: "success",
    session_id: sessionId,
    forked_from: null,
    started_at: iso,
    finished_at: iso,
    duration_seconds: 0,
    output_file: outputFile,
  };
  await fs.writeFile(path.join(jobsDir, `${jobId}.yaml`), YAML.stringify(record), "utf8");
  // herdctl's listJobs tolerates a missing output file, but keep parity with
  // a real job record (and migrate-chat.sh) by touching an empty one.
  await fs.writeFile(outputFile, "", "utf8").catch(() => undefined);
}
