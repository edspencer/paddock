/**
 * #882's migration modal.
 *
 * The happy path is the least interesting thing in here. What this dialog has to
 * get right is the set of states a user reaches when something has gone wrong
 * mid-way through a file migration, because that is when they are most likely to
 * do something destructive out of panic. So the assertions cluster around:
 *
 *   - **"nothing was moved"** appearing on every refusal, since it is true of all
 *     of them (all four run before the first rename) and it is the fact that
 *     makes a refusal recoverable rather than frightening;
 *   - **a 200 with `failed[]` never reading as success** — the config was not
 *     written, the instance is still on `own`, and the user's next action is
 *     "run it again", not "restart";
 *   - **`preserved[]` rendered in full, with paths**, because it is the recovery
 *     path and the only evidence for "nothing is deleted";
 *   - **the restart, and the blank chat list that precedes it**;
 *   - and the request body, which fails silently when it is wrong.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MigrationDialog } from "./MigrationDialog";
import type {
  TranscriptsMigrationChat,
  TranscriptsMigrationPlan,
  TranscriptsMigrationProject,
  TranscriptsMigrationResult,
  TranscriptsMigrationState,
} from "../lib/types";

const { transcriptsMigrationChats, runTranscriptsMigration } = vi.hoisted(() => ({
  transcriptsMigrationChats: vi.fn(),
  runTranscriptsMigration: vi.fn(),
}));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: { ...actual.api, transcriptsMigrationChats, runTranscriptsMigration },
  };
});

// Imported AFTER the mock so the real class comes through — the dialog narrows
// on `instanceof ApiError`, so a stubbed one would silently take every refusal
// down the generic branch and the tests below would pass for the wrong reason.
const { ApiError } = await vi.importActual<typeof import("../lib/api")>("../lib/api");

/* -------------------------------------------------------------------------- */

function row(
  sessionId: string,
  state: TranscriptsMigrationState,
  defaultSelected: boolean,
  over: Partial<TranscriptsMigrationChat> = {},
): TranscriptsMigrationChat {
  return {
    sessionId,
    state,
    defaultSelected,
    own: {
      path: `/srv/paddock/alpha/.chats/${sessionId}.jsonl`,
      sizeBytes: 4096,
      mtime: "2026-08-14T10:00:00.000Z",
    },
    extras: [],
    ...over,
  };
}

function project(
  slug: string,
  chats: TranscriptsMigrationChat[],
  over: Partial<TranscriptsMigrationProject> = {},
): TranscriptsMigrationProject {
  return {
    slug,
    name: slug || "Root workspace",
    chatsDir: `/srv/paddock/${slug}/.chats`,
    hostStore: `/home/dev/.claude/projects/-srv-code-${slug}`,
    preserveDir: `/srv/paddock/${slug}/.chats-pre-migration`,
    chats,
    projectExtras: [],
    ...over,
  };
}

function plan(over: Partial<TranscriptsMigrationPlan> = {}): TranscriptsMigrationPlan {
  const projects = over.projects ?? [
    project("alpha", [
      row("s-new", "new", true, { name: "Add the CSV exporter" }),
      row("s-ff", "fast-forward", true, { name: "Fix the flaky test", ahead: "own" }),
      row("s-div", "diverged", false, {
        name: "Rename the config keys",
        own: {
          path: "/srv/paddock/alpha/.chats/s-div.jsonl",
          sizeBytes: 8192,
          mtime: "2026-08-14T10:00:00.000Z",
          messageCount: 42,
          lastMessageAt: "2026-08-14T09:00:00.000Z",
        },
        host: {
          path: "/home/dev/.claude/projects/-srv-code-alpha/s-div.jsonl",
          sizeBytes: 6144,
          mtime: "2026-08-13T10:00:00.000Z",
          messageCount: 17,
          lastMessageAt: "2026-08-13T09:00:00.000Z",
        },
      }),
    ]),
  ];
  const chats = projects.flatMap((p) => p.chats);
  return {
    mode: "own",
    configPath: "/srv/paddock/paddock.config.yaml",
    configVersion: "cfg-v1",
    projects,
    sweepers: { stores: 0, chats: 0 },
    totals: {
      chats: chats.length,
      new: chats.filter((c) => c.state === "new").length,
      fastForward: chats.filter((c) => c.state === "fast-forward").length,
      diverged: chats.filter((c) => c.state === "diverged").length,
      unknown: chats.filter((c) => c.state === "unknown").length,
      identical: 0,
      defaultSelected: chats.filter((c) => c.defaultSelected).length,
    },
    scanBudgetExhausted: false,
    warnings: [],
    ...over,
  };
}

