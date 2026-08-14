import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

/** The instance-config key backing the Getting Started slideshow's dismissal. */
export const GETTING_STARTED_KEY = "gettingStartedDismissed";

/**
 * Has the Getting Started slideshow been closed? (#865)
 *
 * ## Why this is server-side and not `localStorage`
 *
 * Closing it is instance-level config, deliberately. A per-browser dismissal
 * cannot honestly be restored from an instance-level Config screen — the control
 * there would have no fact to flip, and would silently do nothing for every
 * other browser. Storing it in `paddock.config.yaml` means it closes everywhere,
 * survives a new browser, and the Config toggle is editing the same value this
 * hook reads.
 *
 * ## Why the read takes `pendingValue`, not `value`
 *
 * The resolved config is FROZEN at boot: a write lands in the file but the
 * running process keeps its old value, so `value` would still say "not
 * dismissed" until a restart and the slideshow would come back on the next
 * reload. `pendingValue` is what that same file says right now, which is the
 * question actually being asked. The field is marked `liveReload` server-side so
 * this divergence does not light the Config screen's restart banner — nothing
 * here needs a restart.
 *
 * ## Three states
 *
 * `null` is "not known yet" and is not `false`. Rendering the slideshow before
 * the answer arrives would flash it onto the screen of every user who has
 * already closed it, which is precisely the thing they asked to stop seeing.
 */
export function useGettingStarted(
  /**
   * Ask at all. `false` on every surface that does not render the slideshow —
   * a project's Home mounts the same component and must not spend a request per
   * visit on an instance-level question it has no use for. Stays `null` (never
   * known) when disabled, which reads as "do not render" at every call site.
   */
  enabled = true,
): {
  dismissed: boolean | null;
  dismiss: () => void;
} {
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api
      .getInstanceConfig()
      .then((cfg) => {
        if (!live) return;
        const field = cfg.groups
          .flatMap((g) => g.fields)
          .find((f) => f.key === GETTING_STARTED_KEY);
        const raw = field === undefined ? false : (field.pendingValue ?? field.value);
        setDismissed(raw === true);
      })
      // A config we cannot read is not a dismissal. Failing OPEN here shows the
      // slideshow — the wrong answer for someone who closed it, but recoverable
      // in one click, where the other way round hides the instance's onboarding
      // for good over one failed request.
      .catch(() => {
        if (live) setDismissed(false);
      });
    return () => {
      live = false;
    };
  }, [enabled]);

  const dismiss = useCallback(() => {
    // Optimistic: the card goes on the click, not on the round trip. A close
    // button that waits for a PUT reads as broken, and the failure mode of
    // guessing wrong is that it reappears on the next visit.
    setDismissed(true);
    // Unconditional write — no `expectedVersion`. This is one user closing one
    // card, not an edit made against a snapshot of the whole file, so a 409
    // against an unrelated concurrent change would be noise.
    void api.updateInstanceConfig({ [GETTING_STARTED_KEY]: true }).catch(() => {
      /* Reappears next visit; nothing useful to say on Home about a config write. */
    });
  }, []);

  return { dismissed, dismiss };
}
