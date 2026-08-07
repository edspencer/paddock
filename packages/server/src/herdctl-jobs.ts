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
 *
 * The two unread-badge reads take a {@link JobsDirIndex} instead of a `stateDir`
 * (#529): they run on nearly every request, and re-parsing every record each time
 * was 61% of all busy server CPU. The index owns the directory and keeps the parse
 * incremental; these functions are pure folds over it. The write helpers below
 * still take `stateDir` — they are rare, and the index self-heals from their
 * mtime changes (`HerdctlService` also invalidates it explicitly at each site).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { listJobs, type JobMetadata } from "@herdctl/core";
import type { Project } from "./projects.js";
import { keeperAgentName, keeperSlugFromAgent } from "./herdctl-agent-names.js";
import { jobsDirOf, type JobsDirIndex } from "./herdctl-jobs-index.js";

/**
 * Map each chat session id to the ISO timestamp of its most recent COMPLETED
 * turn, read cheaply from herdctl's job-metadata records (NOT by parsing
 * transcripts). In `batch` drive mode every keeper turn runs via `trigger()`,
 * which writes a `job-*.yaml` whose `finished_at` is stamped when the turn
 * finishes and whose `session_id` is filled in on completion — so the latest
 * `finished_at` across a session's records is exactly "the agent last finished a
 * turn." NOTE the default drive mode is `session`, whose turns write NO job
 * record (see the caveat on {@link listProjectRuns}); on that path this map is
 * fed only by paddock's synthetic adoption records. This is the server signal
 * for the unread affordance (#160, reused per-project by #161): unlike the
 * transcript mtime (`DiscoveredSession.mtime`) it does NOT tick on the user's
 * own sends.
 *
 * Records still running (no `finished_at`) or not yet session-resolved (no
 * `session_id`) are skipped. The synthetic adoption records paddock writes
 * carry an earlier, mid-turn `finished_at`, so the max naturally prefers the
 * real completion. Session-mode turns (`openChatSession`) write no job record,
 * so their chats have no server timestamp and rely on the client live event.
 *
 * Reads through {@link JobsDirIndex}, which keeps the parse incremental
 * (mtime+size keyed, completed records only) — see there for why that is safe
 * and what it is worth. This function itself is a pure fold over the index.
 */
export async function lastTurnCompletedAt(index: JobsDirIndex): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const { sessionId, finishedAt } of await index.read()) {
    // ISO-8601 UTC strings sort lexicographically in chronological order.
    const prev = out.get(sessionId);
    if (!prev || finishedAt > prev) out.set(sessionId, finishedAt);
  }
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
 * Only keeper-attributed records (`agent: keeper-<slug>`) are kept — sweeper,
 * trigger and hook records carry their own session ids that are not chats, so
 * `keeperSlugFromAgent` returning `null` naturally filters them out. A promoted
 * chat is grouped under its keeper slug (its keeper record).
 */
export async function lastTurnCompletedAtByProject(
  index: JobsDirIndex,
): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  for (const { sessionId, finishedAt, agent } of await index.read()) {
    if (agent === null) continue;
    const slug = keeperSlugFromAgent(agent);
    // only keeper (workspace) chats — skip sweeper/hook/trigger agents.
    // `""` is the ROOT workspace's key, so compare against null explicitly: a
    // falsy check would drop every root chat from the unread badge.
    if (slug === null) continue;
    let bySession = out.get(slug);
    if (!bySession) {
      bySession = new Map<string, string>();
      out.set(slug, bySession);
    }
    // ISO-8601 UTC strings sort lexicographically in chronological order.
    const prev = bySession.get(sessionId);
    if (!prev || finishedAt > prev) bySession.set(sessionId, finishedAt);
  }
  return out;
}