function result(over: Partial<TranscriptsMigrationResult> = {}): TranscriptsMigrationResult {
  return {
    ok: true,
    alreadyMigrated: false,
    dryRun: false,
    projects: [
      { slug: "alpha", outcome: "migrated", migrated: 2, preserved: 1, chatsDirEmpty: true },
    ],
    migrated: ["s-new", "s-ff"],
    preserved: [],
    unplanned: [],
    ignoredSessionIds: [],
    failed: [],
    sweepers: { stores: 0, chats: 0 },
    warnings: [],
    configWritten: true,
    configPath: "/srv/paddock/paddock.config.yaml",
    configVersion: "cfg-v2",
    restartRequired: true,
    ...over,
  };
}

function open(onCompleted = vi.fn()) {
  return {
    onCompleted,
    ...render(<MigrationDialog open onClose={vi.fn()} onCompleted={onCompleted} />),
  };
}

/** Wait for the plan to have rendered its table. */
async function waitForTable() {
  await screen.findByRole("checkbox", { name: /Add the CSV exporter/ });
}

beforeEach(() => {
  transcriptsMigrationChats.mockReset();
  runTranscriptsMigration.mockReset();
  transcriptsMigrationChats.mockResolvedValue(plan());
  runTranscriptsMigration.mockResolvedValue(result());
});

/* -------------------------------------------------------------------------- */
/* the table                                                                   */
/* -------------------------------------------------------------------------- */

describe("the table", () => {
  it("starts new and fast-forward ticked and diverged unticked", async () => {
    open();
    await waitForTable();
    expect(screen.getByRole("checkbox", { name: /Add the CSV exporter/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Fix the flaky test/ })).toBeChecked();
    // The whole point: a diverged row is a real choice and must be made
    // deliberately, so it is never pre-made for the user.
    expect(screen.getByRole("checkbox", { name: /Rename the config keys/ })).not.toBeChecked();
  });

  it("shows both sides of a diverged row so the choice is informed", async () => {
    open();
    await waitForTable();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Paddock's copy")).toBeInTheDocument();
    expect(within(dialog).getByText("Your ~/.claude copy")).toBeInTheDocument();
    expect(within(dialog).getByText(/42 messages/)).toBeInTheDocument();
    expect(within(dialog).getByText(/17 messages/)).toBeInTheDocument();
  });

  it("names the destination store per project", async () => {
    // Two projects' rows look identical and go to different stores, and for a
    // repo-backed project the destination is keyed on the CHECKOUT.
    open();
    await waitForTable();
    expect(
      screen.getByText("→ /home/dev/.claude/projects/-srv-code-alpha"),
    ).toBeInTheDocument();
  });

  it("never suggests an unticked chat is deleted", async () => {
    open();
    await waitForTable();
    const text = screen.getByRole("dialog").textContent ?? "";

    // Ed settled this: an unticked chat is MOVED to `.chats-pre-migration/` and
    // stays on disk, so no wording here may imply otherwise.
    expect(text).not.toMatch(/discard|destroy|erase|permanently|wipe|lost/i);

    // "delete" is allowed in exactly one shape — negated. Asserting the absence
    // of the word outright would have failed on the reassurance itself, which is
    // the sentence that matters most; so check every occurrence is a denial.
    const occurrences = [...text.matchAll(/(.{0,6})delet\w*/gi)];
    expect(occurrences.length).toBeGreaterThan(0);
    for (const [, before] of occurrences) expect(before).toMatch(/not\s*$/i);
  });

  it("groups rows under their project and offers a per-project tick", async () => {
    const user = userEvent.setup();
    open();
    await waitForTable();
    const groupBox = screen.getByRole("checkbox", { name: /2 of 3/ });
    await user.click(groupBox);
    expect(screen.getByRole("checkbox", { name: /Rename the config keys/ })).toBeChecked();
  });
});

