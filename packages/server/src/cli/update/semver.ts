/**
 * The small semver `update` needs, and no more (CLI contract SPEC §5 step 4).
 *
 * Three questions are asked of versions in this contract: is the target newer
 * than what we have, is it a prerelease, and does the target's `engines.node`
 * accept the Node running the update. That is it — so this is ~120 lines of
 * Node built-ins rather than a dependency, which is what SPEC §5 asks for and
 * what keeps `update` runnable from a CLI that must not load the server.
 *
 * **What it deliberately does not do.** No `semver` package behaviours beyond
 * the above: no ranges with hyphens (`1.2 - 2.3`), no `x`-ranges (`1.x`), no
 * build metadata ordering. An `engines.node` we cannot parse is reported as
 * "cannot tell" rather than as "fails", because refusing an update on the
 * strength of a range this file does not understand would be the worse error of
 * the two — see {@link satisfiesEngines}.
 *
 * Generic: wave C4 lifts this into `reference/` with the rest of `update`.
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** The dot-separated identifiers after `-`, empty for a release. */
  prerelease: (string | number)[];
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/** `1.2.3-rc.1` → a {@link Version}, or undefined if it is not a version. */
export function parseVersion(raw: string): Version | undefined {
  const m = VERSION_RE.exec(raw.trim());
  if (m === null) return undefined;
  const prerelease =
    m[4] === undefined
      ? []
      : m[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease };
}

/** Is this a prerelease? SPEC §5: prereleases count only when `--to` names them. */
export function isPrerelease(raw: string): boolean {
  return (parseVersion(raw)?.prerelease.length ?? 0) > 0;
}

/**
 * -1, 0 or 1, by the semver rules — including the prerelease ones, which are
 * the only interesting part: `1.0.0-rc.1` is LOWER than `1.0.0`, numeric
 * identifiers compare numerically and sort below alphanumeric ones, and a
 * longer run of identifiers wins when every shared one is equal.
 *
 * Build metadata is ignored, as semver says it must be.
 */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  // Unparseable compares as equal rather than throwing: the callers all have a
  // better answer for "I cannot tell" than a crash (`update` says the registry
  // gave it something it did not understand, and stops).
  if (va === undefined || vb === undefined) return 0;
  for (const k of ["major", "minor", "patch"] as const) {
    if (va[k] !== vb[k]) return va[k] < vb[k] ? -1 : 1;
  }
  if (va.prerelease.length === 0 && vb.prerelease.length === 0) return 0;
  if (va.prerelease.length === 0) return 1;
  if (vb.prerelease.length === 0) return -1;
  const n = Math.max(va.prerelease.length, vb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = va.prerelease[i];
    const y = vb.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = typeof x === "number";
    const yNum = typeof y === "number";
    if (xNum && yNum) return x < y ? -1 : 1;
    if (xNum) return -1;
    if (yNum) return 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/** Is `a` strictly newer than `b`? */
export const isNewer = (a: string, b: string): boolean => compareVersions(a, b) > 0;

/** The highest of a list, ignoring anything unparseable. Undefined if none parse. */
export function maxVersion(versions: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const v of versions) {
    if (parseVersion(v) === undefined) continue;
    if (best === undefined || isNewer(v, best)) best = v;
  }
  return best;
}

const COMPARATOR_RE = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/;

interface Comparator {
  op: ">=" | "<=" | ">" | "<" | "=";
  version: Version;
}

/**
 * Expand one range atom into the comparators it means.
 *
 * `^22.1.0` is `>=22.1.0 <23.0.0`; `~22.1.0` is `>=22.1.0 <22.2.0`; a bare
 * `22` is `>=22.0.0 <23.0.0` (npm's partial-version semantics, which is what
 * `engines: { node: "22" }` means in the wild). Returns undefined for anything
 * this file does not understand, which propagates up as "cannot tell".
 */
