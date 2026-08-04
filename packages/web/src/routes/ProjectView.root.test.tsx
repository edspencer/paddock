import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { ProjectView } from "./ProjectView";
import { makeProject, makeChat } from "../test/factories";
import { resetLastSeenForTests } from "../lib/lastSeen";
import type { AttentionChat, Project, ProjectDetail } from "../lib/types";
import type { ChatPaneProps } from "../components/ChatPane";
import { readLastTab } from "../lib/lastTab";

/**
 * `ProjectView root` — the ROOT workspace (issue #516).
 *
 * The design's claim is that the root needs no separate view: the same
 * component, the same API calls, only flat top-level URLs and the empty
 * workspace key. So these tests are about the differences that ARE real — `/` is
 * Home (whose attention feed is fleet-wide, because the root's subtree is the
 * whole instance), `/chat` is the chat tab, and there is no sticky last tab.
 */
let chatPaneProps: ChatPaneProps | null = null;
vi.mock("../components/ChatPane", () => ({
  ChatPane: (props: ChatPaneProps) => {
    chatPaneProps = props;
    return <div data-testid="chat-pane">chat for {props.projectSlug}</div>;
  },
}));

// SettingsPane / HistoryPane are tested separately; stub them to markers so the
// ROOT tab routing is what is asserted. InstanceConfigForm is stubbed too, but
// only so its ABSENCE from the Settings tab is a meaningful assertion — it lives
// on its own `/config` screen now (see InstanceConfigPage.test.tsx).
vi.mock("../components/SettingsPane", () => ({
  SettingsPane: ({ project }: { project: { slug: string } }) => (
    <div data-testid="settings-pane">settings for {project.slug}</div>
  ),
}));
vi.mock("../components/InstanceConfigForm", () => ({
  InstanceConfigForm: () => <div data-testid="instance-config-form">instance config</div>,
}));
// The root's workspace key is the EMPTY string, so a marker that interpolates it
// would render indistinguishably from a marker with no slug at all. These stubs
// therefore capture the key they were handed and the tests assert on it
// directly — `toBe("")` is the assertion that would otherwise be lost.
let historySlug: string | null = null;
vi.mock("../components/HistoryPane", () => ({
  HistoryPane: ({ slug }: { slug: string }) => {
    historySlug = slug;
    return <div data-testid="history-pane">runs</div>;
  },
}));

// ChangesPane is tested separately; stub it to a marker that captures the key it
// was handed, so the root's Changes routing is what's asserted.
let changesSlug: string | null = null;
vi.mock("../components/ChangesPane", () => ({
  ChangesPane: ({ slug }: { slug: string }) => {
    changesSlug = slug;
    return <div data-testid="changes-pane">changes</div>;
  },
}));

const apiFns = {
  getProjectDetail: vi.fn(),
  listProjectFiles: vi.fn(),
  listProjectDir: vi.fn(),
  gitStatus: vi.fn(),
  listProjectChats: vi.fn(),
  chatUsage: vi.fn(),
  projectChatMessages: vi.fn(),
  markChatSeen: vi.fn(),
  promoteChat: vi.fn(),
  attentionChats: vi.fn(),
  getAdoptableChats: vi.fn(),
  adoptChats: vi.fn(),
};
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      getProjectDetail: (...a: unknown[]) => apiFns.getProjectDetail(...a),
      listProjectFiles: (...a: unknown[]) => apiFns.listProjectFiles(...a),
      listProjectDir: (...a: unknown[]) => apiFns.listProjectDir(...a),
      gitStatus: (...a: unknown[]) => apiFns.gitStatus(...a),
      listProjectChats: (...a: unknown[]) => apiFns.listProjectChats(...a),
      chatUsage: (...a: unknown[]) => apiFns.chatUsage(...a),
      projectChatMessages: (...a: unknown[]) => apiFns.projectChatMessages(...a),
      markChatSeen: (...a: unknown[]) => apiFns.markChatSeen(...a),
      promoteChat: (...a: unknown[]) => apiFns.promoteChat(...a),
      attentionChats: (...a: unknown[]) => apiFns.attentionChats(...a),
      getAdoptableChats: (...a: unknown[]) => apiFns.getAdoptableChats(...a),
      adoptChats: (...a: unknown[]) => apiFns.adoptChats(...a),
    },
  };
});