/**
 * The raw herdctl job records for one project's keeper agent, most-recent
 * first — the data source for the "while you were away" run-history view (E3 /
 * #268 / DD-6). Each `trigger()` (batch drive mode) turn writes one
 * `job-*.yaml` carrying `trigger_type`, `status`, `started_at`/`finished_at`,
 * `duration_seconds`, `session_id`, `schedule` and `forked_from`; this reads
 * them via core's `listJobs` (importable from `@herdctl/core`, sorted by
 * `started_at` descending) filtered to `keeper-<slug>`, so sweeper/trigger
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
 * Delete every job record matching `match`, plus each one's sibling `.jsonl`
 * output file. Returns how many records were removed.
 *
 * The shared inverse of the writes above (#732 / #734). The jobs directory is
 * append-only and fleet-wide, and until now NOTHING ever removed a record — so a
 * record outlived whatever it described. Two user-visible consequences, one
 * mechanism:
 *
 *  - A deleted CHAT kept feeding {@link lastTurnCompletedAtByProject}, i.e. the
 *    sidebar unread badge, with no chat left to open to clear it (#732).
 *  - A deleted PROJECT left its keeper's whole history behind, keyed by the
 *    agent name — which is derived from the slug, which is derived from the
 *    NAME. Re-creating a project called the same thing therefore inherited the
 *    previous incarnation's `/runs`, prompt text and reply summaries included
 *    (#734).
 *
 * Records are matched by reading them, not by parsing filenames: a job id
 * encodes only a date and six characters of the session id, which is neither an
 * agent nor a reliable session key.
 *
 * Best-effort per file, deliberately: a record we cannot read is a record we
 * cannot prove is ours, so it is left alone rather than removed on a guess, and
 * an unlink failure never fails the delete the user actually asked for. The
 * caller invalidates {@link JobsDirIndex} afterwards — the index also drops
 * vanished files on its own next scan, so this is belt-and-braces.
 */
async function purgeJobs(
  stateDir: string,
  match: (record: Record<string, unknown>) => boolean,
): Promise<number> {
  const jobsDir = jobsDirOf(stateDir);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(jobsDir);
  } catch {
    return 0; // no jobs dir yet — nothing to purge
  }

  let removed = 0;
  for (const name of entries) {
    if (!name.endsWith(".yaml")) continue;
    const file = path.join(jobsDir, name);
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = YAML.parse(await fs.readFile(file, "utf8")) as Record<string, unknown> | null;
    } catch {
      continue;
    }
    if (!parsed || !match(parsed)) continue;
    await fs.rm(file, { force: true }).catch(() => undefined);
    // The record names its own output file; fall back to the `<id>.jsonl`
    // convention {@link writeAgentAdoptionJob} writes when it does not.
    const output =
      typeof parsed.output_file === "string" && parsed.output_file.length > 0
        ? parsed.output_file
        : path.join(jobsDir, `${name.slice(0, -".yaml".length)}.jsonl`);
    // Only ever unlink an output file that lives in the jobs dir we just read.
    if (path.dirname(path.resolve(output)) === path.resolve(jobsDir)) {
      await fs.rm(output, { force: true }).catch(() => undefined);
    }
    removed++;
  }
  return removed;
}

/**
 * Drop the job records of one or more CHATS (#732) — called when Paddock removes
 * a chat from a project, so the record cannot outlive the transcript and keep
 * the sidebar badge counting a chat that is no longer there to open.
 */
export async function purgeSessionJobs(stateDir: string, sessionIds: string[]): Promise<number> {
  if (sessionIds.length === 0) return 0;
  const wanted = new Set(sessionIds);
  return purgeJobs(stateDir, (r) => typeof r.session_id === "string" && wanted.has(r.session_id));
}

/**
 * Drop the job records of one or more AGENTS (#734) — called when a project is
 * deleted, for every agent name that project owned (keeper, sweeper, hooks,
 * triggers). Agent-keyed rather than project-keyed because the agent name is
 * what the record actually carries.
 *
 * This is the containment half of the fix rather than the structural one: the
 * durable answer to "a re-created project inherits the old one's records" is to
 * key them by a stable project id instead of the user-controlled, reusable slug.
 * That is a herdctl-side identity change (records are herdctl's format, written
 * by its runtimes); purging on delete makes the leak impossible NOW without
 * waiting for it, and stays correct afterwards.
 */
export async function purgeAgentJobs(stateDir: string, agents: string[]): Promise<number> {
  if (agents.length === 0) return 0;
  const wanted = new Set(agents);
  return purgeJobs(stateDir, (r) => typeof r.agent === "string" && wanted.has(r.agent));
}

/**
 * Point every herdctl job record for `sessionId` at the project's keeper so
 * the core attribution index (last-write-wins per session) lists the session
 * under the project. A session can already have MANY job records (one per
 * turn) attributed elsewhere; simply adding a keeper record alongside them is
 * not enough — whichever record the index visits last wins. So we rewrite the
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
 * core attribution index lists the session under the project. Mirrors the shape
 * of a real job record (and the JobMetadataSchema: the id must match
 * `job-YYYY-MM-DD-[a-z0-9]{6}`).
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
 * every caller (fork/promote/adopt — see {@link attributeRunningSession}) shares
 * one implementation. Writes a `<jobId>.yaml` mapping the
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
  // a real job record by touching an empty one.
  await fs.writeFile(outputFile, "", "utf8").catch(() => undefined);
}
