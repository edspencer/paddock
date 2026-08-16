/**
 * `paddock config show` — what this instance's config actually resolved to (#878).
 *
 * ## Why the command exists
 *
 * #878 ships a `profile:` key so an operator's config file can stay thin: a
 * posture name plus the handful of levers they disagree with. The objection to a
 * thin file is real — "I want it all clearly written down" — and the answer is
 * not to write it all down. A materialised file is a snapshot that goes stale the
 * moment a default improves or a lever is added, and it cannot show you the env
 * vars your container sets on top. Printing the resolution can't drift, because
 * it is computed by the same loader the server boots with.
 *
 * ## Provenance is the deliverable, not the values
 *
 * A list of effective values is a thing you can already get by reading the Config
 * screen. What you cannot get anywhere is the LAYER each one came from — and the
 * layer is what tells you where to go to change it. So every row names one of
 * `env` / `file` / `profile` / `default`, and `profile` is kept distinct from
 * `default` because for the twelve posture keys there is no code default any more
 * (see `ConfigSource` in instance-config.ts).
 *
 * ## What plain `config show` does
 *
 * It prints the DECISIONS — the profile, the keys your file sets, the variables
 * your environment sets — and nothing else. That mirrors the shape #878 argues
 * for: thin by default, explicit on demand. Two failure modes it avoids: an
 * argument-less command that errors at you is rude, and one that dumps forty rows
 * makes `--resolved` pointless. The summary is a reading of the same report
 * `--resolved` prints in full, so the two can never disagree.
 *
 * The formatting functions here are pure and unit-tested; {@link runConfig} is
 * the only part that touches the filesystem, and it is exercised by running the
 * built binary.
 */
import { CliError } from "./args.js";
import type { CliOptions, ConfigAction } from "./args.js";
import type { ConfigSource, ResolvedConfigField, ResolvedConfigReport } from "../instance-config.js";

/**
 * Longest value printed in the table before it is elided. The environment prompt
 * is ~600 characters of paragraph text and would own the terminal; `--json`
 * prints every value in full for anyone who needs one.
 */
const MAX_VALUE_CHARS = 52;

/**
 * Stand-in for a `sensitive` field's value. Provenance is still reported, so the
 * row still answers "where would I change this?".
 *
 * Redaction is uniform on the flag rather than judged per field, and that is the
 * point. `FIELDS` documents itself as never carrying a secret value — but that is
 * an intention maintained by hand, not an enforced invariant, and one of the
 * three fields it already marks is `transcription.endpoint`: a URL an operator
 * typed, which can perfectly well read `https://user:token@host`. The output of
 * this command is designed to be pasted into an issue. So the safe reading of the
 * flag wins by default and `--show-sensitive` is one keystroke away — which also
 * means a field added with `sensitive: true` in two years is redacted here
 * without anyone having to remember this file exists.
 */
const HIDDEN = "(hidden)";

/** Render one value as a single line of terminal text. */
function renderValue(v: unknown): string {
  if (v === null || v === undefined) return "(unset)";
  if (Array.isArray(v)) return v.length > 0 ? v.join(", ") : "(empty)";
  if (typeof v === "string") return v === "" ? '""' : v;
  return String(v);
}

/** Collapse to one line and elide. Returns whether anything was lost. */
function oneLine(text: string): { text: string; elided: boolean } {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_VALUE_CHARS
    ? { text: `${flat.slice(0, MAX_VALUE_CHARS - 1)}…`, elided: true }
    : { text: flat, elided: false };
}

