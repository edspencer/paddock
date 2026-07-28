import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { ProjectView } from "./ProjectView";
import { makeProject, makeChat } from "../test/factories";
import { resetLastSeenForTests } from "../lib/lastSeen";
import type { Project, ProjectDetail } from "../lib/types";
import type { ChatPaneProps } from "../components/ChatPane";
import { readLastTab } from "../lib/lastTab";

/**
 * `ProjectView root` — the ROOT project's Home + Chat (issue #516 Phase 3).
 *
 * The design's claim is that the root needs no separate view: the same
 * component, the same API calls, only flat top-level URLs. So these tests are
 * about the differences that ARE real — `/` is Home, `/chat` is the chat tab,
 * no sticky last tab, and no tabs for panes that don't exist yet.
 */
let chatPaneProps: ChatPaneProps | null = null;
vi.mock("../components/ChatPane", () => ({
  ChatPane: (props: ChatPaneProps) => {
    chatPaneProps = props;
    return <div data-testid="chat-pane">chat for {props.projectSlug}</div>;
  },
}));

// SettingsPane / InstanceConfigForm / HistoryPane are tested separately; stub
// them to markers so the ROOT tab routing is what is asserted.
vi.mock("../components/SettingsPane", () => ({
  SettingsPane: ({ project }: { project: { slug: string } }) => (
    <div data-testid="settings-pane">settings for {project.slug}</div>
  ),
}));
vi.mock("../components/InstanceConfigForm", () => ({
  InstanceConfigForm: () => <div data-testid="instance-config-form">instance config</div>,
}));
vi.mock("../components/HistoryPane", () => ({
  HistoryPane: ({ slug }: { slug: string }) => <div data-testid="history-pane">runs for {slug}</div>,
}));

// ChangesPane is tested separately; stub it to a marker that echoes the slug it
// was handed, so the root's Changes routing is what's asserted.
vi.mock("../components/ChangesPane", () => ({
  ChangesPane: ({ slug }: { slug: string }) => (
    <div data-testid="changes-pane">changes for {slug}</div>
  ),
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
    },
  };
});

vi.mock("../lib/projects-context", () => ({
  useProjects: () => ({
    projects: [],
    rootProject: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn(),
    setRootProject: vi.fn(),
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

const rootProject = () =>
  makeProject({ slug: "__root", name: "Instance Root", summary: "everything, from the top" });

beforeEach(() => {
  chatPaneProps = null;
  Object.values(apiFns).forEach((m) => m.mockReset());
  apiFns.listProjectFiles.mockResolvedValue([]);
  apiFns.listProjectDir.mockResolvedValue({ path: "", kind: "dir", entries: [] });
  apiFns.gitStatus.mockResolvedValue({ repo: false, files: [], clean: true });
  apiFns.listProjectChats.mockResolvedValue([]);
  apiFns.chatUsage.mockResolvedValue({});
  apiFns.markChatSeen.mockResolvedValue(undefined);
  apiFns.projectChatMessages.mockResolvedValue([]);
  apiFns.getProjectDetail.mockResolvedValue(detail(rootProject()));
  resetLastSeenForTests();
  localStorage.clear();
});

describe("ProjectView root (#516)", () => {
  it("renders Home at `/` — no redirect", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(rootProject(), { changelog: "# Changes\n- did a root thing" }),
    );
    renderRootAt("/");
    // The summary lands in both the header and the Home overview card.
    expect(await screen.findAllByText("everything, from the top")).not.toHaveLength(0);
    expect(screen.getByText(/did a root thing/)).toBeInTheDocument();
    expect(screen.queryByTestId("chat-pane")).not.toBeInTheDocument();
  });

  it("addresses the ordinary project API under the reserved slug", async () => {
    renderRootAt("/");
    await screen.findAllByText("everything, from the top");
    expect(apiFns.getProjectDetail).toHaveBeenCalledWith("__root");
  });

  it("renders the chat tab at the flat `/chat`", async () => {
    renderRootAt("/chat");
    expect(await screen.findByTestId("chat-pane")).toBeInTheDocument();
    expect(chatPaneProps?.projectSlug).toBe("__root");
  });

  it("opens a specific root chat at `/chat/:sessionId`", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(rootProject(), { chats: [makeChat({ sessionId: "s1", name: "Root chat" })] }),
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

  it("shows the FULL tab bar — the root is an ordinary project (Phase 5)", async () => {
    apiFns.gitStatus.mockResolvedValue({ repo: true, files: [], clean: true, branch: "main" });
    renderRootAt("/chat");
    await screen.findByTestId("chat-pane");
    // The end state #516 was aiming at: there is no tab a project gets and the
    // root doesn't. (Changes is conditional on the dir being a git repo, for the
    // root exactly as for a project.)
    for (const name of ["Home", "Chat", "Files", "Changes", "History", "Settings", "Triggers"]) {
      expect(screen.getByRole("button", { name }), name).toBeInTheDocument();
    }
  });

  it("renders the Files tab at the flat `/files`, against the reserved slug", async () => {
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
    expect(apiFns.listProjectDir).toHaveBeenCalledWith("__root", "");
  });

  it("nests the Files subpath in the flat URL", async () => {
    apiFns.listProjectDir.mockResolvedValue({ path: "docs", kind: "dir", entries: [] });
    renderRootAt("/files/docs");
    await waitFor(() => expect(apiFns.listProjectDir).toHaveBeenCalledWith("__root", "docs"));
  });

  it("renders the Changes tab at the flat `/changes` over the whole repo", async () => {
    apiFns.gitStatus.mockResolvedValue({
      repo: true,
      files: [{ path: "a.md", status: "M", staged: false }],
      clean: false,
      branch: "main",
    });
    renderRootAt("/changes");
    expect(await screen.findByTestId("changes-pane")).toHaveTextContent("changes for __root");
  });

  it("shows pinned file tabs at the root (pinning is driven from Files)", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "__root", name: "Root", pinned: ["NOTES.md"] })),
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
    expect(readLastTab("__root")).toBeNull();
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

  it("renders BOTH settings sections at the root: workspace + instance", async () => {
    renderRootAt("/settings");
    // The root's own project.yaml settings…
    expect(await screen.findByTestId("settings-pane")).toBeInTheDocument();
    // …and the instance-wide paddock.config.yaml form beneath it. They stay two
    // sections because their lifecycles differ (hot-applied vs restart-required).
    expect(await screen.findByTestId("instance-config-form")).toBeInTheDocument();
  });

  it("renders History at the flat `/history`", async () => {
    renderRootAt("/history");
    expect(await screen.findByTestId("history-pane")).toHaveTextContent("__root");
  });
});
