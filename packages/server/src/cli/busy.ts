// From edspencer/cli-contract reference/busy-client.ts @ 1.0; local changes: `.ts` import specifiers → `.js` and
// `../runtime-file.js` (the writer lives server-side, next to the boot path that writes the file); and `hint` widened
// from a string to `string | ((result) => string | undefined)`, with {@link runBusyCommand} printing it too — that is
// what carries Paddock's keeper-chat trap (ROADMAP "Busy, per tool"), where the line to print depends on WHICH counts
// are non-zero, so a fixed string could not say it.
//
// The CLI's side of the busy check (SPEC §4): find the running instance through `<home>/runtime.json`, ask its
// `/api/busy`, and map the answer to exit 0 (idle), 75 (busy) or 3 (nothing answers), with §4's messages.
// Used by `<tool> busy`, and before `service stop`, `service restart` and `update`. Node built-ins only.

import { EXIT } from "./exit-codes.js";
import type { Output } from "./output.js";
import { readLiveRuntimeFile } from "../runtime-file.js";

/** What `/api/busy` answers (SPEC §4). Counts only, until §10's first question is settled. */
export interface BusyAnswer {
  busy: boolean;
  version?: string;
  counts?: Record<string, number>;
}

export type BusyResult =
  | { state: "not-running" }
  | { state: "idle" | "busy"; url: string; answer: BusyAnswer }
  /** Something answered, but not with a busy answer: an older version without `/api/busy`, or another program. */
  | { state: "unknown"; url: string; detail: string };

export interface FindOptions {
  /** The tool's data home, holding `runtime.json`. */
  home: string;
  /** Ask this URL instead of the one in `runtime.json` (`--url`, or a port the user named). */
  url?: string;
  /** How long to wait for an answer. §4 asks for well under a second; this allows for a slow machine. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/**
 * Asks the running instance whether it's busy. There's no fallback to a default port: an instance that's running
 * wrote `runtime.json`, and guessing a port would ask whatever else is listening there.
 */
export async function checkBusy(o: FindOptions): Promise<BusyResult> {
  const base = o.url ?? readLiveRuntimeFile(o.home)?.url;
  if (!base) return { state: "not-running" };
  const url = new URL("/api/busy", base).toString();
  const doFetch = o.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
      headers: { accept: "application/json" },
    });
  } catch {
    // Refused, reset or timed out: nothing is answering, which §4 calls not running.
    return { state: "not-running" };
  }
  if (!res.ok) return { state: "unknown", url, detail: `HTTP ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { state: "unknown", url, detail: "the answer isn't JSON" };
  }
  if (!isBusyAnswer(body)) return { state: "unknown", url, detail: "the answer has no boolean `busy`" };
  return { state: body.busy ? "busy" : "idle", url, answer: body };
}

function isBusyAnswer(v: unknown): v is BusyAnswer {
  if (typeof v !== "object" || v === null || typeof (v as BusyAnswer).busy !== "boolean") return false;
  const counts = (v as BusyAnswer).counts;
  if (counts === undefined) return true;
  return (
    typeof counts === "object" &&
    counts !== null &&
    Object.values(counts).every((n) => Number.isInteger(n) && n >= 0)
  );
}

/** A kind's singular and plural, where adding an "s" is wrong: `{ batch: ['batch', 'batches'] }`. */
export type Nouns = Record<string, [singular: string, plural: string]>;

/** `2 chats and 1 job are running`, from the non-zero counts; '' if there are none. */
export function describeCounts(counts: Record<string, number> = {}, nouns: Nouns = {}): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => {
      const [one, many] = nouns[kind] ?? [kind, `${kind}s`];
      return `${n} ${n === 1 ? one : many}`;
    });
  if (parts.length === 0) return "";
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  const total = Object.values(counts).reduce((a, n) => a + (n > 0 ? n : 0), 0);
  return `${list} ${total === 1 ? "is" : "are"} running`;
}

/** The sentence for a person (SPEC §4): `Paddock is busy: 2 chats are running.` */
export function busyMessage(name: string, result: BusyResult, nouns: Nouns = {}): string {
  switch (result.state) {
    case "not-running":
      return `${name} isn't running.`;
    case "idle":
      return `${name} isn't busy.`;
    case "busy": {
      const what = describeCounts(result.answer.counts, nouns);
      return what ? `${name} is busy: ${what}.` : `${name} is busy.`;
    }
    case "unknown":
      return `Something answered at ${result.url}, but not as ${name}'s busy check (${result.detail}).`;
  }
}

