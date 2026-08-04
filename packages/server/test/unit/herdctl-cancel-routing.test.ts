/**
 * HerdctlService.cancel — which primitive Stop actually reaches (#528).
 *
 * One opaque id arrives from the client as `jobId`, and it can mean three
 * different things. Getting the routing wrong is invisible from the outside:
 * Stop just does nothing.
 *
 *   1. A live session-mode turn (in `liveSessions`) → `session.interrupt()`.
 *   2. A BACKGROUND-phase turn (in `backgroundTurns`) → force-reap the session.
 *      The primary turn is over, so its `liveSessions` entry is already gone and
 *      there is no model turn to interrupt — the session is being held open by
 *      the reaper for background work. Before #528 this id was registered
 *      nowhere, so cancel fell through to `cancelJob(<synthetic uuid>)`, threw
 *      JobNotFoundError, and returned false. Stop was a guaranteed no-op for the
 *      whole background stretch.
 *   3. A batch-mode herdctl job id → `cancelJob`.
 */
import { describe, it, expect, vi } from "vitest";
import { HerdctlService } from "../../src/herdctl.js";
import type { PaddockConfig } from "../../src/config.js";
import type { RuntimeSession } from "@herdctl/core";

function svc() {
  const reapChatSession = vi.fn(() => true);
  const cancelJob = vi.fn(async () => undefined);
  const service = new HerdctlService({} as PaddockConfig);
  (service as unknown as { fleet: unknown }).fleet = { reapChatSession, cancelJob };
  return { service, reapChatSession, cancelJob };
}

function fakeLiveSession() {
  const interrupt = vi.fn(async () => undefined);
  return { session: { interrupt } as unknown as RuntimeSession, interrupt };
}

/** Register a live primary turn the way chatSession does. */
function registerLive(service: HerdctlService, jobId: string, session: RuntimeSession) {
  (service as unknown as { liveSessions: Map<string, RuntimeSession> }).liveSessions.set(
    jobId,
    session,
  );
}

describe("HerdctlService.cancel routing (#528)", () => {
  it("interrupts a live session-mode turn, and does NOT reap it", async () => {
    const { service, reapChatSession } = svc();
    const { session, interrupt } = fakeLiveSession();
    registerLive(service, "turn-1", session);

    expect(await service.cancel("turn-1")).toBe(true);
    expect(interrupt).toHaveBeenCalledTimes(1);
    // Interrupt is right here: there IS a model turn in flight, and the session
    // must survive so the user can send a follow-up.
    expect(reapChatSession).not.toHaveBeenCalled();
  });

  it("force-reaps the session for a background-phase turn, and does NOT interrupt", async () => {
    const { service, reapChatSession, cancelJob } = svc();
    service.registerBackgroundTurn("bg-1", "sess-abc");

    expect(await service.cancel("bg-1")).toBe(true);
    expect(reapChatSession).toHaveBeenCalledWith("sess-abc");
    // The pre-#528 fallthrough — the one that made Stop a silent no-op.
    expect(cancelJob).not.toHaveBeenCalled();
  });

  it("reports failure when the session is already gone, rather than claiming success", async () => {
    const { service, reapChatSession } = svc();
    reapChatSession.mockReturnValue(false);
    service.registerBackgroundTurn("bg-1", "sess-abc");

    expect(await service.cancel("bg-1")).toBe(false);
  });

  it("stops routing to a reap once the background stream has ended", async () => {
    const { service, reapChatSession, cancelJob } = svc();
    service.registerBackgroundTurn("bg-1", "sess-abc");
    service.unregisterBackgroundTurn("bg-1");

    await service.cancel("bg-1");
    // Reaping here would kill whatever session has since taken this id.
    expect(reapChatSession).not.toHaveBeenCalled();
    expect(cancelJob).toHaveBeenCalledWith("bg-1");
  });

  it("re-registering a background turn moves it to the newly resolved session", async () => {
    const { service, reapChatSession } = svc();
    service.registerBackgroundTurn("bg-1", "sess-old");
    service.registerBackgroundTurn("bg-1", "sess-new");

    await service.cancel("bg-1");
    expect(reapChatSession).toHaveBeenCalledTimes(1);
    expect(reapChatSession).toHaveBeenCalledWith("sess-new");
  });

  it("falls through to cancelJob for a batch-mode job id", async () => {
    const { service, reapChatSession, cancelJob } = svc();

    expect(await service.cancel("job-2026-08-04-abc123")).toBe(true);
    expect(cancelJob).toHaveBeenCalledWith("job-2026-08-04-abc123");
    expect(reapChatSession).not.toHaveBeenCalled();
  });

  it("prefers the live turn when an id is somehow in both registries", async () => {
    const { service, reapChatSession } = svc();
    const { session, interrupt } = fakeLiveSession();
    registerLive(service, "turn-1", session);
    service.registerBackgroundTurn("turn-1", "sess-abc");

    expect(await service.cancel("turn-1")).toBe(true);
    // A live model turn outranks a reap: reaping would kill the turn outright
    // instead of returning control to the user.
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(reapChatSession).not.toHaveBeenCalled();
  });
});
