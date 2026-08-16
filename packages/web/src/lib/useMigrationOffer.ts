import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { TranscriptsMigrationProbe } from "./types";
import {
  readMigrationOfferDismissed,
  writeMigrationOfferDismissed,
} from "./migrationOfferDismissal";

/**
 * The state behind the #882 transcripts-migration offer: is there one, and does
 * this browser still want to see it?
 *
 * ## One request per page load, shared by every consumer
 *
 * The probe is mounted in the app SHELL, so it is on screen for every route,
 * and the Config screen offers the same migration a second time (design §10.4).
 * Two mounted consumers must not be two requests, and the answer cannot change
 * under a running server anyway — `claude.transcripts` is resolved once at boot
 * and frozen, and a migration ends in a restart. So the promise is memoised at
 * module scope for the lifetime of the page, and {@link invalidateMigrationProbe}
 * exists for the one caller that will need it: the execute flow (PR D), which
 * has to stop offering a migration it just performed.
 *
 * ## What counts as "no banner"
 *
 * `eligible`, and only `eligible`. Not `pendingChats`, which counts transcripts
 * while eligibility is about entries in `.chats/` — a project holding nothing
 * but an agent `memory/` directory is `eligible: true` with `pendingChats: 0`,
 * and a count-driven banner would vanish on exactly that instance. And not an
 * enumeration of `reason` values either: a reason this build has never heard of
 * still means "not eligible", so gating on the boolean is what makes an
 * unrecognised reason from a newer server harmless rather than a crash.
 *
 * A failed or slow probe resolves to `null` and shows nothing. The offer is an
 * offer; there is no version of "the request failed" that should put a
 * half-drawn banner or an error into the app's top bar.
 */
let cached: Promise<TranscriptsMigrationProbe | null> | null = null;

function probeOnce(): Promise<TranscriptsMigrationProbe | null> {
  if (!cached) {
    try {
      // The rejection is swallowed HERE so it never escapes the cached promise:
      // an unhandled rejection in the shell is a console error on every route of
      // an instance whose only fault is an older server.
      cached = api.transcriptsMigration().catch(() => null);
    } catch {
      // A SYNCHRONOUS throw, which the `.catch` above cannot see. This runs
      // inside an effect in a component mounted in the app SHELL, so anything
      // that escapes here is not a missing chip — it is a white screen for every
      // route in the app. `FleetReadout` learned the same lesson from a
      // hand-rolled `matchMedia` that took all 36 AppShell tests down with it.
      cached = Promise.resolve(null);
    }
  }
  return cached;
}

/** Drop the memoised probe so the next consumer re-asks. For PR D's execute flow. */
export function invalidateMigrationProbe(): void {
  cached = null;
}

export interface MigrationOfferState {
  /** The raw probe, or `null` while loading and after a failure. */
  probe: TranscriptsMigrationProbe | null;
  /** Show the top-bar banner: the server offers a migration and this browser has not hidden it. */
  showBanner: boolean;
  /**
   * Show the Config screen's entry point. Ignores dismissal by design — this is
   * the durable home the banner's dismissal toast points at, and a dismissal
   * that also emptied Config would make "dismissible yet findable" a lie.
   *
   * `profile-paranoid` is included even though it is not `eligible`: that
   * profile suppresses the *banner* because a permanent offer to undo a posture
   * you deliberately chose is nagging, but design §10.4 rules that the migration
   * itself stays reachable. Every other ineligible reason means there is
   * genuinely nothing to offer, and an unknown one falls through to `false`.
   */
  showInConfig: boolean;
  /** Hide the banner in this browser, now and after a reload. */
  dismiss: () => void;
}

export function useMigrationOffer(): MigrationOfferState {
  const [probe, setProbe] = useState<TranscriptsMigrationProbe | null>(null);
  const [dismissed, setDismissed] = useState(readMigrationOfferDismissed);

  useEffect(() => {
    let live = true;
    void probeOnce().then((p) => {
      // A failed probe changes nothing and sets nothing. `null` is already the
      // initial state, so there is no render to schedule — and not scheduling
      // one is what keeps an older server, or a network blip, from costing every
      // route in the app an extra render on load.
      if (!live || !p) return;
      setProbe(p);
      // A dismissal must not outlive the offer that provoked it. Cleared only on
      // a DEFINITE "not eligible" — a failed probe leaves the flag alone, so a
      // server hiccup cannot resurrect a banner the user has already answered.
      if (p && !p.eligible) {
        writeMigrationOfferDismissed(false);
        setDismissed(false);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  const dismiss = useCallback(() => {
    writeMigrationOfferDismissed(true);
    setDismissed(true);
  }, []);

  return {
    probe,
    showBanner: probe?.eligible === true && !dismissed,
    showInConfig:
      probe != null &&
      probe.mode === "own" &&
      (probe.eligible || probe.reason === "profile-paranoid"),
    dismiss,
  };
}