/* -------------------------------------------------------------------------- */
/* the request                                                                 */
/* -------------------------------------------------------------------------- */

describe("submitting", () => {
  it("sends plannedSessionIds and expectedVersion", async () => {
    const user = userEvent.setup();
    open();
    await waitForTable();
    await user.click(screen.getByRole("button", { name: /Merge 2 chats/ }));

    await waitFor(() => expect(runTranscriptsMigration).toHaveBeenCalled());
    expect(runTranscriptsMigration.mock.calls[0][0]).toEqual({
      sessionIds: ["s-new", "s-ff"],
      // Omit this and `unplanned[]` is silently always empty.
      plannedSessionIds: ["s-new", "s-ff", "s-div"],
      // Omit this and a config change underneath the user is a silent clobber.
      expectedVersion: "cfg-v1",
    });
  });

  it("allows submitting with nothing ticked", async () => {
    // "Migrate nothing, preserve everything, flip the lever" is a real choice
    // the API documents and deliberately does not reject. Disabling the button
    // would remove an option the server supports.
    const user = userEvent.setup();
    open();
    await waitForTable();
    await user.click(screen.getByRole("checkbox", { name: /Select all/ })); // → all on
    await user.click(screen.getByRole("checkbox", { name: /Select all/ })); // → all off

    const submit = screen.getByRole("button", { name: /Merge nothing, keep everything/ });
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => expect(runTranscriptsMigration).toHaveBeenCalled());
    expect(runTranscriptsMigration.mock.calls[0][0].sessionIds).toEqual([]);
    expect(runTranscriptsMigration.mock.calls[0][0].plannedSessionIds).toHaveLength(3);
  });
});

/* -------------------------------------------------------------------------- */
/* refusals — all four mean NOTHING MOVED                                      */
/* -------------------------------------------------------------------------- */

