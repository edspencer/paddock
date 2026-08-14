import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { RootHome } from "./RootHome";
import { ProjectsProvider } from "../lib/projects-context";
import { makeProject } from "../test/factories";
import type { DiscoverResult, Project } from "../lib/types";

/**
 * The first-run loop, end to end (#808, still binding after #865).
 *
 * Reported from real use: Discovery found the user's directories and the import
 * succeeded, but nothing refreshed — a manual browser reload was needed before
 * the imported projects appeared.
 *
 * The unit tests either side of this one each pass with the bug present. The
 * defect only exists where `RootHome`, `useInstanceEmpty`, `ProjectsProvider`,
 * `HomePane` and `DiscoverView` meet: the import is precisely the act that stops
 * the instance being empty, which is what the first-run content's own presence
 * is conditional on. So this file mocks the API and `ProjectView` and nothing
 * else — every one of the rest is the real thing, because the seam between them
 * IS the bug.
 *
 * Two assertions, and they pull in opposite directions. Both must hold:
 *
 *  - the sidebar is current the moment the run ends (the reported symptom), and
 *  - the success screen and its per-row outcomes are still on screen (the
 *    deliberate design the naive fix destroys — a refresh that flips `empty`
 *    unmounts the very content reporting the result, which is worse than the bug
 *    because the failure rows are the ones that had something to say).
 *
 * #865 moved Discovery from being the whole page to being a SECTION of the root
 * workspace's Home, so what appears and disappears here is that section rather
 * than the screen. The latch it depends on is unchanged, which is why this test
 * is rewritten rather than deleted: it is the only thing standing between that
 * move and a silently re-broken refresh.
 */

const CANDIDATE_PATH = "/home/ed/code/alpha";

const listProjects = vi.fn();
const listProjectChats = vi.fn();
const discover = vi.fn();
const discoverSessions = vi.fn();
const createProject = vi.fn();
const adoptChats = vi.fn();

const getInstanceConfig = vi.fn();

vi.mock("../lib/api", () => ({
  api: {
    listProjects: (...a: unknown[]) => listProjects(...a),
    listProjectChats: (...a: unknown[]) => listProjectChats(...a),
    discover: (...a: unknown[]) => discover(...a),
    discoverSessions: (...a: unknown[]) => discoverSessions(...a),
    createProject: (...a: unknown[]) => createProject(...a),
    adoptChats: (...a: unknown[]) => adoptChats(...a),
    getInstanceConfig: (...a: unknown[]) => getInstanceConfig(...a),
  },
}));

/**
 * The only stand-in. `ProjectView` opens sockets and fetches a workspace, none of
 * which this test is about — but it is also what mounts `HomePane`, which is
 * where the first-run content now lives. So the stub forwards the three props it
 * forwards for real and mounts the REAL Home underneath, leaving the seam this
 * file exists to guard intact. That ProjectView passes these along is asserted
 * separately, in `ProjectView.root.test.tsx`.
 */
vi.mock("./ProjectView", async () => {
  const { HomePane } = await import("./ProjectView/HomePane");
  const { makeProject: mk } = await import("../test/factories");
  return {
    ProjectView: ({
      root,
      instanceEmpty,
      onInstanceRecheck,
    }: {
      root?: boolean;
      instanceEmpty?: boolean | null;
      onInstanceRecheck?: () => void;
    }) => (
      <div data-testid="project-view">
        {root ? "root" : "project"}
        <HomePane
          project={mk({ slug: "", name: "Workspace" })}
          root={root}
          instanceEmpty={instanceEmpty}
          onInstanceRecheck={onInstanceRecheck}
          running={[]}
          unread={[]}
          attentionLoading={false}
          attentionError={null}
          changelog=""
          overview=""
          files={[]}
          onOpenChat={() => {}}
          onNewChat={() => {}}
        />
      </div>
    ),
  };
});

function discoverResult(): DiscoverResult {
  return {
    claudeHome: "/data/claude-home",
    homeDir: "/home/ed",
    scanned: 3,
    candidates: [
      {
        path: CANDIDATE_PATH,
        name: "alpha",
        suggestedSlug: "alpha",
        hasGit: true,
        insideHome: true,
        sessionCount: 2,
        filteredCount: 0,
        lastSessionAt: "2026-08-01T00:00:00.000Z",
      },
    ],
    excluded: {},
  };
}

/** What `GET /api/projects` returns; flipped by the import, as on a real server. */
let projects: Project[] = [];

function renderHome() {
  return render(
    <MemoryRouter>
      <ProjectsProvider>
        <RootHome />
      </ProjectsProvider>
    </MemoryRouter>,
  );
}

