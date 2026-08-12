/**
 * HerdctlService.stopBackgroundTask — stopping ONE piece of background work (#848).
 *
 * The whole value of this method is that it does not flatten three genuinely
 * different answers into a boolean. Getting that wrong is not cosmetic:
 *
 *   - reporting a REJECTION as success tells the user a task stopped while it is
 *     still running, which is the one thing a stop button must never do; and
 *   - reporting `false` as a failure alarms them about work that is already
 *     gone, and invites a retry that can never succeed.
 *
 * Also pinned here: the call is keyed on the SESSION, not on `liveSessions`.
 * That map is emptied when the primary turn's result lands while the background
 * tasks keep running — so a `liveSessions`-keyed stop would go inert during
 * exactly the phase the running-work bar exists for.
 */
import { describe, it, expect, vi } from "vitest";
import { HerdctlService } from "../../src/herdctl.js";
import type { PaddockConfig } from "../../src/config.js";
import type { RuntimeSession } from "@herdctl/core";

const SESSION = "sess-1";
const TASK = "task_42";

function svc(stopTaskInSession: (s: string, t: string) => Promise<boolean>) {
  const spy = vi.fn(stopTaskInSession);
  const service = new HerdctlService({} as PaddockConfig);
  (service as unknown as { fleet: unknown }).fleet = { stopTaskInSession: spy };
  return { service, spy };
}

describe("HerdctlService.stopBackgroundTask (#848)", () => {
  it("reports `stopping` when the runtime accepts the stop", async () => {
    const { service, spy } = svc(async () => true);
    await expect(service.stopBackgroundTask(SESSION, TASK)).resolves.toEqual({
      outcome: "stopping",
    });
    expect(spy).toHaveBeenCalledWith(SESSION, TASK);
  });

  it("reports `stopping` — NOT an error — for a task that already finished", async () => {
    // Idempotence, and the reason there is deliberately no liveness pre-check:
    // the CLI turns `not_found` / `not_running` into a success, so a click that
    // raced a natural completion is indistinguishable from one that landed. A
    // pre-check would only reintroduce the race the design absorbs.
    const { service } = svc(async () => true);
    await expect(service.stopBackgroundTask(SESSION, "task_already_done")).resolves.toEqual({
      outcome: "stopping",
    });
  });

  it("reports `gone` when there is no live session with that id", async () => {
    // A reap landing between render and click. Not a failure: the tasks died
    // with the session, so the user's intent is already satisfied.
    const { service } = svc(async () => false);
    await expect(service.stopBackgroundTask(SESSION, TASK)).resolves.toEqual({ outcome: "gone" });
  });

  it("reports `error` when the runtime REFUSES — a monitor_mcp task", async () => {
    // The CLI has no kill strategy for `monitor_mcp` and answers
    // `unsupported_type`. It must surface, not be laundered into a success.
    const { service } = svc(async () => {
      throw new Error("unsupported_type");
    });
    await expect(service.stopBackgroundTask(SESSION, TASK)).resolves.toEqual({
      outcome: "error",
      message: "unsupported_type",
    });
  });

  it("reports `error` for a live session whose handle carries no stopTask", async () => {
    // SessionTaskControlUnsupportedError. Resolving quietly here would report a
    // task as stopped that is still running — so it is thrown upstream, and kept
    // distinct from the `false` that means "not live".
    const { service } = svc(async () => {
      throw new Error("SESSION_TASK_CONTROL_UNSUPPORTED");
    });
    const res = await service.stopBackgroundTask(SESSION, TASK);
    expect(res.outcome).toBe("error");
  });

  it("survives a non-Error rejection without losing the outcome", async () => {
    const { service } = svc(async () => {
      throw "just a string";
    });
    await expect(service.stopBackgroundTask(SESSION, TASK)).resolves.toEqual({
      outcome: "error",
      message: "just a string",
    });
  });

  it("reports `gone` rather than throwing when the fleet is not up", async () => {
    const service = new HerdctlService({} as PaddockConfig);
    await expect(service.stopBackgroundTask(SESSION, TASK)).resolves.toEqual({ outcome: "gone" });
  });

  it("does NOT consult liveSessions — the handle is dead in the background phase", async () => {
    // The subtler half of #848. `liveSessions` is emptied in a `finally` when the
    // primary turn's result lands, so keying off it would give a button that
    // silently stops working after the turn ends — worse than no button.
    const { service, spy } = svc(async () => true);
    const live = (service as unknown as { liveSessions: Map<string, RuntimeSession> }).liveSessions;
    expect(live.size).toBe(0); // exactly the background-phase state
    await expect(service.stopBackgroundTask(SESSION, TASK)).resolves.toEqual({
      outcome: "stopping",
    });
    expect(spy).toHaveBeenCalledWith(SESSION, TASK);
  });
});