function comparatorsFor(atom: string): Comparator[] | undefined {
  const m = COMPARATOR_RE.exec(atom);
  if (m === null) return undefined;
  const op = m[1] ?? "=";
  const major = Number(m[2]);
  const wild = (s: string | undefined) => s === undefined || s === "x" || s === "X" || s === "*";
  const minorWild = wild(m[3]);
  const patchWild = wild(m[4]);
  const minor = minorWild ? 0 : Number(m[3]);
  const patch = patchWild ? 0 : Number(m[4]);
  const prerelease =
    m[5] === undefined ? [] : m[5].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  const at = (ma: number, mi: number, pa: number): Version => ({
    major: ma,
    minor: mi,
    patch: pa,
    prerelease: [],
  });
  const lower: Version = { major, minor, patch, prerelease };

  if (op === "^") {
    // `^0.x` tightens: ^0.2.3 is >=0.2.3 <0.3.0, ^0.0.3 is >=0.0.3 <0.0.4.
    const upper =
      major > 0
        ? at(major + 1, 0, 0)
        : minor > 0 || !minorWild
          ? at(0, minor + 1, 0)
          : at(1, 0, 0);
    return [
      { op: ">=", version: lower },
      { op: "<", version: upper },
    ];
  }
  if (op === "~") {
    const upper = minorWild ? at(major + 1, 0, 0) : at(major, minor + 1, 0);
    return [
      { op: ">=", version: lower },
      { op: "<", version: upper },
    ];
  }
  if (op === "=" && (minorWild || patchWild)) {
    // A partial version with no operator is a range, not an equality: `22`
    // means the whole 22 line, and `22.1` means the whole 22.1 line.
    const upper = minorWild ? at(major + 1, 0, 0) : at(major, minor + 1, 0);
    return [
      { op: ">=", version: lower },
      { op: "<", version: upper },
    ];
  }
  if (minorWild || patchWild) {
    // `>=22` / `<23`: fill the missing parts with zero, which is what the
    // comparison wants in both directions.
    return [{ op: op as Comparator["op"], version: lower }];
  }
  return [{ op: op as Comparator["op"], version: lower }];
}

function satisfiesComparator(v: Version, c: Comparator): boolean {
  const cmp = compare(v, c.version);
  switch (c.op) {
    case ">=":
      return cmp >= 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case "<":
      return cmp < 0;
    case "=":
      return cmp === 0;
  }
}

function compare(a: Version, b: Version): number {
  return compareVersions(stringify(a), stringify(b));
}

function stringify(v: Version): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease.length === 0 ? base : `${base}-${v.prerelease.join(".")}`;
}

/**
 * Does `version` satisfy `range`? Undefined means "this file cannot tell".
 *
 * Supports the forms an `engines.node` actually uses: `>=22`, `>=22.0.0`,
 * `^22.1.0`, `~22.1`, `22`, `22.x`, `>=20 <23`, and `||` between any of those.
 * `*` and an empty range accept everything.
 */
export function satisfies(version: string, range: string): boolean | undefined {
  const v = parseVersion(version);
  if (v === undefined) return undefined;
  const trimmed = range.trim();
  if (trimmed === "" || trimmed === "*" || trimmed === "x") return true;
  const alternatives = trimmed.split("||");
  let known = false;
  for (const alt of alternatives) {
    const atoms = alt.trim().split(/\s+/).filter(Boolean);
    const comparators: Comparator[] = [];
    let parsed = true;
    for (const atom of atoms) {
      const cs = comparatorsFor(atom);
      if (cs === undefined) {
        parsed = false;
        break;
      }
      comparators.push(...cs);
    }
    if (!parsed) continue;
    known = true;
    if (comparators.every((c) => satisfiesComparator(v, c))) return true;
  }
  // Every alternative we could read said no. If we could read none of them, say
  // so rather than claiming a refusal.
  return known ? false : undefined;
}

export interface EnginesVerdict {
  /** True pass, false genuine fail, undefined when the range could not be read. */
  ok: boolean | undefined;
  /** The range as published, for the message. */
  range: string | undefined;
}

/**
 * Will the target version run on this Node? (SPEC §5 step 4.)
 *
 * The three-way answer is the point. A target with no `engines.node` at all, or
 * one whose range this file cannot parse, must NOT block an update: the cost of
 * a false refusal is a tool that cannot update itself and says something the
 * user cannot act on, while the cost of letting an incompatible Node through is
 * the failure `engines` would have produced anyway, with a rollback behind it.
 */
export function satisfiesEngines(
  nodeVersion: string,
  engines: { node?: string } | undefined,
): EnginesVerdict {
  const range = engines?.node;
  if (range === undefined || range.trim() === "") return { ok: true, range: undefined };
  return { ok: satisfies(nodeVersion, range), range };
}
