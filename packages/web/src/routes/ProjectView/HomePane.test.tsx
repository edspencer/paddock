import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { HomePane } from "./HomePane";
import { makeProject, makeChat } from "../../test/factories";
import { chatClient } from "../../lib/ws";
import type { AttentionChat, Project } from "../../lib/types";

// #865: the ROOT's Home carries two onboarding cards and renders Discovery
// inline when the instance is empty. A PROJECT's Home touches none of it —
// which the last test in this file asserts.
//
// `getInstanceConfig` / `updateInstanceConfig` are still stubbed although
// nothing calls them any more: that is the assertion. Home read instance config
// solely for the slideshow's dismissal, and both the slideshow and the config
// key are gone, so a call here would be a leftover rather than a feature.
const getInstanceConfig = vi.fn();
const updateInstanceConfig = vi.fn();
const discover = vi.fn();
vi.mock("../../lib/api", () => ({
  api: {
    getInstanceConfig: (...a: unknown[]) => getInstanceConfig(...a),
    updateInstanceConfig: (...a: unknown[]) => updateInstanceConfig(...a),
    discover: (...a: unknown[]) => discover(...a),
    discoverSessions: vi.fn(),
    createProject: vi.fn(),
    adoptChats: vi.fn(),
  },
}));
vi.mock("../../lib/projects-context", () => ({
  useProjects: () => ({
    projects: [],
    rootWorkspace: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn(),
  }),
}));
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => vi.fn() };
});

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

type HomeProps = Parameters<typeof HomePane>[0];

/**
 * Render Home for an ordinary project, with everything quiet. Every test
 * overrides only the prop it is about.
 */
function renderHome(over: Partial<HomeProps> = {}, project: Project = makeProject({ slug: "p" })) {
  return render(
    <HomePane
      project={project}
      running={[]}
      unread={[]}
      recent={[]}
      attentionLoading={false}
      attentionError={null}
      changelog=""
      overview=""
      onOpenChat={onOpenChat}
      onNewChat={onNewChat}
      {...over}
    />,
  );
}

const sectionHeadings = () =>
  screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent ?? "");

beforeEach(() => {
  onOpenChat.mockReset();
  onNewChat.mockReset();
  localStorage.clear();
});

describe("HomePane: section order (#599)", () => {
  it("opens on Running & Recent → OVERVIEW.md → CHANGELOG.md", () => {
    // Four, not five: the Files preview between the feeds and the notes is gone
    // (#880). It answered neither of Home's two questions, and the Files TAB —
    // one click away, and able to browse subdirectories — did the job properly.
    renderHome({
      running: [row({ sessionId: "r1" })],
      unread: [row({ sessionId: "u1" })],
      overview: "# O",
      changelog: "# C",
    });
    expect(sectionHeadings()).toEqual([
      "Running & Recent1 running · 1 unread",
      "OVERVIEW.md",
      "CHANGELOG.md",
    ]);
  });

  it("renders no Files section, and no empty state where one used to be", () => {
    // Both halves matter. The heading is gone, and so is "No files yet" — which
    // on a fresh install was a void under a heading on the page whose job is
    // getting a new user to their first chat (#865).
    //
    // There is no `files` prop left to vary, which is the strongest form this
    // assertion can take: Home cannot render a file listing because it is no
    // longer given one. The Files TAB still lists them — see the E2E control.
    renderHome({ running: [row({ sessionId: "r1" })], unread: [row({ sessionId: "u1" })] });
    expect(screen.queryByText("No files yet")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View all" })).not.toBeInTheDocument();
    expect(sectionHeadings().some((h) => /^Files/.test(h))).toBe(false);
  });

  it("shows the project directory as the footer line", () => {
    renderHome({}, makeProject({ slug: "p", dir: "/data/projects/p" }));
    expect(screen.getByText("/data/projects/p")).toBeInTheDocument();
  });

  it("leads with the summary line, and has no Overview card or Edit details action", () => {
    // #599 kept the summary OFF Home because the workspace header already showed
    // it, and a summary CARD at the bottom made the page end on metadata. Since
    // #919 the header is just the name and the tabs, so Home is the one place
    // inside a project that says what it is — as a single line at the TOP, not a
    // card at the bottom. Editing details is the Settings tab's job.
    renderHome({}, makeProject({ slug: "p", summary: "the blurb" }));
    const summary = screen.getByTestId("home-summary");
    expect(summary).toHaveTextContent("the blurb");
    expect(screen.queryByRole("button", { name: /Edit details/i })).not.toBeInTheDocument();
    expect(sectionHeadings().some((h) => /^Overview$/.test(h))).toBe(false);
  });

  it("renders no summary line when the project has no summary", () => {
    renderHome({}, makeProject({ slug: "p", summary: "" }));
    expect(screen.queryByTestId("home-summary")).not.toBeInTheDocument();
  });

  it("has no projects grid — that section moved off Home entirely", () => {
    renderHome();
    expect(sectionHeadings().some((h) => /^Projects/.test(h))).toBe(false);
    expect(screen.queryByRole("button", { name: /New Project/i })).not.toBeInTheDocument();
  });
});

/** The rows of the one feed, top to bottom, as `state:name`. */
const feedRows = () =>
  within(screen.getByTestId("home-attention-chats"))
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("data-state"))
    .map((b) => `${b.getAttribute("data-state")}:${b.querySelector(".truncate")?.textContent}`);

