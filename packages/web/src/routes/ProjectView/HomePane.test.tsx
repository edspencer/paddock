import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { HomePane } from "./HomePane";
import { makeProject, makeChat } from "../../test/factories";
import type { AttentionChat, Project } from "../../lib/types";

/**
 * The Home tab after #599: "what needs me?" before "what is this?".
 *
 * The two things worth pinning here are the ORDER of the sections (the whole
 * point of the rework) and the project-label rule on a chat row — which is a
 * `!==` against the workspace key, because the root's key is `""` and a
 * truthiness test would label every one of the root's own chats as foreign.
 */

/** One row of the attention feed: a chat plus the workspace it lives in. */
function row(over: Partial<AttentionChat> = {}): AttentionChat {
  return {
    ...makeChat({ sessionId: "s1", name: "A chat" }),
    projectSlug: "p",
    projectName: "Test Project",
    ...over,
  };
}

const onOpenChat = vi.fn();
const onNewChat = vi.fn();
const onOpenFile = vi.fn();
const onOpenFiles = vi.fn();

type HomeProps = Parameters<typeof HomePane>[0];

/**
 * Render Home for an ordinary project, with everything quiet. Every test
 * overrides only the prop it is about — `files` defaults to empty and
 * `onOpenFile` is supplied, so the Files section is present unless a test
 * deliberately drops the handler.
 */
function renderHome(over: Partial<HomeProps> = {}, project: Project = makeProject({ slug: "p" })) {
  return render(
    <HomePane
      project={project}
      running={[]}
      unread={[]}
      attentionLoading={false}
      attentionError={null}
      changelog=""
      overview=""
      files={[]}
      onOpenChat={onOpenChat}
      onNewChat={onNewChat}
      onOpenFile={onOpenFile}
      onOpenFiles={onOpenFiles}
      {...over}
    />,
  );
}

const sectionHeadings = () =>
  screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent ?? "");

beforeEach(() => {
  onOpenChat.mockReset();
  onNewChat.mockReset();
  onOpenFile.mockReset();
  onOpenFiles.mockReset();
  localStorage.clear();
});

describe("HomePane: section order (#599)", () => {
  it("opens on Running → Unread → Files → OVERVIEW.md → CHANGELOG.md", () => {
    renderHome({
      running: [row({ sessionId: "r1" })],
      unread: [row({ sessionId: "u1" })],
      files: ["a.md"],
      overview: "# O",
      changelog: "# C",
    });
    expect(sectionHeadings()).toEqual([
      "Running1",
      "Unread1",
      "Files1",
      "OVERVIEW.md",
      "CHANGELOG.md",
    ]);
  });

  it("drops the Files section entirely when there is no Files tab to jump to", () => {
    // Omitting the handler hides the affordance it drives rather than pointing
    // it at a dead URL.
    renderHome({ onOpenFile: undefined, onOpenFiles: undefined });
    expect(sectionHeadings()).toEqual(["Running", "Unread", "OVERVIEW.md", "CHANGELOG.md"]);
  });

  it("shows the project directory as the footer line", () => {
    renderHome({}, makeProject({ slug: "p", dir: "/data/projects/p" }));
    expect(screen.getByText("/data/projects/p")).toBeInTheDocument();
  });

  it("has no Overview summary card and no Edit details action", () => {
    // Both were the bottom of the old Home. The summary is the workspace
    // header's job, and editing details is the overflow menu's — restating them
    // here made the page end on metadata instead of work.
    renderHome({}, makeProject({ slug: "p", summary: "the blurb" }));
    expect(screen.queryByText("the blurb")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit details/i })).not.toBeInTheDocument();
    expect(sectionHeadings().some((h) => /^Overview$/.test(h))).toBe(false);
  });

  it("has no projects grid — that section moved off Home entirely", () => {
    renderHome();
    expect(sectionHeadings().some((h) => /^Projects/.test(h))).toBe(false);
    expect(screen.queryByRole("button", { name: /New Project/i })).not.toBeInTheDocument();
  });
});