describe("refusals", () => {
  async function refuseWith(error: unknown) {
    runTranscriptsMigration.mockRejectedValue(error);
    const user = userEvent.setup();
    open();
    await waitForTable();
    await user.click(screen.getByRole("button", { name: /Merge 2 chats/ }));
    await screen.findByText(/Nothing was moved/i);
    return user;
  }

  it("409 turn_running names the chats that would not stop, and offers a retry", async () => {
    await refuseWith(
      new ApiError("A chat is running.", 409, "turn_running", {
        error: "A chat is running.",
        code: "turn_running",
        sessionIds: ["s-div"],
      }),
    );
    expect(screen.getByText(/still mid-turn/i)).toBeInTheDocument();
    // The body carries the ids precisely so the user can act. `req()` used to
    // discard everything but `error`, which left this refusal unactionable.
    expect(screen.getByText("s-div")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
  });

  it("409 config_conflict offers a reload rather than a retry", async () => {
    const user = await refuseWith(
      new ApiError("Config changed.", 409, "config_conflict", { code: "config_conflict" }),
    );
    expect(screen.getByText(/changed underneath this plan/i)).toBeInTheDocument();
    // Retrying with the same stale expectedVersion could only 409 again.
    expect(screen.queryByRole("button", { name: /Try again/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Reload the plan/ }));
    await waitFor(() => expect(transcriptsMigrationChats).toHaveBeenCalledTimes(2));
  });

  it("409 migration_in_progress explains the second tab", async () => {
    await refuseWith(
      new ApiError("Already running.", 409, "migration_in_progress", {
        code: "migration_in_progress",
      }),
    );
    // The headline and the explanation both say it; either is fine.
    expect(screen.getAllByText(/already running/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Another tab or window/i)).toBeInTheDocument();
  });

  it("400 env_shadowed offers no retry, because a retry cannot fix it", async () => {
    await refuseWith(
      new ApiError("PADDOCK_CLAUDE_TRANSCRIPTS is set.", 400, "env_shadowed", {
        code: "env_shadowed",
      }),
    );
    // Named both in the server's own message and in the explanation of what to
    // do about it.
    expect(screen.getAllByText(/PADDOCK_CLAUDE_TRANSCRIPTS/).length).toBeGreaterThan(0);
    // A retry can only produce the same error: the env var has to be unset and
    // the server restarted.
    expect(screen.queryByRole("button", { name: /Try again/ })).not.toBeInTheDocument();
  });

  it("keeps the selection so a retry is one click", async () => {
    await refuseWith(new ApiError("Nope.", 409, "turn_running", { code: "turn_running" }));
    expect(screen.getByText(/2 of 3 ticked/)).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* the completion screen                                                       */
/* -------------------------------------------------------------------------- */

describe("the completion screen", () => {
  it("tells the user to restart, and that the chat list will look empty first", async () => {
    // The single most important paragraph in the dialog. Config is frozen at
    // boot, so until the restart the running process resolves `own` against a
    // `.chats/` this just emptied — the list is BLANK. A user who is not told
    // concludes the migration ate their history.
    const user = userEvent.setup();
    const { onCompleted } = open();
    await waitForTable();
    await user.click(screen.getByRole("button", { name: /Merge 2 chats/ }));

    await screen.findByText(/Restart the Paddock server now/i);
    expect(screen.getByText(/your chat list will look empty/i)).toBeInTheDocument();
    expect(onCompleted).toHaveBeenCalled();
  });

  it("tells a stranded-host recovery the truth about its config and its list (#902)", async () => {
    // The instance was already on `host`; its non-empty `.chats/` made the
    // redirect symlink be declined, so its chats were invisible (#708). The run
    // moves everything and correctly writes no config. BOTH sentences of the
    // `own → host` copy are false here: there was no setting to write, and the
    // list does not go blank — it has been missing chats all along and the
    // restart is what returns them.
    const user = userEvent.setup();
    const { onCompleted } = open();
    runTranscriptsMigration.mockResolvedValue(
      result({ ok: true, configWritten: false, configVersion: undefined }),
    );
    await waitForTable();
    await user.click(screen.getByRole("button", { name: /Merge 2 chats/ }));

    await screen.findByText(/Restart the Paddock server now/i);
    expect(screen.getByText(/nothing about it was changed/i)).toBeInTheDocument();
    expect(screen.getByText(/will reappear/i)).toBeInTheDocument();
    // The two claims that would be false.
    expect(screen.queryByText(/The setting is written/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/your chat list will look empty/i)).not.toBeInTheDocument();
    // And it is a success, not a failure.
    expect(screen.queryByText(/did not finish/i)).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveAccessibleName(/done/i);
    expect(onCompleted).toHaveBeenCalled();
  });

  it("renders preserved[] in full, with absolute paths", async () => {
    runTranscriptsMigration.mockResolvedValue(
      result({
        preserved: [
          {
            sessionId: "s-div",
            slug: "alpha",
            side: "own",
            path: "/srv/paddock/alpha/.chats-pre-migration/s-div.jsonl",
            reason: "unchecked",
          },
          {
            sessionId: "memory/MEMORY.md",
            slug: "alpha",
            side: "own",
            path: "/srv/paddock/alpha/.chats-pre-migration/memory/MEMORY.md",
            reason: "identical",
          },
        ],
      }),
    );
    const user = userEvent.setup();
    open();
    await waitForTable();
    await user.click(screen.getByRole("button", { name: /Merge 2 chats/ }));

    const list = await screen.findByTestId("migration-preserved");
    // Every entry, not a count and not a disclosure the user has to open: this
    // array is the recovery path and the evidence for "nothing is deleted".
    expect(list).toHaveTextContent("/srv/paddock/alpha/.chats-pre-migration/s-div.jsonl");
    expect(list).toHaveTextContent("/srv/paddock/alpha/.chats-pre-migration/memory/MEMORY.md");
    expect(list).toHaveTextContent(/Kept, not deleted/i);
  });

  it("a 200 with failed[] does NOT say done, and says the config was not written", async () => {
    const user = userEvent.setup();
    const { onCompleted } = open();
    runTranscriptsMigration.mockResolvedValue(
      result({
        ok: false,
        configWritten: false,
        migrated: ["s-new"],
        failed: [
          { sessionId: "s-ff", slug: "alpha", reason: "move-failed", message: "EACCES" },
        ],
        projects: [
          { slug: "alpha", outcome: "failed", migrated: 1, preserved: 0, chatsDirEmpty: false },
        ],
      }),
    );
    await waitForTable();
    await user.click(screen.getByRole("button", { name: /Merge 2 chats/ }));

    await screen.findByText(/did not finish/i);
    expect(screen.getByText(/running this again is safe/i)).toBeInTheDocument();
    // The failure reason vocabulary is open, so it is rendered verbatim.
    expect(screen.getByText(/move-failed — EACCES/)).toBeInTheDocument();
    // Still pending, so the offer must keep advertising it.
    expect(onCompleted).not.toHaveBeenCalled();

    // The HEADING must not contradict the body. Driving a real partial failure
    // showed "— done" sitting directly above "The migration did not finish."
    expect(screen.getByRole("dialog")).toHaveAccessibleName(/unfinished/i);
    expect(screen.getByRole("dialog")).not.toHaveAccessibleName(/done/i);
  });

  it("tells a partial migration to re-run, not to restart first", async () => {
    // On a partial the config was NOT written, so a restart comes back on `own`
    // and still cannot see the chats that moved. Leading with "Restart now"
    // would spend the user's one action on the thing that does not help.
    const user = userEvent.setup();
    open();
    runTranscriptsMigration.mockResolvedValue(
      result({
        ok: false,
        configWritten: false,
        failed: [{ sessionId: "s-ff", slug: "alpha", reason: "move-failed" }],
      }),
    );
    await waitForTable();
    await user.click(screen.getByRole("button", { name: /Merge 2 chats/ }));

    await screen.findByText(/Run the migration again, then restart/i);
    expect(screen.queryByText(/^Restart the Paddock server now\.$/)).not.toBeInTheDocument();
    expect(screen.getByText(/your chat list will look incomplete/i)).toBeInTheDocument();
  });

  it("labels a whole-store failure by its path, not the server's '-' sentinel", async () => {
    // The server uses a literal "-" for a failure that is not about one chat
    // (a store that would not drain, or the config write). Printed raw it is a
    // bare dash where a chat name should be, which reads as a corrupted row.
    const user = userEvent.setup();
    open();
    runTranscriptsMigration.mockResolvedValue(
      result({
        ok: false,
        configWritten: false,
        failed: [
          {
            sessionId: "-",
            slug: "alpha",
            reason: "move-failed",
            message: "EEXIST",
            path: "/srv/paddock/alpha/.chats",
          },
        ],
      }),
    );
    await waitForTable();
    await user.click(screen.getByRole("button", { name: /Merge 2 chats/ }));

    await screen.findByText("/srv/paddock/alpha/.chats");
    expect(screen.queryByText("-")).not.toBeInTheDocument();
  });

  it("surfaces unplanned chats that appeared while the dialog was open", async () => {
    const user = userEvent.setup();
    open();
    runTranscriptsMigration.mockResolvedValue(
      result({
        unplanned: [
          { sessionId: "s-late", slug: "alpha", state: "diverged", action: "preserved" },
        ],
      }),
    );
    await waitForTable();
    await user.click(screen.getByRole("button", { name: /Merge 2 chats/ }));

    await screen.findByText(/appeared after you opened this/i);
    expect(screen.getByText("s-late")).toBeInTheDocument();
  });

  it("reports a project skipped because a turn restarted", async () => {
    const user = userEvent.setup();
    open();
    runTranscriptsMigration.mockResolvedValue(
      result({
        ok: false,
        configWritten: false,
        projects: [
          { slug: "alpha", outcome: "skipped-busy", migrated: 0, preserved: 0, chatsDirEmpty: false },
        ],
      }),
    );
    await waitForTable();
    await user.click(screen.getByRole("button", { name: /Merge 2 chats/ }));

    await screen.findByText(/left untouched/i);
  });
});

/* -------------------------------------------------------------------------- */
/* the edges                                                                   */
/* -------------------------------------------------------------------------- */

describe("edge states", () => {
  it("explains an exhausted scan budget rather than showing a silent gap", async () => {
    transcriptsMigrationChats.mockResolvedValue(
      plan({
        projects: [project("alpha", [row("s-unknown", "unknown", false, { name: "Unscanned" })])],
        scanBudgetExhausted: true,
        totals: {
          chats: 1,
          new: 0,
          fastForward: 0,
          diverged: 0,
          unknown: 1,
          identical: 0,
          defaultSelected: 0,
        },
      }),
    );
    open();
    await screen.findByText(/1 chat was not compared/i);
    expect(screen.getByRole("checkbox", { name: /Unscanned/ })).not.toBeChecked();
  });

  it("surfaces a warning about a store it could not read", async () => {
    transcriptsMigrationChats.mockResolvedValue(
      plan({
        warnings: [
          {
            code: "host-store-unreadable",
            slug: "beta",
            message: "Could not read /home/dev/.claude/projects/-srv-code-beta.",
            paths: ["/home/dev/.claude/projects/-srv-code-beta"],
          },
        ],
      }),
    );
    open();
    await screen.findByText(/Could not read/);
  });

  it("renders a warning code it has never heard of, using the server's prose", async () => {
    transcriptsMigrationChats.mockResolvedValue(
      plan({ warnings: [{ code: "brand-new-code", message: "Something novel happened." }] }),
    );
    open();
    await screen.findByText("Something novel happened.");
  });

  it("says there is nothing to move when the plan is empty", async () => {
    transcriptsMigrationChats.mockResolvedValue(
      plan({
        projects: [],
        totals: {
          chats: 0,
          new: 0,
          fastForward: 0,
          diverged: 0,
          unknown: 0,
          identical: 0,
          defaultSelected: 0,
        },
      }),
    );
    open();
    await screen.findByText(/Nothing to move/i);
    expect(screen.queryByRole("button", { name: /^Merge/ })).not.toBeInTheDocument();
  });

  it("keeps a project that has no rows but does have files to move", async () => {
    // `eligible: true` with `pendingChats: 0` — a `.chats/` holding only agent
    // memory. Rendering "nothing to migrate" would dead-end the very user whose
    // instance most needs the flip.
    transcriptsMigrationChats.mockResolvedValue(
      plan({
        projects: [project("alpha", [], { projectExtras: ["memory/", "agent-ab12.jsonl"] })],
        totals: {
          chats: 0,
          new: 0,
          fastForward: 0,
          diverged: 0,
          unknown: 0,
          identical: 0,
          defaultSelected: 0,
        },
      }),
    );
    open();
    await screen.findByText(/2 project files move with it anyway/i);
    expect(screen.getByRole("button", { name: /Merge nothing, keep everything/ })).toBeEnabled();
  });

  it("discloses what moves with no row attached", async () => {
    transcriptsMigrationChats.mockResolvedValue(
      plan({ sweepers: { stores: 2, chats: 9 }, totals: { ...plan().totals, identical: 5 } }),
    );
    open();
    await waitForTable();
    expect(screen.getByText(/Also moving, with no row above/i)).toBeInTheDocument();
    expect(screen.getByText(/5 chats that are already identical/i)).toBeInTheDocument();
  });

  it("reports a failed plan fetch without claiming anything happened", async () => {
    transcriptsMigrationChats.mockRejectedValue(new Error("boom"));
    open();
    await screen.findByText(/Could not read the migration plan/i);
    expect(screen.getByText(/Nothing has been moved/i)).toBeInTheDocument();
  });
});