const at = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

describe("HomePane: the Running & Recent feed", () => {
  it("is ONE list: running first, then everything else newest first, unread marked", () => {
    // Two side-by-side tables put a one-row Running beside a forty-row Unread.
    // One list says the same thing without the stub — and a READ chat that was
    // active a minute ago outranks an unread one from last month.
    renderHome({
      running: [row({ sessionId: "r1", name: "Streaming now", updatedAt: at(90) })],
      unread: [
        row({ sessionId: "u-old", name: "Old reply", updatedAt: at(60 * 24 * 20) }),
        row({ sessionId: "u-new", name: "New reply", updatedAt: at(2) }),
      ],
      recent: [
        row({ sessionId: "u-new", name: "New reply", updatedAt: at(2) }),
        row({ sessionId: "seen", name: "Seen chat", updatedAt: at(5) }),
        row({ sessionId: "u-old", name: "Old reply", updatedAt: at(60 * 24 * 20) }),
      ],
    });
    expect(feedRows()).toEqual([
      "running:Streaming now",
      "unread:New reply",
      "read:Seen chat",
      "unread:Old reply",
    ]);
    expect(screen.queryByTestId("home-running-chats")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-unread-chats")).not.toBeInTheDocument();
  });

  it("orders RUNNING rows like the fleet strip — longest-running first, unknown last", () => {
    // The strip is this list left to right; the two must agree on which live
    // turn leads.
    const starts: Record<string, number> = { young: Date.now() - 5_000, old: Date.now() - 600_000 };
    const spy = vi
      .spyOn(chatClient, "turnStartedAt")
      .mockImplementation((id: string) => starts[id] ?? null);
    try {
      renderHome({
        running: [
          row({ sessionId: "unknown", name: "Unknown start" }),
          row({ sessionId: "young", name: "Young turn" }),
          row({ sessionId: "old", name: "Old turn" }),
        ],
      });
      expect(feedRows()).toEqual(["running:Old turn", "running:Young turn", "running:Unknown start"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps an unread chat the server's capped `recent` list dropped", () => {
    // `recent` is capped; `unread` is not. An unread chat past the cap is still
    // unread — the counts say so — so it must not silently vanish from Home.
    renderHome({
      unread: [row({ sessionId: "ancient", name: "Ancient reply", updatedAt: at(60 * 24 * 90) })],
      recent: [row({ sessionId: "seen", name: "Seen chat", updatedAt: at(5) })],
    });
    expect(feedRows()).toEqual(["read:Seen chat", "unread:Ancient reply"]);
  });

  it("orders by the LATER of last message and last completed turn", () => {
    renderHome({
      recent: [
        row({ sessionId: "a", name: "Msg recent", updatedAt: at(3) }),
        row({ sessionId: "b", name: "Turn recent", updatedAt: at(600), lastTurnCompletedAt: at(1) }),
      ],
    });
    expect(feedRows()).toEqual(["read:Turn recent", "read:Msg recent"]);
  });

  it("folds the tail behind Show more, but never a running row", () => {
    const recent = Array.from({ length: 14 }, (_, i) =>
      row({ sessionId: `c${i}`, name: `Chat ${i}`, updatedAt: at(i + 1) }),
    );
    renderHome({
      running: [row({ sessionId: "r1", name: "Live 1" }), row({ sessionId: "r2", name: "Live 2" })],
      recent,
    });
    // Two running + the first ten recent.
    expect(feedRows()).toHaveLength(12);
    expect(feedRows().slice(0, 2)).toEqual(["running:Live 1", "running:Live 2"]);
    fireEvent.click(screen.getByRole("button", { name: "Show 4 more" }));
    expect(feedRows()).toHaveLength(16);
    expect(feedRows().at(-1)).toBe("read:Chat 13");
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(feedRows()).toHaveLength(12);
  });

  it("offers no Show more when everything fits", () => {
    renderHome({ recent: [row({ sessionId: "a", name: "Only one" })] });
    expect(screen.queryByRole("button", { name: /Show \d+ more/ })).not.toBeInTheDocument();
  });

  it("says how many are running and unread beside the heading", () => {
    renderHome({
      running: [row({ sessionId: "r1" })],
      unread: [row({ sessionId: "u1" }), row({ sessionId: "u2" })],
    });
    expect(screen.getByRole("heading", { level: 3, name: /Running & Recent/ })).toHaveTextContent(
      "1 running · 2 unread",
    );
  });

  it("offers New chat from the header", () => {
    renderHome({ running: [row({ name: "Streaming now" })] });
    fireEvent.click(screen.getByRole("button", { name: /New chat/i }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it("hands onOpenChat BOTH the session id and the owning project", () => {
    // The feed is subtree-wide, so a row can belong to another workspace — the
    // session id alone doesn't say where to navigate.
    renderHome({
      running: [row({ sessionId: "s9", name: "Ad stripping", projectSlug: "hushpod" })],
    });
    fireEvent.click(screen.getByText("Ad stripping"));
    expect(onOpenChat).toHaveBeenCalledWith("s9", "hushpod");
  });

  it("shows a READ-only workspace as a table, not an invitation", () => {
    // Before, nothing running and nothing unread meant "No chats yet" even on
    // a project full of chats. Now the recent ones are worth showing.
    renderHome({ recent: [row({ sessionId: "a", name: "Seen chat" })] });
    expect(feedRows()).toEqual(["read:Seen chat"]);
    expect(screen.queryByText("No chats yet")).not.toBeInTheDocument();
  });

  it("collapses a workspace with NO chats into one invitation", () => {
    renderHome();
    expect(screen.getByText("No chats yet")).toBeInTheDocument();
    expect(screen.queryByTestId("home-attention-chats")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /New chat/i }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it("shows a skeleton, not an empty state, on the first load", () => {
    // "No chats yet" while the answer is still in flight is a lie the user acts
    // on. Dropping `!attentionLoading` from the `noChats` gate is the regression
    // this exists to catch.
    const { container } = renderHome({ attentionLoading: true });
    expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(1);
    expect(screen.queryByText("No chats yet")).not.toBeInTheDocument();
  });

  it("keeps the rows on screen while a refetch is in flight", () => {
    // A refetch fires on every turn boundary anywhere in the fleet; flashing
    // skeletons each time would make a busy instance's Home unreadable.
    renderHome({ attentionLoading: true, running: [row({ name: "Still here" })] });
    expect(screen.getByText("Still here")).toBeInTheDocument();
  });

  it("replaces the feed with the error, and does not claim there are no chats", () => {
    renderHome({ attentionError: "attention feed exploded" });
    expect(screen.getByText("attention feed exploded")).toBeInTheDocument();
    expect(screen.queryByTestId("home-attention-chats")).not.toBeInTheDocument();
    expect(screen.queryByText("No chats yet")).not.toBeInTheDocument();
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
    expect(within(screen.getByTestId("home-attention-chats")).getByText("Hushpod")).toBeInTheDocument();
  });

  it("leaves a row from THIS workspace unlabelled", () => {
    renderHome({
      running: [row({ name: "Local chat", projectSlug: "p", projectName: "Test Project" })],
    });
    const feed = screen.getByTestId("home-attention-chats");
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
    const feed = screen.getByTestId("home-attention-chats");
    expect(within(feed).getByText("Root chat")).toBeInTheDocument();
    expect(within(feed).queryByText("Instance Root")).not.toBeInTheDocument();
  });

  it("still labels a PROJECT's row on the root's Home", () => {
    // The other half of the same comparison: from `""`, a real slug IS foreign.
    renderHome(
      { running: [row({ name: "Ad stripping", projectSlug: "hushpod", projectName: "Hushpod" })] },
      makeProject({ slug: "", name: "Instance Root" }),
    );
    expect(within(screen.getByTestId("home-attention-chats")).getByText("Hushpod")).toBeInTheDocument();
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

  it("shows a per-file empty state when the workspace has no notes yet", () => {
    renderHome();
    expect(screen.getByText("No OVERVIEW.md yet")).toBeInTheDocument();
    expect(screen.getByText("No CHANGELOG.md yet")).toBeInTheDocument();
  });
});

/**
 * The root workspace's Home as the instance's onboarding surface (#865).
 *
 * The rule pinned throughout: everything here is gated on `root`, and a
 * PROJECT's Home is untouched by all of it. That control assertion is the point
 * — this component is shared, and the failure mode of the change is
 * instance-level content leaking onto every project's front door.
 */
describe("HomePane: root onboarding (#865)", () => {
  /** Render the ROOT's Home. `instanceEmpty` is the state under test each time. */
  const renderRoot = (over: Partial<HomeProps> = {}) =>
    renderHome({ root: true, ...over }, makeProject({ slug: "", name: "Workspace" }));

  beforeEach(() => {
    getInstanceConfig.mockReset();
    updateInstanceConfig.mockReset();
    discover.mockReset();
    getInstanceConfig.mockResolvedValue({ groups: [], configPath: "", restartRequired: false });
    updateInstanceConfig.mockResolvedValue({
      restartRequired: false,
      configPath: "",
      configVersion: null,
    });
    discover.mockResolvedValue({
      claudeHome: "/data/claude-home",
      homeDir: "/data",
      scanned: 0,
      candidates: [],
      excluded: {},
    });
  });

  it("renders Discovery inline at the top when the instance is EMPTY", async () => {
    renderRoot({ instanceEmpty: true });
    expect(await screen.findByTestId("home-first-run")).toBeInTheDocument();
  });

  it("SUPPRESSES running and unread entirely on an empty instance", async () => {
    // Not softened — removed. Zero chats means neither widget can say anything
    // true, and "Nothing is running and there are no unread replies" is noise on
    // an instance that has never run anything. It also supersedes the
    // no-chats panel, which is Home's only primary action on an ordinary
    // quiet day: here the first-run content IS the primary action, and two
    // competing invitations is worse than one.
    renderRoot({ instanceEmpty: true });
    await screen.findByTestId("home-first-run");
    expect(screen.queryByText("Running & Recent")).not.toBeInTheDocument();
    expect(screen.queryByText("No chats yet")).not.toBeInTheDocument();
  });

  it("shows the feeds and no Discovery once the instance is NOT empty", async () => {
    renderRoot({ instanceEmpty: false });
    expect(await screen.findByText("No chats yet")).toBeInTheDocument();
    expect(screen.queryByTestId("home-first-run")).not.toBeInTheDocument();
  });

  it("renders NEITHER while emptiness is still unknown", async () => {
    // `null` is not `false`. Guessing costs a visible flash on exactly the fresh
    // install this exists for: guess "not empty" and the onboarding lands a beat
    // late, underneath feeds that then disappear.
    renderRoot({ instanceEmpty: null });
    // The permanent furniture is there immediately…
    expect(await screen.findByTestId("home-tips-panel")).toBeInTheDocument();
    // …but the slot whose contents depend on the answer is not guessed at.
    expect(screen.queryByTestId("home-first-run")).not.toBeInTheDocument();
    expect(screen.queryByText("No chats yet")).not.toBeInTheDocument();
  });

  it("carries BOTH cards on a POPULATED root too", async () => {
    // They are not first-run scaffolding to be thrown away: the root's Home is
    // the instance's landing surface every day, not only on day one. Neither is
    // closeable — the dismissal machinery went with the slideshow.
    renderRoot({ instanceEmpty: false });
    expect(await screen.findByTestId("home-whats-new")).toBeInTheDocument();
    expect(screen.getByTestId("home-tips-panel")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Close/ })).not.toBeInTheDocument();
  });

  it("puts What's New in the LEFT slot, before Tips", async () => {
    // Deliberate: What's New is the card with a reason to be looked FOR, so it
    // takes the position the eye reaches first. DOM order is what carries that,
    // and it is the kind of thing a refactor reorders without noticing.
    renderRoot({ instanceEmpty: false });
    const cards = await screen.findAllByTestId(/^home-(whats-new|tips-panel)$/);
    expect(cards.map((c) => c.dataset.testid)).toEqual(["home-whats-new", "home-tips-panel"]);
  });

  it("asks the server for NOTHING to render the cards", async () => {
    // The dismissal was the only reason Home read instance config, and it is
    // gone. A per-visit request for a question nothing asks any more is exactly
    // the sort of leftover this check exists to catch.
    renderRoot({ instanceEmpty: false });
    await screen.findByTestId("home-tips-panel");
    expect(getInstanceConfig).not.toHaveBeenCalled();
    expect(updateInstanceConfig).not.toHaveBeenCalled();
  });

  it("leaves a PROJECT's Home completely alone — the control", async () => {
    // The whole risk of threading `root` through a shared component. A project's
    // Home gets no onboarding, and must not even ASK: that is an instance-level
    // question it never reads, once per project visit.
    renderHome({ instanceEmpty: true }, makeProject({ slug: "p" }));
    expect(await screen.findByText("No chats yet")).toBeInTheDocument();
    expect(screen.queryByTestId("home-first-run")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-whats-new")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-tips-panel")).not.toBeInTheDocument();
    expect(getInstanceConfig).not.toHaveBeenCalled();
  });
});