describe("RootHome + Discovery, first run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projects = [];
    listProjects.mockImplementation(async () => ({ projects, root: makeProject({ slug: "" }) }));
    listProjectChats.mockResolvedValue([]);
    discover.mockResolvedValue(discoverResult());
    discoverSessions.mockResolvedValue({ path: CANDIDATE_PATH, sessions: [], filtered: [] });
    createProject.mockImplementation(async (input: { slug?: string; path?: string }) => {
      const created = makeProject({
        slug: input.slug ?? "alpha",
        name: "alpha",
        workingDir: input.path ?? CANDIDATE_PATH,
      });
      // The server now has it, so the next `GET /api/projects` says so.
      projects = [created];
      return created;
    });
    adoptChats.mockResolvedValue({ adopted: ["s1", "s2"], skipped: [] });
    // #865: Home reads the Getting Started dismissal from the instance config.
    // Irrelevant here, and stubbed so it cannot interfere.
    getInstanceConfig.mockResolvedValue({ groups: [], configPath: "", restartRequired: false });
  });

  it("shows the imported projects without a browser reload, and keeps the result on screen", async () => {
    const user = userEvent.setup();
    renderHome();

    await user.click(await screen.findByRole("button", { name: /Adopt 1 project/ }));
    await screen.findByRole("button", { name: "Get started" });

    // The symptom. Before the fix this stayed at one call — the list was
    // refetched only by "Get started", so anyone who read the success screen and
    // looked at the sidebar saw an instance that still had nothing in it, and
    // reloading the browser was the only way to move on.
    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(2));

    // …and the content reporting the run survived that refresh. Asserted on the
    // row's own sentence rather than the headline, because the per-row outcomes
    // are the part that carries information a failed row cannot get twice.
    expect(screen.getByText(/Adopted 2 chats/)).toBeInTheDocument();
    // The workspace is on screen THROUGHOUT now — that is #865's whole point, and
    // it is why the latch matters more rather than less: the section could vanish
    // out of a page that stays put, which is easier to miss than a whole screen.
    expect(screen.getByTestId("project-view")).toBeInTheDocument();
    expect(screen.getByTestId("home-first-run")).toBeInTheDocument();
  });

  it("hands over to the ordinary root Home on Get started", async () => {
    const user = userEvent.setup();
    renderHome();

    await user.click(await screen.findByRole("button", { name: /Adopt 1 project/ }));
    await user.click(await screen.findByRole("button", { name: "Get started" }));

    // `navigate("/")` cannot do this — Home already IS "/". The latch releasing
    // is what retires the section, so this fails if `onInstanceRecheck` is ever
    // dropped on the way through, which would leave a permanent first-run panel
    // on the Home of an instance that is no longer new.
    await waitFor(() => expect(screen.queryByTestId("home-first-run")).not.toBeInTheDocument());
    expect(screen.queryByText(/Adopted 2 chats/)).not.toBeInTheDocument();
    // …and what replaces it is the ordinary Home, feeds and all — the widgets
    // that were suppressed precisely because there was nothing to put in them.
    expect(screen.getByText("All caught up")).toBeInTheDocument();
  });

  it("does not refresh between rows, only when the whole run is over", async () => {
    // The original reason the refresh was deferred, and still binding: on this
    // mount the first successful row would otherwise unmount the screen the user
    // is watching the remaining rows on.
    const user = userEvent.setup();
    discover.mockResolvedValue({
      ...discoverResult(),
      candidates: [
        ...discoverResult().candidates,
        {
          path: "/home/ed/code/beta",
          name: "beta",
          suggestedSlug: "beta",
          hasGit: true,
          insideHome: true,
          sessionCount: 1,
          filteredCount: 0,
        },
      ],
    });
    let releaseSecond: (p: Project) => void = () => {};
    createProject.mockImplementation(async (input: { slug?: string; path?: string }) => {
      const created = makeProject({ slug: input.slug ?? "x", workingDir: input.path ?? "/x" });
      projects = [...projects, created];
      if (input.slug === "beta") return new Promise<Project>((r) => (releaseSecond = r));
      return created;
    });

    renderHome();
    await user.click(await screen.findByRole("button", { name: /Adopt 2 projects/ }));

    // First row landed, second still in flight: one refresh — the provider's own
    // mount — and no more.
    await waitFor(() => expect(screen.getByText(/Adopted 2 chats into “alpha”/)).toBeInTheDocument());
    expect(listProjects).toHaveBeenCalledTimes(1);

    releaseSecond(makeProject({ slug: "beta", workingDir: "/home/ed/code/beta" }));
    await screen.findByRole("button", { name: "Get started" });
    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(2));
  });
});
