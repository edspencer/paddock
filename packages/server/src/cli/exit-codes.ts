/**
 * The CLI contract's exit codes (SPEC §2), as constants.
 *
 * From edspencer/cli-contract SPEC.md §2 @ 0.1. Written here rather than copied
 * from `reference/exit-codes.ts` because the reference module did not exist yet
 * when Paddock aligned; wave C4 re-syncs this file to it and adds the usual
 * provenance header. The numbers, and what each means, are the contract.
 *
 * | 0 | done; running and answering; up to date; not busy
 * | 1 | failed
 * | 2 | usage: an unknown command or flag, a bad value
 * | 3 | not running: installed but not running or not answering
 * | 4 | not installed: there is no service unit
 * | 5 | this install cannot update itself          (`update`, not yet built)
 * | 6 | the update failed and was rolled back      (`update`, not yet built)
 * | 7 | the update failed and could not be rolled back
 * | 75 | busy: refused, and why was printed        (`busy`, not yet built)
 *
 * Codes 3 and 4 are what `systemctl status` and LSB init scripts use for "not
 * running" and "no such service", so a script that already branches on them
 * keeps working. 75 is `EX_TEMPFAIL` from `sysexits.h`, which is also the code
 * that makes Watchtower's pre-update hook skip an update.
 *
 * The three `update` codes are declared now and unused until wave C2. They are
 * here because the contract's whole point is that the numbers mean the same
 * thing in every tool: adding them later, from a different file, is how two
 * tools end up disagreeing about what 5 means.
 */
export const EXIT = {
  /** Done. Running and answering. Up to date. Not busy. */
  ok: 0,
  /** Failed — the catch-all. */
  failure: 1,
  /** Usage: an unknown command or flag, or a bad value. Usage follows the message. */
  usage: 2,
  /** Not running: installed, but not running or not answering. */
  notRunning: 3,
  /** Not installed: there is no service unit. */
  notInstalled: 4,
  /** This install cannot update itself; the right command was printed. */
  cannotSelfUpdate: 5,
  /** The update failed and was rolled back; the old version is running again. */
  rolledBack: 6,
  /** The update failed and could not be rolled back; a person is needed. */
  needsHuman: 7,
  /** Busy: refused, and why was printed. Try later, or use `--force`. */
  busy: 75,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
