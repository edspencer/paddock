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

/**
 * Run a `config` action against the data dir the caller has already resolved
 * into `PADDOCK_DATA_DIR`.
 *
 * The two imports are dynamic for the same reason `paddock.ts` defers
 * `start.js`: config resolution reads the environment, so nothing that resolves
 * it may be pulled in before the caller has finished setting it.
 *
 * `createDataDir: false` is the one behavioural request this command makes of
 * the loader. Inspecting an instance must not CREATE one — otherwise
 * `paddock config show` on a machine that has never run Paddock leaves an empty
 * `~/.paddock` behind, and the first-run welcome that keys on its absence never
 * prints.
 */
export async function runConfig(action: ConfigAction, opts: CliOptions): Promise<void> {
  const { loadPaddockConfig } = await import("../config.js");
  const { resolveConfigReport, GROUPS } = await import("../instance-config.js");

  // `show` is the only action today; `config eject` is #878's other half.
  if (action !== "show") throw new Error(`unhandled config action: ${String(action)}`);

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
