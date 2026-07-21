import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { RuntimeSession, SessionWakeEntry } from "@herdctl/core";
import { makeChatHandler } from "../../src/ws.js";
import { RunProvenanceStore, HUMAN_ROOT, SCHEDULED_ROOT } from "../../src/run-provenance.js";
import type { HerdctlService } from "../../src/herdctl.js";
import type { ProjectStore } from "../../src/projects.js";
import type { AttachmentStore } from "../../src/attachments.js";
import type { ArchiveStore } from "../../src/archive.js";
import type { PaddockConfig } from "../../src/config.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/**
 * Regression coverage for issue #353: a session WAKE is a *resume*, never a
 * *creation*, so `onSessionWake` must NOT stamp a creation origin.
 *
 * The bug: a chat created BEFORE provenance stamping existed (empty slot) that
 * later arms a `ScheduleWakeup`/`/loop` would, on its first wake, hit the old
 * `stampIfAbsent(SCHEDULED_ROOT)` and get falsely labelled `scheduled` — a
 * human-rooted chat badged as a cron root. Genuinely schedule-*created* chats are
 * already stamped `scheduled` at CREATION (`fireTriggerForProject` →
 * `startAgentTurn`), so dropping the wake stamp loses nothing for them.
 *
 * We can't cheaply drive a real reaper-fired wake here, but the wake handler is a
 * pure closure over `deps`. We capture it via a fake herdctl (whose `onSessionWake`
 * records the callback), drive it with a fake session, and assert the sidecar's
 * origin. Whatever the message translator does, the whole wake loop runs inside a
 * try/catch, so the provenance invariant is what we assert.
 */
describe("ws onSessionWake — provenance (issue #353)", () => {
  let tmp: string;
  let store: RunProvenanceStore;
  /** The wake callback makeChatHandler registers via herdctl.onSessionWake. */
  let wake: ((s: RuntimeSession, e: SessionWakeEntry) => Promise<void>) | undefined;

  beforeEach(async () => {
    tmp = await makeTmpDir("ws-wake-prov-");
    store = new RunProvenanceStore(tmp);
    wake = undefined;

    // A fake herdctl that only needs the three methods makeChatHandler calls at
    // construction time; everything else lives in per-turn paths we never trigger.
    const fakeHerdctl = {
      onSessionWake: (cb: (s: RuntimeSession, e: SessionWakeEntry) => Promise<void>) => {
        wake = cb;
      },
      onScheduleTrigger: () => undefined,
      setResolveInjectedMcpServers: () => undefined,
    } as unknown as HerdctlService;

    makeChatHandler({
      herdctl: fakeHerdctl,
      projects: {} as unknown as ProjectStore,
      attachments: {} as unknown as AttachmentStore,
      archive: {} as unknown as ArchiveStore,
      cfg: { maxSpawnDepth: 1, keeperDriveMode: "batch" } as unknown as PaddockConfig,
      runProvenance: store,
    });
  });

  afterEach(async () => {
    await rmTmpDir(tmp);
  });

  /** A minimal woken session: yields one message carrying the session id, then ends. */
  function fakeSession(sessionId: string): RuntimeSession {
    return {
      messages: (async function* () {
        yield { type: "system", subtype: "init", session_id: sessionId } as never;
      })(),
    } as unknown as RuntimeSession;
  }

  function entry(sessionId: string): SessionWakeEntry {
    return {
      id: `wake-${sessionId}`,
      agent: "keeper-paddock",
      sessionId,
      schedule: "* * * * *",
      recurring: false,
      prompt: "wake up",
    } as SessionWakeEntry;
  }

  it("does NOT stamp 'scheduled' on a wake of an UNSTAMPED (legacy human) chat", async () => {
    const sid = "legacy-human-chat";
    expect(await store.get(sid)).toBeUndefined();

    await wake!(fakeSession(sid), entry(sid));

    // The core of #353: a pre-provenance human chat woken by its own
    // ScheduleWakeup must stay UNSTAMPED (badge: none) — never `scheduled`.
    expect(await store.get(sid)).toBeUndefined();
  });

  it("does NOT clobber an existing HUMAN stamp when a schedule wakes the chat", async () => {
    const sid = "stamped-human-chat";
    await store.stamp(sid, HUMAN_ROOT);

    await wake!(fakeSession(sid), entry(sid));

    expect(await store.get(sid)).toEqual({ origin: "human", depth: 0 });
  });

  it("leaves a genuinely SCHEDULED chat labelled 'scheduled' after a wake", async () => {
    const sid = "real-scheduled-chat";
    // Genuine schedule-created chats are stamped at creation, not on wake.
    await store.stamp(sid, SCHEDULED_ROOT);

    await wake!(fakeSession(sid), entry(sid));

    expect(await store.get(sid)).toEqual({ origin: "scheduled", depth: 0 });
  });
});
