import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { DiscoverView } from "./DiscoverView";
import { makeProject } from "../test/factories";
import type { DiscoverCandidate, DiscoverResult, DiscoverSessions } from "../lib/types";

const refresh = vi.fn();
vi.mock("../lib/projects-context", () => ({
  useProjects: () => ({
    projects: [],
    rootWorkspace: null,
    loading: false,
    error: null,
    refresh: (...a: unknown[]) => refresh(...a),
    upsert: vi.fn(),
    remove: vi.fn(),
  }),
}));

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigate };
});

const discover = vi.fn();
const discoverSessions = vi.fn();
const createProject = vi.fn();
const adoptChats = vi.fn();
vi.mock("../lib/api", () => ({
  api: {
    discover: (...a: unknown[]) => discover(...a),
    discoverSessions: (...a: unknown[]) => discoverSessions(...a),
    createProject: (...a: unknown[]) => createProject(...a),
    adoptChats: (...a: unknown[]) => adoptChats(...a),
  },
}));

function candidate(over: Partial<DiscoverCandidate> = {}): DiscoverCandidate {
  return {
    path: "/home/ed/code/paddock",
    name: "paddock",
    suggestedSlug: "paddock",
    hasGit: true,
    insideHome: true,
    sessionCount: 3,
    filteredCount: 2,
    lastSessionAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

function result(over: Partial<DiscoverResult> = {}): DiscoverResult {
  return {
    claudeHome: "/data/claude-home",
    homeDir: "/home/ed",
    scanned: 12,
    candidates: [candidate()],
    excluded: { "temp-root": 8, "no-git": 2 },
    ...over,
  };
}

function sessionList(over: Partial<DiscoverSessions> = {}): DiscoverSessions {
  return {
    path: "/home/ed/code/paddock",
    sessions: [
      { sessionId: "s1", mtime: "2026-08-01T00:00:00.000Z", sizeBytes: 4096, autoName: "First" },
      { sessionId: "s2", mtime: "2026-07-01T00:00:00.000Z", sizeBytes: 8192, preview: "hello" },
    ],
    filtered: [{ sessionId: "s3", reason: "too-small" }],
    ...over,
  };
}

function renderView(
  props: {
    firstRun?: boolean;
    embedded?: boolean;
    onLeave?: () => void;
    onStartChat?: () => void;
  } = {},
) {
  return render(
    <MemoryRouter>
      <DiscoverView {...props} />
    </MemoryRouter>,
  );
}

describe("DiscoverView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discover.mockResolvedValue(result());
    discoverSessions.mockResolvedValue(sessionList());
    createProject.mockImplementation(async (input: { slug?: string; path?: string }) =>
      makeProject({ slug: input.slug ?? "paddock", workingDir: input.path ?? "/x" }),
    );
    adoptChats.mockResolvedValue({ adopted: ["s1", "s2"], skipped: [] });
  });

  it("lists candidates with their counts, everything ticked", async () => {
    renderView();
    expect(await screen.findByText("/home/ed/code/paddock")).toBeInTheDocument();
    const row = screen.getByTestId("discover-row-paddock");
    expect(within(row).getByText(/3 conversations/)).toBeInTheDocument();
    expect(screen.getByLabelText("Adopt /home/ed/code/paddock")).toBeChecked();
    expect(screen.getByRole("button", { name: /Adopt 1 project/ })).toBeEnabled();
  });

  it("surfaces the filtered-out count so 'why 3 and not 5' has an answer", async () => {
    renderView();
    expect(await screen.findByText(/2 filtered out/)).toBeInTheDocument();
    expect(screen.getByText(/8 in temp directories/)).toBeInTheDocument();
  });

  it("does not read a directory's sessions until its row is expanded", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("/home/ed/code/paddock");
    expect(discoverSessions).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Show conversations" }));
    await waitFor(() => expect(discoverSessions).toHaveBeenCalledWith("/home/ed/code/paddock"));
    expect(await screen.findByText("First")).toBeInTheDocument();

    // Collapsing and re-expanding must not re-fetch — the sessions are already
    // in hand and a second read is pure cost.
    await user.click(screen.getByRole("button", { name: "Hide conversations" }));
    await user.click(screen.getByRole("button", { name: "Show conversations" }));
    expect(discoverSessions).toHaveBeenCalledTimes(1);
  });

  it("goes indeterminate when a conversation inside an expanded row is unticked", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole("button", { name: "Show conversations" }));
    await screen.findByText("First");

    await user.click(screen.getByLabelText("First"));
    const box = screen.getByLabelText("Adopt /home/ed/code/paddock");
    expect(box).toHaveAttribute("aria-checked", "mixed");
    expect((box as HTMLInputElement).indeterminate).toBe(true);
  });

  it("sends only the ticked session ids for an expanded row", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole("button", { name: "Show conversations" }));
    await screen.findByText("First");
    await user.click(screen.getByLabelText("First"));
    await user.click(screen.getByRole("button", { name: /Adopt 1 project/ }));

    await waitFor(() =>
      expect(adoptChats).toHaveBeenCalledWith("paddock", {
        sourceCwd: "/home/ed/code/paddock",
        sessionIds: ["s2"],
      }),
    );
  });

  it("imports everything on offer for a row that was never expanded", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole("button", { name: /Adopt 1 project/ }));
    await waitFor(() =>
      expect(adoptChats).toHaveBeenCalledWith("paddock", { sourceCwd: "/home/ed/code/paddock" }),
    );
  });

  it("disables the submit button while the run is in flight", async () => {
    const user = userEvent.setup();
    let release: (v: unknown) => void = () => {};
    createProject.mockImplementation(
      () => new Promise((r) => (release = r as (v: unknown) => void)),
    );
    renderView();
    const button = await screen.findByRole("button", { name: /Adopt 1 project/ });
    await user.click(button);
    await waitFor(() => expect(screen.getByRole("button", { name: /Adopting/ })).toBeDisabled());
    // A second click on the disabled control must not start a second run.
    await user.click(screen.getByRole("button", { name: /Adopting/ }));
    expect(createProject).toHaveBeenCalledTimes(1);
    release(makeProject({ slug: "paddock", workingDir: "/home/ed/code/paddock" }));
    await screen.findByRole("button", { name: "Get started" });
  });

  it("colours a successful row green and says what it imported", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole("button", { name: /Adopt 1 project/ }));
    const row = await screen.findByTestId("discover-row-paddock");
    await waitFor(() => expect(row).toHaveAttribute("data-tone", "success"));
    expect(within(row).getByText(/Adopted 2 chats/)).toBeInTheDocument();
  });

  it("colours a failed create red, on that row, with no global toast", async () => {
    const user = userEvent.setup();
    createProject.mockRejectedValue(new Error("path is inside another project"));
    renderView();
    await user.click(await screen.findByRole("button", { name: /Adopt 1 project/ }));
    const row = await screen.findByTestId("discover-row-paddock");
    await waitFor(() => expect(row).toHaveAttribute("data-tone", "danger"));
    expect(within(row).getByText(/path is inside another project/)).toBeInTheDocument();
  });

  it("says a project was created but left empty when the import fails", async () => {
    // The interesting failure: something WAS left behind, and only this row can
    // say so.
    const user = userEvent.setup();
    adoptChats.mockRejectedValue(new Error("engine unavailable"));
    renderView();
    await user.click(await screen.findByRole("button", { name: /Adopt 1 project/ }));
    const row = await screen.findByTestId("discover-row-paddock");
    await waitFor(() => expect(row).toHaveAttribute("data-tone", "warn"));
    expect(within(row).getByText(/there and empty/)).toBeInTheDocument();
  });

  it("keeps failures per row when one of two fails", async () => {
    const user = userEvent.setup();
    discover.mockResolvedValue(
      result({
        candidates: [candidate(), candidate({ path: "/home/ed/code/herdctl", suggestedSlug: "herdctl", name: "herdctl" })],
      }),
    );
    createProject.mockImplementation(async (input: { slug?: string; path?: string }) => {
      if (input.slug === "paddock") throw new Error("nope");
      return makeProject({ slug: "herdctl", workingDir: input.path ?? "/x" });
    });
    renderView();
    await user.click(await screen.findByRole("button", { name: /Adopt 2 projects/ }));
    await waitFor(() =>
      expect(screen.getByTestId("discover-row-paddock")).toHaveAttribute("data-tone", "danger"),
    );
    expect(screen.getByTestId("discover-row-herdctl")).toHaveAttribute("data-tone", "success");
  });

  it("offers Get started on completion, refreshing the project list before leaving", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole("button", { name: /Adopt 1 project/ }));
    const done = await screen.findByRole("button", { name: "Get started" });
    // The submit bar is gone, so the run cannot be fired twice.
    expect(screen.queryByRole("button", { name: /Adopt 1 project/ })).not.toBeInTheDocument();

    await user.click(done);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("refreshes the project list as soon as the run ends, not only on Get started (#808)", async () => {
    // The success screen says "They are in the sidebar now", and until this
    // refresh that sentence was false — the sidebar still read "No projects yet"
    // and a manual browser reload was the only way to see the import land.
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole("button", { name: /Adopt 1 project/ }));
    await screen.findByRole("button", { name: "Get started" });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("tells its host to re-ask rather than relying on navigation (#808)", async () => {
    // On the Home mount `navigate("/")` cannot end this screen — it already IS
    // "/". `RootHome` passes its `recheck` in, and that is what hands over.
    const user = userEvent.setup();
    const onLeave = vi.fn();
    renderView({ firstRun: true, onLeave });
    await user.click(await screen.findByRole("button", { name: /Adopt 1 project/ }));
    await user.click(await screen.findByRole("button", { name: "Get started" }));
    await waitFor(() => expect(onLeave).toHaveBeenCalled());
  });

  it("warns about a divergent recorded path BEFORE the import, not after", async () => {
    discover.mockResolvedValue(
      result({ candidates: [candidate({ recordedPath: "/private/home/ed/code/paddock" })] }),
    );
    renderView();
    expect(await screen.findByText(/different spelling/)).toBeInTheDocument();
    expect(screen.getByText("/private/home/ed/code/paddock")).toBeInTheDocument();
  });

  it("explains an empty Claude home rather than rendering a blank table", async () => {
    // A container's Claude home is its own, not a user's, so finding nothing is
    // the expected answer there — and a blank page looks like a bug.
    discover.mockResolvedValue(result({ scanned: 0, candidates: [], excluded: {} }));
    renderView();
    expect(
      await screen.findByText(/No Claude Code history has been recorded under/),
    ).toBeInTheDocument();
    expect(screen.getByText("/data/claude-home")).toBeInTheDocument();
    // Says this is normal rather than implying a fault, and never claims the
    // machine's history is "already a project, or was filtered out" (#865).
    expect(screen.getByText(/normal on a new install/)).toBeInTheDocument();
    expect(screen.queryByText(/already a project, or was filtered out/)).not.toBeInTheDocument();
  });

  it("offers a way forward on the Home mount when there is nothing to adopt (#865)", async () => {
    // The bug the whole issue is about: with no history the import footer and
    // the "Get started" exit are each gated on something that can never happen,
    // so the screen had NO BUTTON ON IT AT ALL. Embedded on Home, starting a
    // chat is the honest next action, and this panel is where it goes.
    const onStartChat = vi.fn();
    discover.mockResolvedValue(result({ scanned: 0, candidates: [], excluded: {} }));
    renderView({ firstRun: true, embedded: true, onStartChat });
    await userEvent.setup().click(await screen.findByRole("button", { name: "Start a chat" }));
    expect(onStartChat).toHaveBeenCalled();
  });

  it("grows no dead chat button on the standalone route", async () => {
    // `/discover` supplies no `onStartChat`, and must not render a button with
    // nothing behind it. The action belongs to the mount that can honour it.
    discover.mockResolvedValue(result({ scanned: 0, candidates: [], excluded: {} }));
    renderView();
    await screen.findByText(/No Claude Code history has been recorded under/);
    expect(screen.queryByRole("button", { name: "Start a chat" })).not.toBeInTheDocument();
  });

  it("drops the tally and its toggles when the scan found nothing at all", async () => {
    // "0 transcript folders scanned" under a panel that has just said there is
    // no history is the same finding twice, and the toggles would offer to relax
    // rules that ate nothing.
    discover.mockResolvedValue(result({ scanned: 0, candidates: [], excluded: {} }));
    renderView();
    await screen.findByText(/No Claude Code history has been recorded under/);
    expect(
      screen.queryByLabelText("Also offer directories without a git repository"),
    ).not.toBeInTheDocument();
  });

  it("keeps the tally when the scan DID find folders it could not offer", async () => {
    // The other half of the branch above: history exists, none of it is
    // adoptable, and the tally plus its toggles are the only way to find out why.
    discover.mockResolvedValue(
      result({ scanned: 12, candidates: [], excluded: { "temp-root": 8, "no-git": 2 } }),
    );
    renderView();
    expect(await screen.findByText("Nothing to adopt")).toBeInTheDocument();
    expect(screen.getByText(/found Claude Code history on this machine/)).toBeInTheDocument();
    expect(
      screen.getByLabelText("Also offer directories without a git repository"),
    ).toBeInTheDocument();
  });

  it("offers the soft rules as toggles only when relaxing one would reveal something", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("/home/ed/code/paddock");
    // `no-git: 2` is in the tally, `outside-home` is not.
    expect(
      screen.getByLabelText("Also offer directories without a git repository"),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Also offer directories outside your home directory"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("Also offer directories without a git repository"));
    await waitFor(() =>
      expect(discover).toHaveBeenLastCalledWith({
        includeNonGit: true,
        includeOutsideHome: false,
      }),
    );
  });

  it("surfaces a scan failure instead of an empty table", async () => {
    discover.mockRejectedValue(new Error("discovery blew up"));
    renderView();
    expect(await screen.findByText("discovery blew up")).toBeInTheDocument();
  });

  it("changes only the lead copy between its two mount points", async () => {
    renderView({ firstRun: true });
    // Conditional, not an assertion about this user. The old lead — "you have
    // probably already been using Claude Code in a terminal" — was a guess
    // stated as fact, and wrong about exactly the people it greeted (#865).
    expect(await screen.findByText(/If you have used Claude Code in a terminal/)).toBeInTheDocument();
    expect(screen.queryByText(/you have probably already been using/)).not.toBeInTheDocument();
    // Same table underneath — the mount point is not a second implementation.
    expect(screen.getByLabelText("Adopt /home/ed/code/paddock")).toBeChecked();
  });

  it("drops its own page chrome when embedded, and keeps it when routed", async () => {
    // Embedded it is a SECTION of Home: Home owns the heading, the scroll
    // container and the width. Its own header nested inside Home's would be a
    // second "Discover" title on a page that already has one, over a scroller
    // inside a scroller.
    const { unmount } = renderView({ embedded: true });
    await screen.findByText("/home/ed/code/paddock");
    expect(screen.queryByRole("heading", { name: "Discover" })).not.toBeInTheDocument();
    unmount();

    renderView();
    await screen.findByText("/home/ed/code/paddock");
    expect(screen.getByRole("heading", { name: "Discover" })).toBeInTheDocument();
  });
});
