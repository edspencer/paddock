/**
 * Paddock's bindings for the copied busy client (`cli/busy.ts`): the nouns its
 * message uses, the keeper-chat trap, and the two entry points — `paddock busy`
 * and the check `service stop` / `service restart` run first (CLI contract
 * SPEC §1, §4).
 *
 * Kept separate from `cli/busy.ts` so that file stays a straight copy of
 * `reference/busy-client.ts`, which is what wave C4 re-syncs. Everything in
 * here is Paddock-specific by definition: the contract says each tool's kinds of
 * work are its own.
 */
import { EXIT } from "./exit-codes.js";
import { createOutput, type Output } from "./output.js";
import {
  type BusyResult,
  type FindOptions,
  type Nouns,
  guardBusy,
  runBusyCommand,
} from "./busy.js";
import { PADDOCK_NAME } from "../version.js";

/**
 * How each count in `/api/busy` is said in a sentence (`busy.ts` on the server
 * decides the keys).
 *
 * `background` is spelled out rather than left to the default pluraliser,
 * because "3 backgrounds are running" is not English — and because "background
 * task" is the thing a user recognises from the running-work bar in the UI,
 * where they watched it start.
 */
export const PADDOCK_NOUNS: Nouns = {
  chat: ["chat turn", "chat turns"],
  background: ["background task", "background tasks"],
  job: ["scheduled job", "scheduled jobs"],
};

/**
 * What to do about a busy answer — and for Paddock, the first thing to say is
 * **where to run the command from**.
 *
 * This is the keeper-chat trap, and it is specific to Paddock and Managers
 * among the six tools: Paddock's agents can drive Paddock. A keeper chat that
 * runs `paddock service restart` or `paddock update` is itself one of the chat
 * turns the answer just counted, so it will always see itself as busy — and
 * `--force` from there does not override a mistaken reading, it kills the chat
 * that typed it, mid-sentence, along with whatever it had not finished. The
 * agent then has no way to report what happened, because the thing that would
 * report it is the thing that died.
 *
 * So when `chat` is non-zero the advice is not "wait or use --force": it is
 * "run this from a terminal". When the busy work is background tasks or
 * scheduled jobs only, nobody is holding the keyboard inside the service and
 * the ordinary advice applies.
 */
export function paddockBusyHint(result: BusyResult): string | undefined {
  if (result.state !== "busy") return undefined;
  const chats = result.answer.counts?.chat ?? 0;
  if (chats > 0) {
    // The lead sentence is short because `guardBusy` prints it on the same line
    // as the message, after `paddock: `. The reasoning goes underneath, indented
    // like every other continuation this CLI prints.
    return (
      "Run it from a terminal, not from inside a Paddock chat.\n" +
      "    One of the turns counted above may be the chat asking, and --force from there\n" +
      "    stops the service running that chat — which then never gets to say so.\n" +
      "    Otherwise: wait for the turns to finish."
    );
  }
  return "Try again once it has finished, or use --force.";
}

/** The options both entry points share: name, nouns and hint are fixed for Paddock. */
function paddockBusyOptions(home: string, out: Output): FindOptions & {
  name: string;
  out: Output;
  nouns: Nouns;
  hint: typeof paddockBusyHint;
} {
  return { home, out, name: PADDOCK_NAME, nouns: PADDOCK_NOUNS, hint: paddockBusyHint };
}

/**
 * `paddock busy [--json]` — exit 0 not busy, 75 busy, 3 nothing answering
 * (SPEC §1, §2).
 *
 * The instance is found through `<data-dir>/runtime.json` and nowhere else, so
 * this reports on the same instance `paddock serve` and `paddock config show`
 * resolve — `resolveDataDir` in paddock.ts is the one rule all three use.
 */
export async function runBusy(home: string, json: boolean): Promise<number> {
  const out = createOutput({ tool: "paddock", json });
  return runBusyCommand(paddockBusyOptions(home, out));
}

/**
 * The check before `service stop` and `service restart` (SPEC §1): refuse with
 * 75 unless `--force`, which prints the same message prefixed `Overriding:` and
 * carries on. Returns null to go ahead.
 *
 * `home` is the data dir of the INSTALLED unit, not whatever `--data-dir` this
 * invocation carries — the same rule `status` and `logs` follow (#824), because
 * the instance being stopped is the one the unit describes.
 *
 * Two deliberate non-refusals. Nothing answering goes ahead: there is nothing
 * to cut short, which is also the answer for a service that is already stopped.
 * And an instance running a Paddock from before this release has no
 * `runtime.json`, so it reads as not running and the stop proceeds exactly as
 * it did before — an upgrade cannot make a stop start failing.
 */
export async function guardServiceBusy(
  action: "stop" | "restart",
  home: string,
  opts: { force?: boolean; json?: boolean },
): Promise<number | null> {
  // No `result()` call on this path, so `--json` only decides which stream the
  // prose goes to — the one JSON document a `--json` stop may print belongs to
  // the stop, not to the check it ran first.
  const out = createOutput({ tool: "paddock", json: opts.json === true });
  const refusal = await guardBusy({
    ...paddockBusyOptions(home, out),
    ...(opts.force === true ? { force: true } : {}),
  });
  if (refusal === null) return null;
  // Spell out the way past it, after the hint about where to run it from.
  out.warn(`\n    paddock service ${action} --force      ${action} it anyway\n`);
  return EXIT.BUSY;
}