/** 0 idle, 75 busy, 3 nothing answers, 1 an answer that isn't a busy answer. */
export function busyExitCode(result: BusyResult): number {
  switch (result.state) {
    case "idle":
      return EXIT.OK;
    case "busy":
      return EXIT.BUSY;
    case "not-running":
      return EXIT.NOT_RUNNING;
    case "unknown":
      return EXIT.FAILED;
  }
}

/** What `<tool> busy --json` prints: valid against `schemas/busy.schema.json`. */
export function busyJson(result: BusyResult): Record<string, unknown> {
  if (result.state === "not-running") return { running: false, busy: false };
  if (result.state === "unknown")
    return { running: true, busy: false, url: base(result.url), error: result.detail };
  return {
    running: true,
    busy: result.answer.busy,
    url: base(result.url),
    ...(result.answer.version !== undefined ? { version: result.answer.version } : {}),
    counts: result.answer.counts ?? {},
  };
}

const base = (busyUrl: string) => busyUrl.replace(/\/api\/busy$/, "");

/**
 * LOCAL CHANGE (see the header): what to suggest when the answer is busy, as a string or as a function of the
 * result. {@link resolveHint} is what both the command and the guard call, so the two can never print different
 * advice about the same answer.
 */
export type BusyHint = string | ((result: BusyResult) => string | undefined);

function resolveHint(hint: BusyHint | undefined, result: BusyResult): string | undefined {
  return typeof hint === "function" ? hint(result) : hint;
}

export interface BusyCommandOptions extends FindOptions {
  /** The product's name, for messages: `Local Review`. */
  name: string;
  out: Output;
  nouns?: Nouns;
  /** LOCAL CHANGE: the advice printed after a busy message — Paddock's keeper-chat trap. */
  hint?: BusyHint;
}

/** `<tool> busy [--json]`. Returns the exit code; the caller sets `process.exitCode`. */
export async function runBusyCommand(o: BusyCommandOptions): Promise<number> {
  const result = await checkBusy(o);
  const message = busyMessage(o.name, result, o.nouns);
  o.out.result(busyJson(result));
  if (result.state === "unknown") o.out.error(message);
  else o.out.say(message);
  // LOCAL CHANGE: the hint rides along with a busy answer here too, not only on the guard's refusal — someone who
  // ran `paddock busy` from inside a chat needs the same sentence as someone whose `service stop` was refused.
  const hint = result.state === "busy" ? resolveHint(o.hint, result) : undefined;
  if (hint !== undefined) o.out.say(hint);
  return busyExitCode(result);
}

export interface GuardOptions extends BusyCommandOptions {
  force?: boolean;
}

/**
 * The check before `service stop`, `service restart` and `update` (SPEC §4). Returns null to go ahead, or 75 after
 * printing the refusal. With `--force` it prints the same message, prefixed `Overriding:`, and goes ahead.
 * Nothing answering goes ahead: there's nothing to cut short.
 */
export async function guardBusy(o: GuardOptions): Promise<number | null> {
  const result = await checkBusy(o);
  if (result.state !== "busy") return null;
  const message = busyMessage(o.name, result, o.nouns);
  if (o.force) {
    o.out.warn(`Overriding: ${message}`);
    return null;
  }
  const hint = resolveHint(o.hint, result) ?? "Try again once it has finished, or use --force.";
  return o.out.error(`${message} ${hint}`, EXIT.BUSY);
}
