import type {
  AdoptChatsResult,
  AdoptSkip,
  CreateProjectInput,
  DiscoverCandidate,
  Project,
} from "./types";

/**
 * The Discover import run (#745) — two calls per accepted row, sequential,
 * client-driven.
 *
 * ## Why there is no new endpoint here
 *
 * Importing a row is `POST /api/projects` (create the unmanaged linked project)
 * followed by `POST /api/projects/<slug>/adopt-chats` (bring its ticked
 * conversations in). Both already exist and both are already the right shape:
 * once the project exists AT that path it legitimately offers that `sourceCwd`,
 * which is exactly why `adopt-chats` needed no loosening to serve this screen.
 *
 * For a handful of rows that is ~10 requests, so a streaming protocol would buy
 * nothing a per-row `await` does not already give: the client issues the calls,
 * so it knows a row's outcome the moment that row's own calls resolve.
 *
 * ## Failure is per row, and it has a middle
 *
 * The interesting failure is not "it broke" — it is CREATE SUCCEEDED, IMPORT
 * FAILED, which leaves a real but empty project sitting in the sidebar. A global
 * toast cannot say that, because the sentence is about one row and the rest of
 * the run is fine. So each row carries its own outcome and its own sentence, and
 * {@link describeOutcome} is where those sentences live — pure, so the awkward
 * ones (nothing imported; imported but two were skipped; a divergent recorded
 * path) are unit-testable without rendering anything.
 */

/** The two calls a row makes. Injected so the run is testable without `fetch`. */
export interface ImportDeps {
  createProject(input: CreateProjectInput): Promise<Project>;
  adoptChats(
    slug: string,
    opts: { sourceCwd?: string; sessionIds?: string[] },
  ): Promise<AdoptChatsResult>;
}

/** Where a row got to. `running` is what colours the in-flight row. */
export type ImportStatus = "pending" | "running" | "done";

/** What happened to one row. */
export interface ImportOutcome {
  /** Which call failed, when one did. */
  stage?: "create" | "import";
  /** The created project. Present even when the IMPORT failed — that is the
   *  whole point: something was left behind and the row has to say so. */
  project?: Project;
  adopted: number;
  skipped: AdoptSkip[];
  /** The error, when a call threw. */
  error?: string;
}

/**
 * Green / amber / red.
 *
 * Three rather than the two "green on success, red on failure" suggests, because
 * a project created with zero chats in it is neither: nothing errored, and the
 * user did not get what they asked for. Colouring it green hides an empty
 * project; colouring it red claims a failure that did not happen.
 */
export type ImportTone = "success" | "warn" | "danger";

export function outcomeTone(outcome: ImportOutcome): ImportTone {
  if (outcome.error !== undefined) return outcome.stage === "create" ? "danger" : "warn";
  return outcome.adopted > 0 ? "success" : "warn";
}

/**
 * Create the project and import its ticked conversations.
 *
 * `sourceCwd` is the CREATED project's `workingDir`, not the candidate's path:
 * the server canonicalises a linked path when it stores it, and `adopt-chats`
 * matches on exactly that stored string. Echoing the server's own answer back to
 * it is the one spelling that cannot drift.
 *
 * `sessionIds` absent means "everything this project offers" — see
 * `discoverSelection`'s `importPlan`.
 */
export async function importCandidate(
  deps: ImportDeps,
  candidate: DiscoverCandidate,
  plan: { sessionIds?: string[] },
): Promise<ImportOutcome> {
  let project: Project;
  try {
    project = await deps.createProject({
      name: candidate.name,
      slug: candidate.suggestedSlug,
      path: candidate.path,
      // Explicit, though the server would derive the same thing from `path` with
      // no `repo`. Discovery proposes directories the user already works in, and
      // `managed: true` is what gives Paddock's sweeper leave to rewrite the
      // CLAUDE.md / OVERVIEW.md of somebody's checkout.
      managed: false,
    });
  } catch (e) {
    return { stage: "create", adopted: 0, skipped: [], error: message(e) };
  }
  try {
    const result = await deps.adoptChats(project.slug, {
      sourceCwd: project.workingDir,
      ...(plan.sessionIds ? { sessionIds: plan.sessionIds } : {}),
    });
    return { project, adopted: result.adopted.length, skipped: result.skipped };
  } catch (e) {
    return { stage: "import", project, adopted: 0, skipped: [], error: message(e) };
  }
}