describe("HomePane: the Running and Unread feeds", () => {
  it("renders each feed's chats in its own container", () => {
    renderHome({
      running: [row({ sessionId: "r1", name: "Streaming now" })],
      unread: [row({ sessionId: "u1", name: "Reply waiting" })],
    });
    expect(
      within(screen.getByTestId("home-running-chats")).getByText("Streaming now"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("home-unread-chats")).getByText("Reply waiting"),
    ).toBeInTheDocument();
  });

  it("offers New chat from the Running header", () => {
    renderHome();
    fireEvent.click(screen.getByRole("button", { name: /New chat/i }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it("hands onOpenChat BOTH the session id and the owning project", () => {
    // The feeds are subtree-wide, so a row can belong to another workspace —
    // the session id alone doesn't say where to navigate.
    renderHome({
      running: [row({ sessionId: "s9", name: "Ad stripping", projectSlug: "hushpod" })],
    });
    fireEvent.click(screen.getByText("Ad stripping"));
    expect(onOpenChat).toHaveBeenCalledWith("s9", "hushpod");
  });

  it("shows its empty states when nothing wants attention", () => {
    renderHome();
    expect(screen.getByText("Nothing running right now.")).toBeInTheDocument();
    expect(screen.getByText("No unread replies. All caught up.")).toBeInTheDocument();
    expect(screen.queryByTestId("home-running-chats")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-unread-chats")).not.toBeInTheDocument();
  });

  it("shows a skeleton, not an empty state, on the first load", () => {
    // "All caught up" while the answer is still in flight is a lie the user acts
    // on — they close the tab.
    const { container } = renderHome({ attentionLoading: true });
    expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(2);
    expect(screen.queryByText("Nothing running right now.")).not.toBeInTheDocument();
  });

  it("keeps the rows on screen while a refetch is in flight", () => {
    // A refetch fires on every turn boundary anywhere in the fleet; flashing
    // skeletons each time would make a busy instance's Home unreadable.
    renderHome({ attentionLoading: true, running: [row({ name: "Still here" })] });
    expect(screen.getByText("Still here")).toBeInTheDocument();
  });

  it("replaces the feeds with the error, and does not claim all is caught up", () => {
    renderHome({ attentionError: "attention feed exploded" });
    expect(screen.getByText("attention feed exploded")).toBeInTheDocument();
    expect(screen.queryByText("Nothing running right now.")).not.toBeInTheDocument();
    expect(screen.queryByText("No unread replies. All caught up.")).not.toBeInTheDocument();
  });
});

/**
 * The project label on a row is keyed ONLY off the workspace whose Home this is.
 * On the root's Home that labels every project's chat and leaves the root's own
 * bare; on a project's Home nothing is labelled. No `root` flag anywhere.
 */
describe("HomePane: the project-name pill", () => {
  it("labels a row from ANOTHER workspace", () => {
    renderHome({
      running: [row({ name: "Ad stripping", projectSlug: "hushpod", projectName: "Hushpod" })],
    });
    expect(within(screen.getByTestId("home-running-chats")).getByText("Hushpod")).toBeInTheDocument();
  });

  it("leaves a row from THIS workspace unlabelled", () => {
    renderHome({
      running: [row({ name: "Local chat", projectSlug: "p", projectName: "Test Project" })],
    });
    const feed = screen.getByTestId("home-running-chats");
    expect(within(feed).getByText("Local chat")).toBeInTheDocument();
    expect(within(feed).queryByText("Test Project")).not.toBeInTheDocument();
  });

  it("leaves the ROOT's own rows unlabelled — the empty key is not 'foreign'", () => {
    // THE REGRESSION this suite exists for: the root workspace's slug is `""`,
    // so any truthiness test (`row.projectSlug || …`, `if (!slug)`) tags every
    // chat the root itself owns with a pill naming the root.
    renderHome(
      { running: [row({ name: "Root chat", projectSlug: "", projectName: "Instance Root" })] },
      makeProject({ slug: "", name: "Instance Root" }),
    );
    const feed = screen.getByTestId("home-running-chats");
    expect(within(feed).getByText("Root chat")).toBeInTheDocument();
    expect(within(feed).queryByText("Instance Root")).not.toBeInTheDocument();
  });

  it("still labels a PROJECT's row on the root's Home", () => {
    // The other half of the same comparison: from `""`, a real slug IS foreign.
    renderHome(
      { running: [row({ name: "Ad stripping", projectSlug: "hushpod", projectName: "Hushpod" })] },
      makeProject({ slug: "", name: "Instance Root" }),
    );
    expect(within(screen.getByTestId("home-running-chats")).getByText("Hushpod")).toBeInTheDocument();
  });
});

describe("HomePane: the collapsible notes cards", () => {
  const toggle = (title: string) => screen.getByRole("button", { name: title });

  it("renders both files expanded by default", () => {
    renderHome({ overview: "the overview body", changelog: "the changelog body" });
    expect(toggle("OVERVIEW.md")).toHaveAttribute("aria-expanded", "true");
    expect(toggle("CHANGELOG.md")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("the overview body")).toBeInTheDocument();
    expect(screen.getByText("the changelog body")).toBeInTheDocument();
  });

  it("collapses and re-expands on click", () => {
    renderHome({ overview: "the overview body" });
    fireEvent.click(toggle("OVERVIEW.md"));
    expect(toggle("OVERVIEW.md")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("the overview body")).not.toBeInTheDocument();
    fireEvent.click(toggle("OVERVIEW.md"));
    expect(screen.getByText("the overview body")).toBeInTheDocument();
  });

  it("folds one file without folding its sibling", () => {
    renderHome({ overview: "the overview body", changelog: "the changelog body" });
    fireEvent.click(toggle("CHANGELOG.md"));
    expect(screen.getByText("the overview body")).toBeInTheDocument();
    expect(screen.queryByText("the changelog body")).not.toBeInTheDocument();
  });

  it("persists the choice per workspace + file, and restores it on remount", () => {
    const { unmount } = renderHome({ overview: "the overview body" });
    fireEvent.click(toggle("OVERVIEW.md"));
    expect(localStorage.getItem("paddock:home-collapsed:p:overview")).toBe("1");
    // Nothing else was written: folding this project's overview must not fold
    // the changelog, nor another workspace's copy.
    expect(localStorage.getItem("paddock:home-collapsed:p:changelog")).toBeNull();

    unmount();
    renderHome({ overview: "the overview body" });
    expect(toggle("OVERVIEW.md")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("the overview body")).not.toBeInTheDocument();
  });

  it("keeps each workspace's fold separate", () => {
    // The section is keyed by workspace, so switching projects REMOUNTS it —
    // without that it would carry the previous workspace's fold across.
    localStorage.setItem("paddock:home-collapsed:p:overview", "1");
    renderHome({ overview: "the overview body" }, makeProject({ slug: "other" }));
    expect(toggle("OVERVIEW.md")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("the overview body")).toBeInTheDocument();
  });

  // An empty state is an invitation, not a report of absence (docs/DESIGN.md):
  // each of these says what WILL fill the slot and who fills it, so the copy is
  // asserted on the explanation rather than on a "No X yet." string.
  it("shows a per-file empty state when the workspace has no notes yet", () => {
    renderHome();
    expect(screen.getByText(/The sweeper writes OVERVIEW\.md for you/)).toBeInTheDocument();
    expect(screen.getByText(/A running record of what changed/)).toBeInTheDocument();
  });
});
