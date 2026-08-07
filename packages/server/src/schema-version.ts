/**
 * Schema versioning for the two on-disk formats paddock OWNS (issue #724).
 *
 * Those two are `project.yaml` and `paddock.config.yaml`, and only those two.
 * The `version: 1` fields elsewhere in the tree belong to herdctl — its fleet
 * config (`herdctl-agent-config.ts`) and `@herdctl/core`'s session metadata —
 * and transcripts are Claude Code's format. Paddock reads neither back.
 *
 * ## What this is for: the DOWNGRADE guard, not migrations
 *
 * There is no migration runner here, deliberately (#724, and #717 for the
 * sequencing). With `1` as the only version there is nothing to migrate, and a
 * runner with zero migrations cannot be meaningfully tested.
 *
 * The value delivered on its own is the guard. Running an OLDER paddock against
 * a data dir a newer one wrote — `npx @edspencer/paddock@0.62.0` is one command
 * away — lenient-parses it: `ProjectStore.normalize` drops every key it does not
 * recognise, and the next `update()` writes the file back without them. A
 * `path:` or a `managed:` disappears with no error. A declared version turns
 * that into "this file is version 4, I understand 1, I am not touching it".
 *
 * **Never lenient-parse a file from the future.** That is the whole point.
 *
 * ## Adoption cost: nothing
 *
 * The CURRENT on-disk shape *is* version 1, and an ABSENT `schemaVersion` reads
 * as 1 — so no live instance needs rewriting and nothing pre-adoption can break,
 * because those files genuinely are v1. Files we write carry the field
 * explicitly; existing files gain it whenever they are next written for some
 * other reason. There is no backfill.
 *
 * ## When to bump — read this before changing either format
 *
 * Bump ONLY when an old reader would get the wrong answer, or a new reader
 * cannot recover the truth from an old file:
 *
 * | Change                                              | Bump? |
 * | --------------------------------------------------- | ----- |
 * | Add an optional key with a safe default             | **No** — lenient parsing already handles it |
 * | Rename a key                                        | Yes   |
 * | Change what an existing key *means*                 | Yes — silent misinterpretation, the dangerous one |
 * | Change a default so *absence* now means something new | Yes |
 * | Remove a load-bearing key                           | Yes   |
 *
 * Adding a key does not bump, which covers most changes. The additive-vs-
 * breaking distinction is expressed by NOT bumping, rather than by a second
 * version component — hence a monotonic integer and never semver. A data file
 * has one consumer, the app, and it always wants latest: there is no version
 * negotiation for a minor/patch to describe, and migrations chain (1→2→3), which
 * "does 1.2→2.0 include 1.3?" cannot express. Rails, Django, SQLite's
 * `user_version` and IndexedDB all land in the same place.
 *
 * Worked example, so the table is not abstract. v0.64.0's `managed` default is
 * `managed ?? !(repo || path)` (`project-paths.ts`) — row four, the absence of a
 * key acquiring a derived meaning. Under this scheme that was a 1→2 migration:
 * read v1, compute `managed`, write it explicitly, stamp 2. Instead it is a
 * derivation re-evaluated on every read, forever, with `stripDto` deliberately
 * letting `managed` survive so the first PATCH pins it. It works, but it is a
 * migration in disguise, and that pattern accretes.
 *
 * The two constants are independent on purpose: a breaking change to
 * `project.yaml` should not force every `paddock.config.yaml` to claim a version
 * whose shape it never had. They happen to both be 1 today.
 */

/** Schema version of the `project.yaml` format this build writes and understands. */
export const PROJECT_SCHEMA_VERSION = 1;

/** Schema version of the `paddock.config.yaml` format this build writes and understands. */
export const CONFIG_SCHEMA_VERSION = 1;

/** The key both formats carry it under. */
export const SCHEMA_VERSION_KEY = "schemaVersion";

/**
 * The version a parsed file declares, or `null` if it declares something we
 * cannot make sense of.
 *
 * - **Absent / null** → {@link PROJECT_SCHEMA_VERSION}-era, i.e. `1`. Every file
 *   written before adoption is genuinely a v1 file.
 * - A positive integer (or a string spelling one, since YAML quoting is easy to
 *   get wrong by hand) → that integer.
 * - Anything else — `0`, `-1`, `1.5`, `"banana"`, a list — → `null`.
 *
 * `null` is deliberately treated by callers the same way a from-the-future
 * version is, not the same way an absent one is. A file whose own claim about
 * its shape is unreadable is a file we cannot establish is safe to rewrite, and
 * the failure mode this whole mechanism exists to prevent is rewriting one we
 * did not understand.
 */
export function readSchemaVersion(raw: unknown): number | null {
  if (raw === undefined || raw === null) return 1;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

/** How a declared version reads in a message, including the unreadable case. */
function describeDeclared(raw: unknown): string {
  const found = readSchemaVersion(raw);
  return found === null ? `an unreadable \`schemaVersion\` (${JSON.stringify(raw)})` : `version ${found}`;
}

/** Whether `raw` declares a version this build cannot safely read. */
export function isFromTheFuture(raw: unknown, supported: number): boolean {
  const found = readSchemaVersion(raw);
  return found === null || found > supported;
}

/**
 * Why `paddock.config.yaml` is unreadable by this build, or `undefined` if it is
 * fine. Pure, so the decision is testable without a filesystem.
 *
 * Fail-closed, in the same shape as the `claudeHome`-points-at-your-own-`~/.claude`
 * refusal in `config.ts`: an instance config from the future governs auth mode,
 * bind host and data paths, and half-understanding those is worse than not
 * starting.
 */
export function configSchemaRefusal(raw: unknown, configPath: string): string | undefined {
  if (!isFromTheFuture(raw, CONFIG_SCHEMA_VERSION)) return undefined;
  return (
    `refusing to start: ${configPath} declares ${describeDeclared(raw)} of the paddock config ` +
    `format, but this build understands up to version ${CONFIG_SCHEMA_VERSION}. It was written ` +
    `by a NEWER paddock. Reading it with this build would silently drop every key this version ` +
    `does not know, and the next write would persist the loss. Upgrade paddock to a version that ` +
    `understands it, or point PADDOCK_CONFIG at a config file this build wrote.`
  );
}

/**
 * Why a `project.yaml` cannot be read by this build, or `undefined` if it is fine.
 *
 * Asymmetric with {@link configSchemaRefusal} on purpose, and this is the
 * judgement call worth knowing about: a project from the future is SKIPPED,
 * loudly, rather than refusing the boot. `readSafe` already returns `null` for
 * an unreadable `project.yaml` and the project simply vanishes from `list()`, so
 * saying it out loud is a strict improvement on today. Bricking a whole instance
 * because one project directory was copied in from a newer box would be a worse
 * failure than the data loss being prevented.
 */
export function projectSchemaSkip(raw: unknown, file: string): string | undefined {
  if (!isFromTheFuture(raw, PROJECT_SCHEMA_VERSION)) return undefined;
  return (
    `skipping a project: ${file} declares ${describeDeclared(raw)} of the paddock project ` +
    `format, but this build understands up to version ${PROJECT_SCHEMA_VERSION}. It was written ` +
    `by a NEWER paddock. The project is hidden — NOT deleted, and the file is left exactly as it ` +
    `is — because reading it here would drop the keys this version does not know and the next ` +
    `save would persist that loss. Upgrade paddock to see it again.`
  );
}