// The root workspace's CHILDREN, as the shared projects context sees them. Only
// the promote tests care about the list itself now — root Home's fleet-wide feed
// comes from the server (`attentionChats`), not from this list.
let mockProjects: Project[] = [];
// The context's mutators, as STABLE spies. They have to survive re-renders: the
// promote tests assert the sidebar was told about the new project (#566), and a
// `vi.fn()` created inside the hook body is a fresh spy on every render — so the
// call would land on an object no assertion can reach.
const projectsCtx = {
  refresh: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
};
vi.mock("../lib/projects-context", () => ({
  useProjects: () => ({
    projects: mockProjects,
    rootWorkspace: null,
    loading: false,
    error: null,
    ...projectsCtx,
  }),
}));

vi.mock("../lib/ws", () => ({
  chatClient: {
    onActiveSessions: (cb: (s: ReadonlySet<string>) => void) => {
      cb(new Set());
      return () => {};
    },
  },
}));

function detail(project: Project, over: Partial<ProjectDetail> = {}): ProjectDetail {
  return { project, changelog: "", chats: [], ...over };
}

/** Echoes the current pathname so a navigation assertion is a text assertion. */
function Here() {
  return <span data-testid="here">{useLocation().pathname}</span>;
}

function renderRootAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Here />
      <Routes>
        <Route path="/" element={<ProjectView root />} />
        <Route path="/chat" element={<ProjectView root />} />
        <Route path="/chat/:sessionId" element={<ProjectView root />} />
        <Route path="/files" element={<ProjectView root />} />
        <Route path="/files/*" element={<ProjectView root />} />
        <Route path="/changes" element={<ProjectView root />} />
        <Route path="/changes/:file" element={<ProjectView root />} />
        <Route path="/history" element={<ProjectView root />} />
        <Route path="/settings" element={<ProjectView root />} />
        <Route path="/triggers" element={<ProjectView root />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The root workspace: the instance's own directory, keyed by the EMPTY string. */
const rootWorkspace = () =>
  makeProject({ slug: "", name: "Instance Root", summary: "everything, from the top" });

/** One row of the Home attention feed, tagged with the workspace it lives in. */
const foreignChat = (
  sessionId: string,
  name: string,
  projectSlug: string,
  projectName: string,
): AttentionChat => ({ ...makeChat({ sessionId, name }), projectSlug, projectName });

beforeEach(() => {
  chatPaneProps = null;
  historySlug = null;
  changesSlug = null;
  mockProjects = [];
  Object.values(apiFns).forEach((m) => m.mockReset());
  Object.values(projectsCtx).forEach((m) => m.mockReset());
  apiFns.listProjectFiles.mockResolvedValue([]);
  apiFns.listProjectDir.mockResolvedValue({ path: "", kind: "dir", entries: [] });
  apiFns.gitStatus.mockResolvedValue({ repo: false, files: [], clean: true });
  apiFns.listProjectChats.mockResolvedValue([]);
  apiFns.chatUsage.mockResolvedValue({});
  apiFns.markChatSeen.mockResolvedValue(undefined);
  apiFns.projectChatMessages.mockResolvedValue([]);
  apiFns.attentionChats.mockResolvedValue({ running: [], unread: [] });
  // #588: nothing to import by default, so the sidebar's import row is absent
  // from every test that isn't about it.
  apiFns.getAdoptableChats.mockResolvedValue({ count: 0, sources: [] });
  apiFns.adoptChats.mockResolvedValue({ adopted: [], skipped: [] });
  apiFns.getProjectDetail.mockResolvedValue(detail(rootWorkspace()));
  resetLastSeenForTests();
  localStorage.clear();
});

describe("ProjectView root (#516)", () => {
  it("renders Home at `/` — no redirect", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(rootWorkspace(), { changelog: "# Changes\n- did a root thing" }),
    );
    renderRootAt("/");
    // The summary lands in the workspace header above the tab bar.
    expect(await screen.findAllByText("everything, from the top")).not.toHaveLength(0);
    expect(screen.getByText(/did a root thing/)).toBeInTheDocument();
    expect(screen.queryByTestId("chat-pane")).not.toBeInTheDocument();
  });

  it("addresses the ordinary workspace API under the empty root key", async () => {
    renderRootAt("/");
    await screen.findAllByText("everything, from the top");
    // No sentinel slug: the root's key is "", which `apiBase` turns into
    // `/api/root` — the same handlers a project reaches at `/api/projects/:slug`.
    expect(apiFns.getProjectDetail).toHaveBeenCalledWith("");
  });

  it("renders the chat tab at the flat `/chat`", async () => {
    renderRootAt("/chat");
    expect(await screen.findByTestId("chat-pane")).toBeInTheDocument();
    expect(chatPaneProps?.projectSlug).toBe("");
  });

  it("opens a specific root chat at `/chat/:sessionId`", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(rootWorkspace(), { chats: [makeChat({ sessionId: "s1", name: "Root chat" })] }),
    );
    renderRootAt("/chat/s1");
    await screen.findByTestId("chat-pane");
    expect(chatPaneProps?.initialSessionId).toBe("s1");
  });

  it("sends Home back to `/`, not `/home`", async () => {
    renderRootAt("/chat");
    await screen.findByTestId("chat-pane");
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    expect(await screen.findByTestId("here")).toHaveTextContent("/");
    expect(screen.getByTestId("here").textContent).toBe("/");
  });

  it("shows the FULL tab bar — the root is an ordinary workspace", async () => {
    apiFns.gitStatus.mockResolvedValue({ repo: true, files: [], clean: true, branch: "main" });
    renderRootAt("/chat");
    await screen.findByTestId("chat-pane");
    // The end state #516 was aiming at: there is no tab a project gets and the
    // root doesn't. (Changes is conditional on the dir being a git repo, for the
    // root exactly as for a project.) The root's children are no longer a tab of
    // their own — they are the first section of Home, asserted below.
    for (const name of ["Home", "Chat", "Files", "Changes", "History", "Settings", "Triggers"]) {
      expect(screen.getByRole("button", { name }), name).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Projects" })).not.toBeInTheDocument();
  });

  it("puts Home FIRST in the tab bar", async () => {
    apiFns.gitStatus.mockResolvedValue({ repo: true, files: [], clean: true, branch: "main" });
    renderRootAt("/chat");
    await screen.findByTestId("chat-pane");
    const home = screen.getByRole("button", { name: "Home" });
    // Node.DOCUMENT_POSITION_FOLLOWING — every other tab comes AFTER Home.
    for (const name of ["Chat", "Files", "Changes", "History", "Settings", "Triggers"]) {
      const tab = screen.getByRole("button", { name });
      expect(home.compareDocumentPosition(tab) & 4, name).toBeTruthy();
    }
  });

  it("lists a CHILD project's running chat on root Home, labelled with its project", async () => {
    // The root's subtree is the whole instance, so its Home is the fleet's
    // "what needs me?" (#599) — and it gets there by asking for its OWN
    // workspace's feed. No `root` branch: the server's subtree scoping is what
    // makes the same request fleet-wide here and project-local elsewhere.
    apiFns.attentionChats.mockResolvedValue({
      running: [foreignChat("s9", "Ad stripping run", "hushpod", "Hushpod")],
      unread: [],
    });
    renderRootAt("/chat");
    await screen.findByTestId("chat-pane");
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    expect(await screen.findByText("Ad stripping run")).toBeInTheDocument();
    // Labelled with the owning project, because "which Hushpod is this?" has to
    // be answerable from the row itself once the list spans workspaces.
    const row = screen.getByTestId("home-running-chats");
    expect(within(row).getByText("Hushpod")).toBeInTheDocument();
    expect(apiFns.attentionChats).toHaveBeenCalledWith("");
    // Home is `/` at the root — no `/projects`, no `/home`. And the only <h1> is
    // still the workspace's; the projects grid that used to add a second heading
    // here is gone.
    expect(screen.getByTestId("here").textContent).toBe("/");
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([
      "Instance Root",
    ]);
  });

  it("shows the feed on a direct load of `/`, not just after a tab click", async () => {
    // `/` IS root Home, so the rows have to be there on arrival — the instance's
    // front door is the one page nobody navigates TO.
    apiFns.attentionChats.mockResolvedValue({
      running: [],
      unread: [foreignChat("s9", "Reply waiting", "hushpod", "Hushpod")],
    });
    renderRootAt("/");
    expect(await screen.findByText("Reply waiting")).toBeInTheDocument();
  });

  it("leaves the ROOT's OWN chats unlabelled — the empty key is not 'foreign'", async () => {
    // The regression a truthiness test would cause: the root's slug is `""`, so
    // `row.projectSlug || …` would tag every one of its own chats with a project
    // pill. The comparison has to be `!==` against the workspace key.
    apiFns.attentionChats.mockResolvedValue({
      running: [foreignChat("r1", "Root's own chat", "", "Instance Root")],
      unread: [],
    });
    renderRootAt("/");
    const row = await screen.findByTestId("home-running-chats");
    expect(within(row).getByText("Root's own chat")).toBeInTheDocument();
    expect(within(row).queryByText("Instance Root")).not.toBeInTheDocument();
  });

  it("opens a child project's chat in THAT project's URL, not the root's", async () => {
    // Root Home's rows span workspaces, so clicking one has to navigate into the
    // owning workspace's base — `/projects/hushpod/chat/s9`, not the root's flat
    // `/chat/s9`, which would open a session the root doesn't have.
    apiFns.attentionChats.mockResolvedValue({
      running: [foreignChat("s9", "Ad stripping run", "hushpod", "Hushpod")],
      unread: [],
    });
    renderRootAt("/");
    fireEvent.click(await screen.findByText("Ad stripping run"));
    expect(screen.getByTestId("here").textContent).toBe("/projects/hushpod/chat/s9");
  });

  it("renders the Files tab at the flat `/files`, against the empty root key", async () => {
    apiFns.listProjectDir.mockResolvedValue({
      path: "",
      kind: "dir",
      entries: [
        { name: "some-project", kind: "dir" },
        { name: "CLAUDE.md", kind: "file" },
      ],
    });
    renderRootAt("/files");
    expect(await screen.findByText("CLAUDE.md")).toBeInTheDocument();
    // The root's working dir contains every project — browsing into one is the
    // intended "omniscient admin" behaviour, not a leak (#516).
    expect(screen.getByText("some-project")).toBeInTheDocument();
    expect(apiFns.listProjectDir).toHaveBeenCalledWith("", "");
  });

  it("nests the Files subpath in the flat URL", async () => {
    apiFns.listProjectDir.mockResolvedValue({ path: "docs", kind: "dir", entries: [] });
    renderRootAt("/files/docs");
    await waitFor(() => expect(apiFns.listProjectDir).toHaveBeenCalledWith("", "docs"));
  });

  it("renders the Changes tab at the flat `/changes` over the whole repo", async () => {
    apiFns.gitStatus.mockResolvedValue({
      repo: true,
      files: [{ path: "a.md", status: "M", staged: false }],
      clean: false,
      branch: "main",
    });
    renderRootAt("/changes");
    await screen.findByTestId("changes-pane");
    // The whole backing repo, addressed by the root's own (empty) key.
    expect(changesSlug).toBe("");
  });

  it("shows pinned file tabs at the root (pinning is driven from Files)", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "", name: "Root", pinned: ["NOTES.md"] })),
    );
    renderRootAt("/chat");
    await screen.findByTestId("chat-pane");
    expect(screen.getByRole("button", { name: /NOTES\.md/ })).toBeInTheDocument();
  });

  it("does NOT persist a sticky last tab at the root", async () => {
    renderRootAt("/chat");
    await screen.findByTestId("chat-pane");
    // `/` must always render Home; a sticky tab would make the instance's front
    // door sometimes land on Files.
    expect(readLastTab("")).toBeNull();
  });

  it("offers the overflow menu WITHOUT Delete — the root cannot be deleted", async () => {
    renderRootAt("/");
    await screen.findAllByText("everything, from the top");
    const menu = screen.getByRole("button", { name: /project actions/i });
    fireEvent.click(menu);
    // Edit details is real (it opens the Settings tab, live as of Phase 5)…
    expect(await screen.findByRole("menuitem", { name: /edit details/i })).toBeInTheDocument();
    // …but deleting the root is refused server-side (its dir IS the projects
    // root), so the action is absent rather than present-and-erroring.
    expect(screen.queryByRole("menuitem", { name: /delete project/i })).not.toBeInTheDocument();
  });

  it("renders ONLY the workspace settings at the root — instance config moved to /config", async () => {
    renderRootAt("/settings");
    // The root's own project.yaml settings, exactly as a project's tab renders.
    expect(await screen.findByTestId("settings-pane")).toBeInTheDocument();
    // The instance-wide paddock.config.yaml form used to sit beneath it as a
    // second section, which read as two pages in one — and, because it is a
    // fragment that only works as a flex-column child, was what stopped the tab
    // scrolling at all. It is its own screen now.
    expect(screen.queryByTestId("instance-config-form")).not.toBeInTheDocument();
  });

  it("renders History at the flat `/history`", async () => {
    renderRootAt("/history");
    await screen.findByTestId("history-pane");
    expect(historySlug).toBe("");
  });

  /**
   * Promote-to-project (#566). The action itself always worked — the project got
   * created and the transcript re-homed — but the handler only navigated, so the
   * new project stayed missing from the sidebar until a reload. There is no push
   * channel for the project list (`ws.ts` carries `chat:*` only), so the context
   * has to be told locally, exactly as the New Project path already does.
   *
   * Asserted against the CONTEXT rather than a rendered nav because `ProjectView`
   * doesn't render the sidebar — `AppShell` does, from this same context. So "the
   * row appears" is, at this layer, "the context was updated".
   */
  describe("promote to project (#566)", () => {
    const promotedProject = () =>
      makeProject({ slug: "water-heater", name: "Garage Water Heater Replacement" });

    /** Drive the promote modal from the chat row through to a submit. */
    async function promoteRootChat() {
      apiFns.getProjectDetail.mockResolvedValue(
        detail(rootWorkspace(), { chats: [makeChat({ sessionId: "s1", name: "Root chat" })] }),
      );
      renderRootAt("/chat");
      await screen.findByTestId("chat-pane");
      fireEvent.click(
        await screen.findByRole("button", { name: /promote chat Root chat into a project/i }),
      );
      await screen.findByRole("heading", { name: "Promote to project" });
      fireEvent.click(screen.getByRole("button", { name: "Promote to project" }));
    }

    it("puts the new project in the sidebar without a reload", async () => {
      apiFns.promoteChat.mockResolvedValue({ project: promotedProject(), promoted: true });
      await promoteRootChat();
      // THE REGRESSION. Without this the row is absent until the provider
      // refetches for some unrelated reason — which is why the project used to
      // show up only once you'd sent a turn in it, or reloaded.
      await waitFor(() => expect(projectsCtx.upsert).toHaveBeenCalledTimes(1));
      // The server's record, not a locally-guessed one: the sidebar row needs the
      // real slug and name to link and label correctly.
      expect(projectsCtx.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ slug: "water-heater", name: "Garage Water Heater Replacement" }),
      );
    });

    it("updates the sidebar by insert, not by a refetch that blanks it", async () => {
      apiFns.promoteChat.mockResolvedValue({ project: promotedProject(), promoted: true });
      await promoteRootChat();
      await waitFor(() => expect(projectsCtx.upsert).toHaveBeenCalled());
      // `refresh()` flips the context's `loading` flag, and AppShell swaps the
      // entire project list for skeletons while it is set — so refetching here
      // would trade a missing row for a flash of the whole nav. Asserted rather
      // than left to a comment, because "it works either way" is exactly how
      // that regression gets in.
      expect(projectsCtx.refresh).not.toHaveBeenCalled();
    });

    it("still lands the user in the new project", async () => {
      apiFns.promoteChat.mockResolvedValue({ project: promotedProject(), promoted: true });
      await promoteRootChat();
      // Pre-existing behaviour, kept: the chat moved, so follow it.
      await waitFor(() =>
        expect(screen.getByTestId("here")).toHaveTextContent("/projects/water-heater/chat"),
      );
    });

    it("leaves the sidebar alone when the promote FAILS", async () => {
      const { ApiError } = await vi.importActual<typeof import("../lib/api")>("../lib/api");
      apiFns.promoteChat.mockRejectedValue(new ApiError("disk on fire", 500));
      await promoteRootChat();
      // The modal reports the failure and stays put. Nothing was created, so
      // nothing may be inserted — an optimistic row here would be a phantom
      // project that outlives the error message. (Before #566 this assertion was
      // unreachable: the modal wiped its own error on the way out of `busy`.)
      expect(await screen.findByText("disk on fire")).toBeInTheDocument();
      expect(projectsCtx.upsert).not.toHaveBeenCalled();
      expect(screen.getByTestId("here").textContent).toBe("/chat");
    });
  });

  /**
   * Importing native CLI chats at the ROOT (#588).
   *
   * The root's workspace key is the EMPTY STRING, so anything that hand-builds a
   * URL or gates on `if (slug)` silently drops it — the import would either 404 or
   * never be offered at all. These assert the key actually travels: `apiBase("")`
   * resolves to `/api/root`, and the calls are made with `""`, not with some
   * sentinel or with the project route's slug.
   */
  describe("import native CLI chats (#588)", () => {
    it("offers the import at the root, addressed by the empty key", async () => {
      apiFns.getAdoptableChats.mockResolvedValue({
        count: 4,
        sources: [{ sourceCwd: "/data/projects", sessionIds: ["n1", "n2", "n3", "n4"] }],
      });
      renderRootAt("/chat");
      expect(
        await screen.findByRole("button", { name: /Import 4 native/i }),
      ).toBeInTheDocument();
      // `toHaveBeenCalledWith("")` and not merely "was called": a truthiness gate
      // on the key would skip the fetch entirely and this is what catches it.
      expect(apiFns.getAdoptableChats).toHaveBeenCalledWith("");
    });

    it("imports and re-reads both the list and the count under the empty key", async () => {
      apiFns.getAdoptableChats
        .mockResolvedValueOnce({
          count: 2,
          sources: [
            {
              sourceCwd: "/w",
              sessionIds: ["n1", "n2"],
              sessions: [
                { sessionId: "n1", mtime: "2026-07-01T09:00:00.000Z", sizeBytes: 4096 },
                { sessionId: "n2", mtime: "2026-07-02T09:00:00.000Z", sizeBytes: 4096 },
              ],
            },
          ],
        })
        .mockResolvedValue({ count: 0, sources: [] });
      apiFns.adoptChats.mockResolvedValue({ adopted: ["n1", "n2"], skipped: [] });
      renderRootAt("/chat");
      // Through the confirmation dialog (#660), same as a project.
      fireEvent.click(await screen.findByRole("button", { name: /Import 2 native/i }));
      fireEvent.click(await screen.findByRole("button", { name: /^Import 2 chats$/i }));

      await waitFor(() =>
        expect(apiFns.adoptChats).toHaveBeenCalledWith("", { sessionIds: ["n1", "n2"] }),
      );
      await waitFor(() => expect(apiFns.listProjectChats).toHaveBeenCalledWith(""));
      expect(await screen.findByRole("status")).toHaveTextContent("Imported 2 chats");
      // Gone because the live count came back 0 — the same property as a project.
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: /Import \d+ native/i })).toBeNull(),
      );
    });
  });
});