/** The source column: the layer, and enough of the origin to act on it. */
function renderSource(f: ResolvedConfigField): string {
  switch (f.source) {
    case "env":
      return `env ${f.origin}`;
    case "profile":
      return `profile (${f.origin})`;
    case "file":
      return "file";
    default:
      return "default";
  }
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** The three header lines both views share. */
function header(report: ResolvedConfigReport): string[] {
  const p = report.profile;
  const from =
    p.source === "env"
      ? `${p.origin}`
      : p.source === "file"
        ? "config file"
        : "built-in default";
  const lines = [
    `  Data dir     ${report.dataDir}`,
    `  Config file  ${report.configPath}${report.configFileExists ? "" : "  (not present)"}`,
    `  Profile      ${p.name}  (${from})`,
  ];
  if (p.unrecognised) {
    lines.push(
      `               ${p.origin ?? p.unrecognised.origin} names "${p.unrecognised.value}", which is not a known profile — ` +
        `fell back to ${p.name}`,
    );
  }
  if (report.configFileError) lines.push(`  ⚠ ${report.configFileError}`);
  return lines;
}

/**
 * File values a higher layer beat. Rendered by both views because the operator
 * who edited a file and saw nothing change is precisely who runs this command,
 * and today nothing anywhere tells them why.
 */
function shadowedSection(report: ResolvedConfigReport): string[] {
  const shadowed = report.fields.filter((f) => f.shadowedFileValue !== undefined);
  if (shadowed.length === 0) return [];
  const width = Math.max(...shadowed.map((f) => f.key.length));
  return [
    "",
    "Set in the config file but NOT in effect",
    ...shadowed.map((f) => {
      const wrote = renderValue(f.shadowedFileValue);
      const why =
        f.source === "env"
          ? `${f.origin} wins for the same key`
          : `the resolved value is ${renderValue(f.value)}`;
      return `  ${pad(f.key, width)}  file says ${wrote} — ${why}`;
    }),
  ];
}

/**
 * The default view: the decisions, not the resolution. Everything named here is
 * something a human typed somewhere.
 */
export function formatSummary(report: ResolvedConfigReport): string {
  const fromFile = report.fields.filter((f) => f.source === "file");
  const fromEnv = report.fields.filter((f) => f.source === "env");

  const lines = ["Paddock config", ...header(report), "", "Set in the config file"];
  if (fromFile.length === 0) {
    lines.push(report.configFileExists ? "  (nothing this instance reads)" : "  (no config file)");
  } else {
    const width = Math.max(...fromFile.map((f) => f.key.length));
    for (const f of fromFile) {
      lines.push(`  ${pad(f.key, width)}  ${oneLine(renderValue(f.sensitive ? HIDDEN : f.value)).text}`);
    }
  }

  lines.push("", "Set in the environment");
  if (fromEnv.length === 0) {
    lines.push("  (nothing)");
  } else {
    const width = Math.max(...fromEnv.map((f) => (f.origin ?? "").length));
    for (const f of fromEnv) {
      lines.push(
        `  ${pad(f.origin ?? "", width)}  ${f.key} = ${oneLine(renderValue(f.sensitive ? HIDDEN : f.value)).text}`,
      );
    }
  }

  lines.push(...shadowedSection(report));
  lines.push(
    "",
    `Everything else follows the ${report.profile.name} profile and Paddock's built-in defaults.`,
    "Run `paddock config show --resolved` to print every effective value and where it came from.",
  );
  return lines.join("\n");
}

/** `--resolved`: every field in the settings surface, grouped, with its layer. */
export function formatResolved(
  report: ResolvedConfigReport,
  groups: { id: string; label: string }[],
  showSensitive: boolean,
): string {
  const keyWidth = Math.max(...report.fields.map((f) => f.key.length));
  const rendered = report.fields.map((f) => {
    const hide = f.sensitive && !showSensitive && f.value !== null;
    return { field: f, ...oneLine(renderValue(hide ? HIDDEN : f.value)), hidden: hide };
  });
  const valueWidth = Math.max(...rendered.map((r) => r.text.length));

  const lines = ["Paddock config — every effective value, and the layer it came from", ...header(report)];

  for (const g of groups) {
    const rows = rendered.filter((r) => r.field.group === g.id);
    if (rows.length === 0) continue;
    lines.push("", g.label);
    for (const r of rows) {
      lines.push(`  ${pad(r.field.key, keyWidth)}  ${pad(r.text, valueWidth)}  ${renderSource(r.field)}`);
    }
  }

  lines.push(...shadowedSection(report));

  // A legend, listing only the layers actually present — a reader should not
  // have to learn what `profile (yolo)` means on an instance that has no
  // profile-sourced values left.
  const present = new Set(report.fields.map((f) => f.source));
  const legend: [ConfigSource, string, string][] = [
    ["env", "env NAME", "that variable, which beats the config file for the same key"],
    ["file", "file", report.configPath],
    [
      "profile",
      `profile (${report.profile.name})`,
      "the profile — these levers have no code default of their own",
    ],
    ["default", "default", "Paddock's built-in default"],
  ];
  const shown = legend.filter(([source]) => present.has(source));
  if (shown.length > 0) {
    const width = Math.max(...shown.map(([, term]) => term.length));
    lines.push(
      "",
      "Where the values came from",
      ...shown.map(([, term, meaning]) => `  ${pad(term, width)}  ${meaning}`),
    );
  }

  const notes: string[] = [];
  if (rendered.some((r) => r.hidden)) {
    notes.push(
      // NOT "--json prints it": --json redacts too, and pointing at it as an
      // escape hatch would be a false claim in the one place a reader is
      // deciding whether their secret just went to a terminal.
      `${HIDDEN} — a field marked sensitive. Pass --show-sensitive to print it.`,
    );
  }
  if (rendered.some((r) => r.elided)) {
    notes.push(`Values longer than ${MAX_VALUE_CHARS} characters are elided; --json prints them in full.`);
  }
  if (notes.length > 0) lines.push("", ...notes.map((n) => n));
  return lines.join("\n");
}

/** The report as JSON, with `sensitive` values replaced unless asked for. */
export function toJson(report: ResolvedConfigReport, showSensitive: boolean): string {
  return JSON.stringify(
    {
      ...report,
      fields: report.fields.map((f) =>
        f.sensitive && !showSensitive && f.value !== null
          ? { ...f, value: null, redacted: true }
          : f,
      ),
    },
    null,
    2,
  );
}

// --- `config eject` ---------------------------------------------------------

/**
 * `paddock config eject` — freeze the resolution into `paddock.config.yaml`.
 *
 * ## Why this exists next to a command that argues against it
 *
 * `config show` is the answer to "what am I actually running?", and its whole
 * case is that a printed resolution cannot drift the way a materialised file
 * can. `eject` is for the person that argument does not satisfy: someone who
 * wants the posture pinned in git, reviewable in a diff, identical across a
 * fleet, and unaffected by what a later release decides a good default is.
 *
 * That is a legitimate want and a real tradeoff, so the command's job is not
 * just to write the file — it is to make the tradeoff visible **at the moment
 * of use**, where an operator is actually deciding, rather than only in docs
 * they read once. Hence {@link formatEjectPlan}'s closing section, and hence
 * preview-by-default.
 *
 * ## Preview by default, `--write` to apply
 *
 * Ejecting is the one config operation that changes what the file MEANS rather
 * than what it says, and it spreads that change over ~forty keys, no one of
 * which looks like a decision. So the default run prints the plan — every key,
 * its value, the layer it is being frozen out of, and what is deliberately being
 * left out — and writes nothing. A flag rather than an interactive prompt
 * because the likeliest caller is a container build or a config-management task
 * that cannot answer one.
 *
 * ## What it refuses to write, and why each refusal is safe
 *
 * The key set comes from `ejectable` on the field itself (see
 * instance-config.ts): posture and editable keys in, machine-specific bindings
 * and `sensitive` fields out. Two more exclusions are decided here, from
 * provenance rather than from the field:
 *
 * - **A value an environment variable currently supplies is skipped.** This is
 *   the subtle one. Env beats file, so writing an env-sourced value into the
 *   file changes *nothing observable today* and changes the instance's behaviour
 *   on the day that variable stops being set — a deferred, silent transfer of a
 *   decision from the environment into a file, with no record that it ever was
 *   an environment decision. It is also how a stray `PADDOCK_*` left over on a
 *   build box gets baked into a committed config permanently. There is a
 *   precedent for treating this as an error rather than a courtesy: the Settings
 *   PUT path (`validatePatch`) already refuses to write a key an env var
 *   shadows, for the same reason. So eject names each one it skipped and which
 *   variable owns it; `--include-env` writes them anyway, which is the correct
 *   behaviour for the one case that genuinely wants it — deliberately migrating
 *   an instance off a wall of `PADDOCK_*` vars and into a file.
 *
 * - **A key whose effective value is `null` is skipped** — an optional nothing
 *   set, like `sweepMinIntervalMs`. `writeInstanceConfig` reads `null` as
 *   "delete this key", so there is no value to write; and emitting `key: null`
 *   would render as a decision in a file whose entire purpose is to record
 *   decisions.
 *
 * Neither exclusion can change what the instance resolves — which is the
 * property the round-trip test pins, and the one that makes the refusals safe
 * rather than merely defensible.
 *
 * ## `profile:` is written even when the environment set it
 *
 * A deliberate exception to the env rule above, and worth the paragraph because
 * it looks like an inconsistency.
 *
 * The env rule exists because writing an env value moves a decision about an
 * *existing lever* into the file invisibly. After a full eject, `profile:`
 * governs no existing lever — every key it would have supplied a default for is
 * now written out explicitly, so the line cannot change any current value. Its
 * only remaining effect is on levers that do not exist yet: a capability toggle
 * added in a later release resolves against the profile, and without this line
 * it would resolve against the built-in default profile rather than the posture
 * the operator actually froze. Ejecting from `paranoid` and silently acquiring
 * `balanced`'s answer to a future lever is the exact drift this command is
 * supposed to protect against.
 *
 * So the line goes in, and the plan says out loud that it did.
 */

/** One key the plan would write. */
export interface EjectEntry {
  key: string;
  group: string;
  value: unknown;
  /** The layer the value is being frozen OUT of. */
  source: ConfigSource;
  origin?: string;
  /** `add` — the file does not name this key. `change` — it does, inertly. */
  action: "add" | "change";
  /** What the file says today; only on `change`. */
  fileValue?: unknown;
}

/** Why a field is not in the plan. */
export type EjectSkipReason = "sensitive" | "binding" | "env" | "unset";

export interface EjectSkip {
  key: string;
  reason: EjectSkipReason;
  /** The variable name, for `env`. */
  origin?: string;
}

export interface EjectPlan {
  report: ResolvedConfigReport;
  entries: EjectEntry[];
  skipped: EjectSkip[];
  /** Keys already set in the file AND already in effect — left untouched. */
  keptFromFile: string[];
  /** The `profile:` line, and whether the file already names it. */
  profile: { name: string; write: boolean };
  /** Exactly what {@link import("../instance-config.js").writeInstanceConfig} is handed. */
  pairs: { key: string; value: unknown }[];
}

/**
 * Decide what ejecting would write. Pure — the caller does the IO — so every
 * policy decision above is unit-testable against a hand-built report.
 */
export function buildEjectPlan(report: ResolvedConfigReport, includeEnv = false): EjectPlan {
  const entries: EjectEntry[] = [];
  const skipped: EjectSkip[] = [];
  const keptFromFile: string[] = [];

  for (const f of report.fields) {
    if (!f.ejectable) {
      // `sensitive` and the machine-specific bindings are the only two ways a
      // field can be non-ejectable, and `sensitive` is on the field, so the
      // reason is recoverable without duplicating the policy out of the catalog.
      skipped.push({ key: f.key, reason: f.sensitive ? "sensitive" : "binding" });
      continue;
    }
    if (f.source === "env" && !includeEnv) {
      skipped.push({ key: f.key, reason: "env", ...(f.origin ? { origin: f.origin } : {}) });
      continue;
    }
    if (f.value === null) {
      skipped.push({ key: f.key, reason: "unset" });
      continue;
    }
    // Already in the file and already winning: leave the operator's own line
    // exactly as they wrote it, comments, quoting and all. The key is present,
    // which is all an ejected file needs; rewriting it would only churn.
    if (f.source === "file") {
      keptFromFile.push(f.key);
      continue;
    }
    entries.push({
      key: f.key,
      group: f.group,
      value: f.value,
      source: f.source,
      ...(f.origin ? { origin: f.origin } : {}),
      // The file naming a key that lost — to an env var, or to another key's
      // cascade (`selfMcpEnabled: false` collapsing `selfMcpWriteEnabled`) — is
      // the one case where eject overwrites something an operator typed. It is
      // also the case where the file currently asserts something untrue, so
      // replacing it with the effective value is the point rather than a cost.
      ...(f.shadowedFileValue !== undefined
        ? { action: "change" as const, fileValue: f.shadowedFileValue }
        : { action: "add" as const }),
    });
  }

  const writeProfile = report.profile.source !== "file";
  const pairs = entries.map(({ key, value }) => ({ key, value }));
  // Written FIRST so it lands at the top of a fresh document, where a reader
  // meets the posture before the forty keys expanding it.
  if (writeProfile) pairs.unshift({ key: "profile", value: report.profile.name });

  return {
    report,
    entries,
    skipped,
    keptFromFile,
    profile: { name: report.profile.name, write: writeProfile },
    pairs,
  };
}

/** `n item` / `n items`. */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The cost of ejecting, stated in terms of THIS plan's keys.
 *
 * #878 requires the staleness tradeoff to be surfaced where someone can act on
 * it, not just documented. A generic "you will stop getting improved defaults"
 * is easy to read past, so the two keys where that bites hardest and most
 * concretely are named with their actual contents when the plan contains them.
 */
function costSection(plan: EjectPlan): string[] {
  const has = (key: string): EjectEntry | undefined => plan.entries.find((e) => e.key === key);
  const lines = [
    "",
    "What you give up",
    "  Every key below stops following Paddock's defaults and becomes yours to",
    "  maintain. Upgrades will no longer change any of them.",
  ];

  const models = has("models");
  if (Array.isArray(models?.value)) {
    lines.push(
      `    models             pinned to today's ${plural(models.value.length, "model")}. A model added in a`,
      "                       later release will not be offered until you re-run this.",
    );
  }
  if (has("environmentPrompt")) {
    lines.push(
      "    environmentPrompt  pinned to the current text. Improvements to what agents",
      "                       are told about running in Paddock stop reaching you.",
    );
  }

  lines.push(
    "",
    "  A lever added in a later release will not be in this file at all, so the",
    "  file stops being the complete record you ejected it to be. `profile:` keeps",
    "  such a lever on your posture rather than the built-in default — but keeping",
    "  the file complete means re-running eject after upgrades.",
    "",
    "  None of this is one-way. Delete the keys you would rather inherit again,",
    "  leave `profile:` in place, and they go back to following it —",
    "  `paddock config show` will tell you which layer each one is coming from.",
  );
  return lines;
}

/**
 * Render a plan. `written` switches the tense — the two views are one function
 * so a preview cannot promise something the write does not do.
 */
export function formatEjectPlan(
  plan: EjectPlan,
  groups: { id: string; label: string }[],
  written: boolean,
): string {
  const { report } = plan;
  const lines = [
    written ? "Paddock config — ejected" : "Paddock config — eject preview",
    ...header(report),
  ];

  const total = plan.pairs.length;
  // Re-running eject on an already-ejected instance is the normal way to find
  // out whether an upgrade added a lever, so it should read as an answer rather
  // than as a write that did nothing.
  if (total === 0) {
    lines.push(
      "",
      `Nothing to write — every key eject manages is already in ${report.configPath}.`,
      ...(plan.skipped.length > 0 ? notWrittenSection(plan) : []),
    );
    return lines.join("\n");
  }
  lines.push(
    "",
    written
      ? `Wrote ${plural(total, "key")} to ${report.configPath}`
      : `Would write ${plural(total, "key")} to ${report.configPath}` +
          (report.configFileExists ? "" : "  (creating it)"),
  );

  if (plan.profile.write) {
    lines.push(
      `  profile: ${plan.profile.name}  — so a lever added in a later release still`,
      "           follows this posture rather than the built-in default",
    );
  }

  const keyWidth = Math.max(8, ...plan.entries.map((e) => e.key.length));
  const rendered = plan.entries.map((e) => ({ entry: e, ...oneLine(renderValue(e.value)) }));
  const valueWidth = Math.max(1, ...rendered.map((r) => r.text.length));

  for (const g of groups) {
    const rows = rendered.filter((r) => r.entry.group === g.id);
    if (rows.length === 0) continue;
    lines.push("", g.label);
    for (const r of rows) {
      const from =
        r.entry.action === "change"
          ? `replaces ${oneLine(renderValue(r.entry.fileValue)).text}, which is not in effect`
          : `from ${renderSource({ source: r.entry.source, origin: r.entry.origin } as ResolvedConfigField)}`;
      lines.push(`  ${pad(r.entry.key, keyWidth)}  ${pad(r.text, valueWidth)}  ${from}`);
    }
  }

  if (plan.keptFromFile.length > 0) {
    lines.push(
      "",
      `Already in the file, left untouched (${plan.keptFromFile.length})`,
      `  ${plan.keptFromFile.join(", ")}`,
    );
  }

  lines.push(...notWrittenSection(plan));
  lines.push(...costSection(plan));

  lines.push(
    "",
    written
      ? "`paddock config show --resolved` now reports these as `file`."
      : "Nothing was written. Re-run with --write to apply.",
  );
  return lines.join("\n");
}

/** The deliberate omissions, grouped by reason so the list stays readable. */
function notWrittenSection(plan: EjectPlan): string[] {
  const by = (r: EjectSkipReason): EjectSkip[] => plan.skipped.filter((s) => s.reason === r);
  const env = by("env");
  const sensitive = by("sensitive");
  const binding = by("binding");
  const unset = by("unset");
  if (plan.skipped.length === 0) return [];

  const lines = ["", "Not written"];
  if (env.length > 0) {
    lines.push(
      `  ${plural(env.length, "key")} the environment supplies — an environment variable beats the`,
      "  file, so freezing its value here would change nothing now and change this",
      "  instance the day the variable goes away. Pass --include-env to write them.",
      ...(() => {
        const w = Math.max(...env.map((s) => s.key.length));
        return env.map((s) => `    ${pad(s.key, w)}  ${s.origin ?? "env"}`);
      })(),
    );
  }
  if (sensitive.length > 0) {
    lines.push(
      `  ${plural(sensitive.length, "key")} marked sensitive — never bulk-written to disk, because one of`,
      "  them (transcription.endpoint) can carry a credential in its URL. Set one by",
      "  hand if you want it in the file.",
      `    ${sensitive.map((s) => s.key).join(", ")}`,
    );
  }
  if (binding.length > 0) {
    lines.push(
      "  Process and filesystem bindings — absolute paths and a port specific to",
      "  this machine, which would make the file unportable:",
      `    ${binding.map((s) => s.key).join(", ")}`,
    );
  }
  if (unset.length > 0) {
    lines.push(
      `  ${plural(unset.length, "optional key")} nothing has set, so there is no value to freeze:`,
      `    ${unset.map((s) => s.key).join(", ")}`,
    );
  }
  return lines;
}

/**
 * Run a `config` action against the data dir the caller has already resolved
 * into `PADDOCK_DATA_DIR`.
 *
 * The two imports are dynamic for the same reason `paddock.ts` defers
 * `start.js`: config resolution reads the environment, so nothing that resolves
 * it may be pulled in before the caller has finished setting it.
 *
 * `createDataDir: false` is the one behavioural request this command makes of
 * the loader, and it holds for `eject` too. Inspecting an instance must not
 * CREATE one — otherwise `paddock config show` on a machine that has never run
 * Paddock leaves an empty `~/.paddock` behind, and the first-run welcome that
 * keys on its absence never prints. `eject --write` does create the directory,
 * because it has to put a file in it, but only on the path that writes.
 */
export async function runConfig(action: ConfigAction, opts: CliOptions): Promise<void> {
  const { loadPaddockConfig } = await import("../config.js");
  const { resolveConfigReport, writeInstanceConfig, GROUPS } = await import(
    "../instance-config.js"
  );

  let cfg;
  try {
    cfg = loadPaddockConfig({ createDataDir: false });
  } catch (err) {
    // An unparseable file, a `PADDOCK_CONFIG` pointing at nothing, a file from a
    // newer schema, a Claude home that resolves somewhere refused — the loader
    // rejects all of these, and rejecting them here is the RIGHT answer: the
    // honest reply to "what is my config?" when it will not load is "your
    // instance would not boot". On its own it reads as though the inspection tool
    // is broken, so say whose problem it is.
    //
    // Scoped to the LOAD deliberately, and worded about the configuration rather
    // than about a file. A failure below this line is a bug in this command, and
    // claiming `paddock start` would fail too would be a false statement at the
    // moment someone most needs a true one — while a `CLAUDE_CONFIG_DIR` refusal
    // is a real boot failure with no config file involved at all.
    throw new CliError(
      `${(err as Error).message}\nThis is what \`paddock start\` would fail with too.`,
    );
  }
  const report = resolveConfigReport(cfg);

  if (action === "eject") {
    const plan = buildEjectPlan(report, opts.includeEnv === true);
    if (opts.write === true) {
      try {
        writeInstanceConfig(report.configPath, plan.pairs);
      } catch (err) {
        // An unwritable path, a read-only mount, a directory where the file
        // should be. Raised as a CliError so `paddock.ts` reports it as this
        // command failing rather than appending its "`paddock start` would fail
        // on the same file" note, which is true of a malformed config and a
        // lie about a permissions problem.
        throw new CliError(
          `could not write ${report.configPath}: ${(err as Error).message}\n` +
            `Nothing was changed. Check the path is writable, then re-run.`,
        );
      }
    }
    console.log(formatEjectPlan(plan, GROUPS, opts.write === true));
    return;
  }

  if (action !== "show") throw new Error(`unhandled config action: ${String(action)}`);

  if (opts.json) {
    console.log(toJson(report, opts.showSensitive === true));
    return;
  }
  console.log(
    opts.resolved
      ? formatResolved(report, GROUPS, opts.showSensitive === true)
      : formatSummary(report),
  );
}
