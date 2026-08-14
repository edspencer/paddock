/**
 * `lastMessageAt` / `withLastActivity` — the chat-list "updated" time (#863).
 *
 * The bug these pin is not that a wrong number was computed; it is that a
 * RIGHT number was computed about the wrong thing. mtime answers "when was this
 * file last written", and Paddock writes transcripts for reasons that are not
 * conversation. So the assertions below are mostly about what must NOT move the
 * timestamp: a touch with no append, and an append of a record nobody said.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lastMessageAt, withLastActivity, activityMs } from "../../src/last-activity.js";
import type { DiscoveredSession } from "@herdctl/core";

let projectDir: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-activity-"));
  fs.mkdirSync(path.join(projectDir, ".chats"), { recursive: true });
});
afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

/** Write a transcript. Each id is unique per test so the mtime cache can't leak. */
let n = 0;
function writeTranscript(records: unknown[], mtime?: Date): string {
  const sessionId = `sess-${++n}-${process.pid}`;
  const file = path.join(projectDir, ".chats", `${sessionId}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return sessionId;
}

const msg = (type: "user" | "assistant", timestamp: string, extra: object = {}) => ({
  type,
  timestamp,
  uuid: `u-${timestamp}`,
  message: { content: "hello" },
  ...extra,
});

const session = (sessionId: string, mtime: string): DiscoveredSession =>
  ({ sessionId, mtime, workingDirectory: "/w", resumable: true }) as DiscoveredSession;

describe("lastMessageAt (#863)", () => {
  it("reads the last message's timestamp, not the file's mtime", async () => {
    // The headline case from the issue: last real message 8 days ago, file
    // touched minutes ago. Nothing about the conversation changed.
    const id = writeTranscript(
      [msg("user", "2026-08-06T09:00:00.000Z"), msg("assistant", "2026-08-06T09:00:12.000Z")],
      new Date("2026-08-14T11:59:00.000Z"),
    );
    expect(await lastMessageAt(projectDir, id)).toBe("2026-08-06T09:00:12.000Z");
  });

  it("does not move when the file is touched with no new content", async () => {
    const id = writeTranscript([msg("user", "2026-08-06T09:00:00.000Z")]);
    const before = await lastMessageAt(projectDir, id);

    // Exactly what a background re-stat / relocation does: mtime forward, bytes
    // identical. This is the whole bug.
    const later = new Date("2026-08-14T12:30:00.000Z");
    fs.utimesSync(path.join(projectDir, ".chats", `${id}.jsonl`), later, later);

    expect(await lastMessageAt(projectDir, id)).toBe(before);
    expect(before).toBe("2026-08-06T09:00:00.000Z");
  });

  it.each([
    ["a summary/title entry", { type: "summary", summary: "Some title", timestamp: "2026-08-14T12:00:00.000Z" }],
    ["a system control line", { type: "system", subtype: "local_command", timestamp: "2026-08-14T12:00:00.000Z" }],
    ["a harness-injected meta line", msg("user", "2026-08-14T12:00:00.000Z", { isMeta: true })],
    ["a background-agent notification", msg("user", "2026-08-14T12:00:00.000Z", { origin: { kind: "task-notification" } })],
  ])("ignores %s appended after the last real message", async (_label, control) => {
    // These arrive WITHOUT anyone taking a turn — a resume, a slash command, a
    // spawned agent finishing. Counting them reintroduces the bug one layer up.
    const id = writeTranscript([msg("assistant", "2026-08-06T09:00:00.000Z"), control]);
    expect(await lastMessageAt(projectDir, id)).toBe("2026-08-06T09:00:00.000Z");
  });

  it("counts a sub-agent's own records — that IS activity in this chat", async () => {
    const id = writeTranscript([
      msg("user", "2026-08-06T09:00:00.000Z"),
      msg("assistant", "2026-08-14T12:00:00.000Z", { isSidechain: true }),
    ]);
    expect(await lastMessageAt(projectDir, id)).toBe("2026-08-14T12:00:00.000Z");
  });

  it("falls back to undefined — never to a guess — when there is nothing datable", async () => {
    expect(await lastMessageAt(projectDir, "no-such-session")).toBeUndefined();
    expect(await lastMessageAt(projectDir, writeTranscript([]))).toBeUndefined();
    // Present but unusable: a control-only transcript, and a bad date.
    expect(
      await lastMessageAt(projectDir, writeTranscript([{ type: "system", timestamp: "2026-08-14T12:00:00.000Z" }])),
    ).toBeUndefined();
    expect(
      await lastMessageAt(projectDir, writeTranscript([msg("user", "not-a-date")])),
    ).toBeUndefined();
  });

  it("refuses a session id that could escape .chats/", async () => {
    expect(await lastMessageAt(projectDir, "../../etc/passwd")).toBeUndefined();
  });

  it("tolerates a corrupt trailing line by walking further back", async () => {
    // A transcript being appended to right now can end mid-write.
    const id = writeTranscript([msg("assistant", "2026-08-06T09:00:00.000Z")]);
    fs.appendFileSync(path.join(projectDir, ".chats", `${id}.jsonl`), '{"type":"assis');
    expect(await lastMessageAt(projectDir, id)).toBe("2026-08-06T09:00:00.000Z");
  });

  /**
   * The reason this reads the tail rather than parsing: a chat's transcript is
   * unbounded, and the answer is always at the end. A single record can also be
   * megabytes (a large tool result), which is what the widening retry is for —
   * without it the first window holds one unterminated line and the whole
   * chat falls back to mtime.
   */
  it("finds the last message past a record larger than the first window", async () => {
    const id = writeTranscript([
      msg("user", "2026-08-06T09:00:00.000Z"),
      { type: "user", timestamp: "2026-08-06T09:00:01.000Z", isMeta: true, blob: "x".repeat(200_000) },
      msg("assistant", "2026-08-06T09:05:00.000Z"),
      { type: "system", subtype: "local_command", blob: "y".repeat(300_000) },
    ]);
    expect(await lastMessageAt(projectDir, id)).toBe("2026-08-06T09:05:00.000Z");
  });
});

describe("withLastActivity (#863)", () => {
  it("orders by last message, not by mtime", async () => {
    // `touched` is the issue's complaint made concrete: an idle chat whose file
    // was bumped by a background task, sitting above chats that really are newer.
    const touched = writeTranscript([msg("user", "2026-08-01T09:00:00.000Z")], new Date("2026-08-14T12:00:00.000Z"));
    const middle = writeTranscript([msg("user", "2026-08-10T09:00:00.000Z")], new Date("2026-08-10T09:00:00.000Z"));
    const newest = writeTranscript([msg("user", "2026-08-13T09:00:00.000Z")], new Date("2026-08-13T09:00:00.000Z"));

    const ordered = await withLastActivity(projectDir, [
      session(touched, "2026-08-14T12:00:00.000Z"),
      session(middle, "2026-08-10T09:00:00.000Z"),
      session(newest, "2026-08-13T09:00:00.000Z"),
    ]);

    expect(ordered.map((s) => s.sessionId)).toEqual([newest, middle, touched]);
    // The control: mtime is NOT rewritten. It is still the cache key for
    // auto-name, preview, sidechain detection and usage, here and inside
    // herdctl — overwriting it would fix the display and break those silently.
    expect(ordered.find((s) => s.sessionId === touched)?.mtime).toBe("2026-08-14T12:00:00.000Z");
  });

  it("sorts a chat with no transcript by its mtime, against ones that have", async () => {
    const real = writeTranscript([msg("user", "2026-08-12T09:00:00.000Z")]);
    const ordered = await withLastActivity(projectDir, [
      session("missing-older", "2026-08-02T09:00:00.000Z"),
      session(real, "2026-08-01T00:00:00.000Z"),
      session("missing-newer", "2026-08-20T09:00:00.000Z"),
    ]);
    expect(ordered.map((s) => s.sessionId)).toEqual(["missing-newer", real, "missing-older"]);
    expect(ordered[1].lastMessageAt).toBe("2026-08-12T09:00:00.000Z");
    expect(ordered[0].lastMessageAt).toBeUndefined();
  });

  it("activityMs prefers the message time and never returns NaN", () => {
    expect(activityMs({ ...session("a", "2026-08-01T00:00:00.000Z"), lastMessageAt: "2026-08-09T00:00:00.000Z" })).toBe(
      Date.parse("2026-08-09T00:00:00.000Z"),
    );
    expect(activityMs(session("b", "2026-08-01T00:00:00.000Z"))).toBe(Date.parse("2026-08-01T00:00:00.000Z"));
    // A sort comparator that sees NaN produces an arbitrary order rather than an
    // error, which is the kind of bug that only shows up in a screenshot.
    expect(activityMs(session("c", "nonsense"))).toBe(0);
  });
});