/**
 * Run every accepted row in order, reporting each as it lands.
 *
 * Sequential rather than concurrent: project creation writes the registry and
 * two creates racing on a slug collision is a failure mode worth not having,
 * and a user watching five rows resolve one at a time can actually read them.
 */
export async function runImport(
  deps: ImportDeps,
  jobs: Array<{ candidate: DiscoverCandidate; plan: { sessionIds?: string[] } }>,
  onRow: (path: string, status: ImportStatus, outcome?: ImportOutcome) => void,
): Promise<ImportOutcome[]> {
  const out: ImportOutcome[] = [];
  for (const job of jobs) {
    onRow(job.candidate.path, "running");
    const outcome = await importCandidate(deps, job.candidate, job.plan);
    out.push(outcome);
    onRow(job.candidate.path, "done", outcome);
  }
  return out;
}

/**
 * The engine's per-session skip reasons, in English.
 *
 * Unknown values fall through verbatim rather than being swallowed: the
 * vocabulary lives in herdctl, so a reason this list has not caught up with must
 * still reach the user as itself.
 */
const SKIP_LABELS: Record<string, string> = {
  sidechain: "sub-agent transcript",
  "already-adopted": "already adopted",
  "destination-exists": "a chat with that id already exists here",
  "attributed-to-run": "belongs to a Paddock run",
  unreadable: "transcript unreadable",
  "placement-failed": "copy failed",
  "record-failed": "could not be recorded",
};

/** `2 skipped (already adopted, sub-agent transcript)`, deduped. */
export function describeSkips(skipped: AdoptSkip[]): string {
  if (skipped.length === 0) return "";
  const reasons = [...new Set(skipped.map((s) => SKIP_LABELS[s.reason] ?? s.reason))];
  return `${skipped.length} skipped (${reasons.join(", ")})`;
}

/**
 * The row's own sentence.
 *
 * Every branch names what EXISTS now, because the user's next action depends on
 * it: a failed create left nothing, a failed import left an empty project they
 * can import into later, and a clean run with zero chats is usually the
 * divergent-spelling trap — which the row can diagnose outright, having been
 * told `recordedPath` by the scan.
 */
export function describeOutcome(outcome: ImportOutcome, candidate: DiscoverCandidate): string {
  if (outcome.stage === "create") {
    return `Couldn't create the project: ${outcome.error}`;
  }
  const slug = outcome.project?.slug ?? candidate.suggestedSlug;
  if (outcome.stage === "import") {
    return `Project “${slug}” was created, but importing its chats failed: ${outcome.error}. It is there and empty — you can import them from the project itself.`;
  }
  if (outcome.adopted === 0) {
    const skips = describeSkips(outcome.skipped);
    if (candidate.recordedPath !== undefined) {
      return `Project “${slug}” was created but no chats came with it. Its transcripts record ${candidate.recordedPath}, a different spelling of ${candidate.path}, and an import matches on the exact path.`;
    }
    return skips
      ? `Project “${slug}” was created but no chats came with it — ${skips}.`
      : `Project “${slug}” was created but no chats came with it.`;
  }
  const n = outcome.adopted;
  const skips = describeSkips(outcome.skipped);
  const head = `Adopted ${n} chat${n === 1 ? "" : "s"} into “${slug}”`;
  return skips ? `${head} — ${skips}.` : `${head}.`;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
