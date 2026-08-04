import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ProjectView } from "./ProjectView";
import { makeProject, makeChat, makeModelsResponse } from "../test/factories";
import { resetLastSeenForTests } from "../lib/lastSeen";
import type { FileEntry, Project, GitProjectStatus, ProjectDetail } from "../lib/types";
import type { ChatPaneProps } from "../components/ChatPane";

// ChatPane is exercised on its own; here we stub it so ProjectView's tab/list/
// pin/file-routing logic is what's under test. Capture its props for assertions.
let chatPaneProps: ChatPaneProps | null = null;
vi.mock("../components/ChatPane", () => ({
  ChatPane: (props: ChatPaneProps) => {
    chatPaneProps = props;
    return <div data-testid="chat-pane">chat for {props.projectSlug} / {props.initialSessionId ?? "new"}</div>;
  },
}));
// ChangesPane is tested separately; stub it to a marker so we can assert routing.
vi.mock("../components/ChangesPane", () => ({
  ChangesPane: ({ slug }: { slug: string }) => <div data-testid="changes-pane">changes for {slug}</div>,
}));
// FileView fetches a file; stub to a marker that echoes which file.
vi.mock("../components/FileView", () => ({
  FileView: ({ name }: { name: string }) => <div data-testid="file-view">file: {name}</div>,
}));

const apiFns = {
  getProjectDetail: vi.fn(),
  listProjectFiles: vi.fn(),
  listProjectDir: vi.fn(),
  gitStatus: vi.fn(),
  pinFile: vi.fn(),
  unpinFile: vi.fn(),
  deleteProject: vi.fn(),
  deleteProjectChat: vi.fn(),
  renameProjectChat: vi.fn(),
  archiveProjectChat: vi.fn(),
  starProjectChat: vi.fn(),
  markChatSeen: vi.fn(),
  listProjectChats: vi.fn(),
  chatUsage: vi.fn(),
  projectChatMessages: vi.fn(),
  getModels: vi.fn(),
  updateProject: vi.fn(),
  listTriggers: vi.fn(),
  archiveProjectChats: vi.fn(),
  markChatsUnread: vi.fn(),
  markChatUnread: vi.fn(),
  deleteProjectChats: vi.fn(),
  detachProjectChat: vi.fn(),
  attentionChats: vi.fn(),
  getAdoptableChats: vi.fn(),
  adoptChats: vi.fn(),
  unadoptChats: vi.fn(),
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
      pinFile: (...a: unknown[]) => apiFns.pinFile(...a),
      unpinFile: (...a: unknown[]) => apiFns.unpinFile(...a),
      deleteProject: (...a: unknown[]) => apiFns.deleteProject(...a),
      deleteProjectChat: (...a: unknown[]) => apiFns.deleteProjectChat(...a),
      renameProjectChat: (...a: unknown[]) => apiFns.renameProjectChat(...a),
      archiveProjectChat: (...a: unknown[]) => apiFns.archiveProjectChat(...a),
      starProjectChat: (...a: unknown[]) => apiFns.starProjectChat(...a),
      markChatSeen: (...a: unknown[]) => apiFns.markChatSeen(...a),
      listProjectChats: (...a: unknown[]) => apiFns.listProjectChats(...a),
      chatUsage: (...a: unknown[]) => apiFns.chatUsage(...a),
      projectChatMessages: (...a: unknown[]) => apiFns.projectChatMessages(...a),
      getModels: (...a: unknown[]) => apiFns.getModels(...a),
      updateProject: (...a: unknown[]) => apiFns.updateProject(...a),
      listTriggers: (...a: unknown[]) => apiFns.listTriggers(...a),
      archiveProjectChats: (...a: unknown[]) => apiFns.archiveProjectChats(...a),
      markChatsUnread: (...a: unknown[]) => apiFns.markChatsUnread(...a),
      markChatUnread: (...a: unknown[]) => apiFns.markChatUnread(...a),
      deleteProjectChats: (...a: unknown[]) => apiFns.deleteProjectChats(...a),
      detachProjectChat: (...a: unknown[]) => apiFns.detachProjectChat(...a),
      attentionChats: (...a: unknown[]) => apiFns.attentionChats(...a),
      getAdoptableChats: (...a: unknown[]) => apiFns.getAdoptableChats(...a),
      adoptChats: (...a: unknown[]) => apiFns.adoptChats(...a),
      unadoptChats: (...a: unknown[]) => apiFns.unadoptChats(...a),
    },
  };
});

const upsert = vi.fn();
const remove = vi.fn();
vi.mock("../lib/projects-context", () => ({
  // Every assertion in this file is about a PROJECT workspace (`/projects/:slug`),
  // so the root workspace is only here to satisfy the context shape (#516).
  useProjects: () => ({
    projects: [],
    rootWorkspace: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
    upsert,
    remove,
  }),
}));

// ProjectView only uses `chatClient.onActiveSessions` (the running-turn set that
// drives the sidebar streaming dots). Mock it so a test can drive that set —
// simulating a chat starting to stream — and assert the #100 refetch behavior.
let activeCb: ((s: ReadonlySet<string>) => void) | null = null;
vi.mock("../lib/ws", () => ({
  chatClient: {
    onActiveSessions: (cb: (s: ReadonlySet<string>) => void) => {
      activeCb = cb;
      cb(new Set()); // fire once with the current (empty) set, like the real client
      return () => {
        activeCb = null;
      };
    },
  },
}));

function detail(project: Project, over: Partial<ProjectDetail> = {}): ProjectDetail {
  return { project, changelog: "", chats: [], ...over };
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:slug/home" element={<ProjectView />} />
        <Route path="/projects/:slug/chat" element={<ProjectView />} />
        <Route path="/projects/:slug/chat/:sessionId" element={<ProjectView />} />
        <Route path="/projects/:slug/files" element={<ProjectView />} />
        <Route path="/projects/:slug/files/*" element={<ProjectView />} />
        <Route path="/projects/:slug/changes" element={<ProjectView />} />
        <Route path="/projects/:slug/changes/:file" element={<ProjectView />} />
        <Route path="/projects/:slug/settings" element={<ProjectView />} />
        <Route path="/projects/:slug/triggers" element={<ProjectView />} />
        <Route path="/projects/:slug/hooks" element={<ProjectView />} />
        {/* Deleting a project returns to the projects list, which #599 put back
            on its own page at `/projects` (see `gridUrl`). Mounted at that path
            rather than `/` so this stub can only be reached by navigating where
            `gridUrl()` actually points. */}
        <Route path="/projects" element={<div>GRID</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  chatPaneProps = null;
  activeCb = null;
  Object.values(apiFns).forEach((m) => m.mockReset());
  apiFns.listProjectFiles.mockResolvedValue([]);
  // The Files tab (#259) reads one directory level via listProjectDir; default
  // to an empty root. `setDir` below drives specific listings per test.
  apiFns.listProjectDir.mockResolvedValue({ path: "", entries: [] });
  apiFns.gitStatus.mockResolvedValue({ repo: false, files: [], clean: true } as GitProjectStatus);
  apiFns.listProjectChats.mockResolvedValue([]);
  apiFns.markChatSeen.mockResolvedValue(undefined);
  apiFns.chatUsage.mockResolvedValue({});
  apiFns.projectChatMessages.mockResolvedValue([]);
  // Home's attention feed (#599). Default to a quiet workspace; a test that
  // cares about the rows themselves overrides this.
  apiFns.attentionChats.mockResolvedValue({ running: [], unread: [] });
  // #588: nothing to import unless a test says otherwise, so the sidebar's
  // "Import N native chats" row stays absent from every unrelated assertion.
  apiFns.getAdoptableChats.mockResolvedValue({ count: 0, sources: [] });
  apiFns.adoptChats.mockResolvedValue({ adopted: [], skipped: [] });
  apiFns.unadoptChats.mockResolvedValue({ released: [] });
  apiFns.getModels.mockResolvedValue(
    makeModelsResponse({
      models: [{ id: "claude-opus-4-8", label: "Opus 4.8", contextLimit: 1_000_000 }],
      defaultModel: "claude-opus-4-8",
    }),
  );
  apiFns.updateProject.mockImplementation((_slug: string, patch: Partial<Project>) =>
    Promise.resolve(makeProject({ slug: "p", ...patch })),
  );
  apiFns.listTriggers.mockResolvedValue({
    triggers: [],
    grantableTools: [],
    events: ["onArchive", "afterTurn"],
    triggerTypes: ["schedule", "event", "webhook"],
  });
  upsert.mockReset();
  remove.mockReset();
  localStorage.clear();
  resetLastSeenForTests();
});

/**
 * Drive the Files tab (#259): `dirs` maps a directory subpath ("" = root) to its
 * entries. `listProjectDir` returns those as `kind: "dir"`; any subpath NOT in
 * the map is treated as a file (`kind: "file"`), exactly like the server, so the
 * browser drops into the file viewer for that path.
 */
function setDir(dirs: Record<string, FileEntry[]>) {
  apiFns.listProjectDir.mockImplementation((_slug: string, subpath = "") =>
    subpath in dirs
      ? Promise.resolve({ path: subpath, kind: "dir", entries: dirs[subpath] })
      : Promise.resolve({ path: subpath, kind: "file", entries: [] }),
  );
}

describe("ProjectView: header + load", () => {
  it("renders the project header with status, tags, and overview badge", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p", name: "Reactor", status: "active", domain: ["nuclear"], hasOverview: true, summary: "fusion" })),
    );
    renderAt("/projects/p/chat");
    expect(await screen.findByRole("heading", { name: "Reactor" })).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("nuclear")).toBeInTheDocument();
    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(screen.getByText("fusion")).toBeInTheDocument();
  });

  it("shows a load error", async () => {
    apiFns.getProjectDetail.mockRejectedValue(new Error("project gone"));
    renderAt("/projects/p/chat");
    expect(await screen.findByText("project gone")).toBeInTheDocument();
  });

  // Issue #116: the chat list renders immediately from a usage-free payload, and
  // the per-chat context ring is filled in afterwards from the separate bulk
  // usage endpoint (keyed by session id).
  it("fills in a chat's context ring from the bulk usage endpoint after load", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [makeChat({ sessionId: "s1", name: "Sized chat" })],
      }),
    );
    apiFns.chatUsage.mockResolvedValue({
      s1: { contextTokens: 250_000, contextLimit: 1_000_000 },
    });
    renderAt("/projects/p/chat");
    // The chat lists as soon as the (usage-free) detail resolves...
    expect(await screen.findAllByText("Sized chat")).not.toHaveLength(0);
    // ...and the ring appears once chatUsage resolves: 250k/1M = 25% full.
    expect(await screen.findByLabelText(/Context 25% full/)).toBeInTheDocument();
    expect(apiFns.chatUsage).toHaveBeenCalledWith("p");
  });
});

describe("ProjectView: tabs", () => {
  it("Chat tab renders the ChatPane; Files tab shows the files list (changelog lives on Home)", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), { changelog: "# Changes\n- did a thing" }),
    );
    setDir({
      "": [
        { name: "OVERVIEW.md", kind: "file" },
        { name: "page.html", kind: "file" },
      ],
    });
    renderAt("/projects/p/chat");
    expect(await screen.findByTestId("chat-pane")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Files$/ }));
    expect(await screen.findByText("OVERVIEW.md")).toBeInTheDocument();
    expect(screen.getByText("page.html")).toBeInTheDocument();
    // The changelog moved to the Home tab — it is not on the Files tab.
    expect(screen.queryByText(/did a thing/)).not.toBeInTheDocument();
  });

  it("Home tab shows OVERVIEW.md and CHANGELOG.md, plus the files", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p", summary: "the overview blurb" }), {
        changelog: "# Changes\n- did a thing",
        overview: "# Overview\n- what this is",
      }),
    );
    apiFns.listProjectFiles.mockResolvedValue(["NOTES.md"]);
    renderAt("/projects/p/home");
    // Both curated files render, expanded by default (#599). OVERVIEW.md leads:
    // what the workspace IS, before the log of how it got there.
    expect(await screen.findByText(/what this is/)).toBeInTheDocument();
    expect(screen.getByText(/did a thing/)).toBeInTheDocument();
    expect(screen.getByText("NOTES.md")).toBeInTheDocument();
    // The summary is the header's job now — Home no longer restates it in a
    // card of its own, so it appears exactly once.
    expect(screen.getAllByText("the overview blurb")).toHaveLength(1);
  });

  it("Home orders its sections Running → Unread → Files → OVERVIEW.md → CHANGELOG.md", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p", summary: "blurb" }), { changelog: "# Changes" }),
    );
    apiFns.listProjectFiles.mockResolvedValue(["NOTES.md"]);
    renderAt("/projects/p/home");
    await screen.findByRole("heading", { name: /^Running/ });
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent ?? "");
    // "What needs me?" before "what is this?" (#599): the two decision feeds
    // lead, the curated prose trails.
    expect(headings).toEqual(["Running", "Unread", "Files1", "OVERVIEW.md", "CHANGELOG.md"]);
  });

  it("a project's Home has NO projects section — the grid moved off Home entirely", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    renderAt("/projects/p/home");
    await screen.findByRole("heading", { name: /^Running/ });
    const headings = screen.getAllByRole("heading").map((h) => h.textContent ?? "");
    expect(headings.some((h) => /^Projects/.test(h))).toBe(false);
    // New Project lives on the sidebar's Projects header now (#599), which
    // ProjectView doesn't render — so nothing here should offer it.
    expect(screen.queryByRole("button", { name: /New Project/i })).not.toBeInTheDocument();
  });

  it("has no Projects tab — that was the root's, and it folded into Home", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    renderAt("/projects/p/home");
    await screen.findByRole("heading", { name: /^Running/ });
    expect(screen.queryByRole("button", { name: "Projects" })).not.toBeInTheDocument();
    // Home leads the row for a project too.
    const home = screen.getByRole("button", { name: "Home" });
    const chat = screen.getByRole("button", { name: "Chat" });
    expect(home.compareDocumentPosition(chat) & 4).toBeTruthy();
  });

  it("the project name is a breadcrumb to the Home tab", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p", name: "Reactor" })),
    );
    renderAt("/projects/p/chat");
    await screen.findByTestId("chat-pane");
    // The name in the header is a button that navigates up to Home.
    fireEvent.click(screen.getByRole("button", { name: "Reactor" }));
    // Home renders — its leading Running section is present.
    expect(await screen.findByRole("heading", { name: /^Running/ })).toBeInTheDocument();
  });

  it("the Settings tab opens the SettingsPane and deep-links (issue #122)", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p", name: "Reactor", summary: "fusion" })),
    );
    renderAt("/projects/p/chat");
    await screen.findByTestId("chat-pane");
    fireEvent.click(screen.getByRole("button", { name: /^Settings$/ }));
    // The pane's Save bar + a keeper field render.
    expect(await screen.findByRole("button", { name: /save changes/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toBeInTheDocument();
  });

  it("Settings deep-links directly via /settings", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    renderAt("/projects/p/settings");
    expect(await screen.findByRole("button", { name: /save changes/i })).toBeInTheDocument();
    // The "Edit" affordances route here rather than opening a modal.
    expect(screen.getByText(/Identity & metadata/i)).toBeInTheDocument();
  });

  it("opens the Triggers tab and mounts the pane (Epic T / T4)", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    // From the chat tab, clicking the Triggers tab mounts the pane (which fetches).
    renderAt("/projects/p/chat");
    await screen.findByTestId("chat-pane");
    fireEvent.click(screen.getByRole("button", { name: /^Triggers$/ }));
    expect(await screen.findByTestId("triggers-pane")).toBeInTheDocument();
    await waitFor(() => expect(apiFns.listTriggers).toHaveBeenCalledWith("p"));
    expect(await screen.findByText(/No triggers yet/i)).toBeInTheDocument();
  });

  it("Triggers deep-links directly via /triggers", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    renderAt("/projects/p/triggers");
    expect(await screen.findByTestId("triggers-pane")).toBeInTheDocument();
    await waitFor(() => expect(apiFns.listTriggers).toHaveBeenCalledWith("p"));
  });

  it("redirects the legacy /hooks route to the Triggers tab", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    renderAt("/projects/p/hooks");
    // The legacy route folds into the Triggers tab (redirect, Epic T / T4).
    expect(await screen.findByTestId("triggers-pane")).toBeInTheDocument();
    await waitFor(() => expect(apiFns.listTriggers).toHaveBeenCalledWith("p"));
  });

  it("the Changes tab is hidden when the projects dir is not a git repo", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    renderAt("/projects/p/chat");
    await screen.findByTestId("chat-pane");
    await waitFor(() => expect(apiFns.gitStatus).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /^Changes/ })).not.toBeInTheDocument();
  });

  it("the Changes tab appears (with a badge) when it IS a repo, and opens the ChangesPane", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    apiFns.gitStatus.mockResolvedValue({
      repo: true,
      branch: "main",
      clean: false,
      files: [{ path: "a.md", status: "M", staged: false, untracked: false }],
    } as GitProjectStatus);
    renderAt("/projects/p/chat");
    const changesTab = await screen.findByRole("button", { name: /Changes/ });
    // Badge shows the uncommitted count.
    expect(within(changesTab).getByText("1")).toBeInTheDocument();
    fireEvent.click(changesTab);
    expect(await screen.findByTestId("changes-pane")).toHaveTextContent("changes for p");
  });

  it("the Changes tab is a real route: a direct /changes URL opens it + survives reload (issue #107)", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    apiFns.gitStatus.mockResolvedValue({
      repo: true,
      branch: "main",
      clean: false,
      files: [{ path: "a.md", status: "M", staged: false, untracked: false }],
    } as GitProjectStatus);
    // Loading the URL directly (as a bookmark / refresh would) lands on Changes.
    renderAt("/projects/p/changes");
    expect(await screen.findByTestId("changes-pane")).toHaveTextContent("changes for p");
  });

  it("a deep-linked changed file (/changes/:file) opens Changes with that file (issue #107)", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    apiFns.gitStatus.mockResolvedValue({
      repo: true,
      branch: "main",
      clean: false,
      files: [{ path: "a.md", status: "M", staged: false, untracked: false }],
    } as GitProjectStatus);
    renderAt("/projects/p/changes/a.md");
    expect(await screen.findByTestId("changes-pane")).toHaveTextContent("changes for p");
  });
});

describe("ProjectView: files + pin-as-tab", () => {
  it("opening a file routes to the file reader", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    setDir({ "": [{ name: "doc.md", kind: "file" }] });
    renderAt("/projects/p/files");
    fireEvent.click(await screen.findByText("doc.md"));
    expect(await screen.findByTestId("file-view")).toHaveTextContent("file: doc.md");
  });

  it("clicking a directory descends into it with a nested URL (#259)", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    setDir({
      "": [
        { name: "design", kind: "dir" },
        { name: "top.md", kind: "file" },
      ],
      design: [{ name: "plan.md", kind: "file" }],
    });
    renderAt("/projects/p/files");
    fireEvent.click(await screen.findByText("design"));
    // The subdirectory's contents render...
    expect(await screen.findByText("plan.md")).toBeInTheDocument();
    // ...alongside a ".." row to go back up.
    expect(screen.getByText("..")).toBeInTheDocument();
    // Going up returns to the root listing.
    fireEvent.click(screen.getByText(".."));
    expect(await screen.findByText("top.md")).toBeInTheDocument();
  });

  it("deep-linking a nested file renders the viewer with a breadcrumb (#259)", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    setDir({ "": [{ name: "design", kind: "dir" }], design: [{ name: "plan.md", kind: "file" }] });
    renderAt("/projects/p/files/design/plan.md");
    expect(await screen.findByTestId("file-view")).toHaveTextContent("file: design/plan.md");
    // The breadcrumb exposes the parent folder as a link back up.
    const crumb = screen.getByRole("navigation", { name: /File path/i });
    expect(within(crumb).getByRole("button", { name: "design" })).toBeInTheDocument();
  });

  it("pinning a file calls the API and renders a pinned sibling tab", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p", pinned: [] })));
    setDir({ "": [{ name: "page.html", kind: "file" }] });
    apiFns.pinFile.mockResolvedValue(makeProject({ slug: "p", pinned: ["page.html"] }));
    renderAt("/projects/p/files");
    await screen.findByText("page.html");
    fireEvent.click(screen.getByRole("button", { name: /^Pin page.html$/i }));
    await waitFor(() => expect(apiFns.pinFile).toHaveBeenCalledWith("p", "page.html"));
    // The pinned tab now exists.
    expect(await screen.findByRole("tab", { name: /Open page.html tab/i })).toBeInTheDocument();
  });

  it("a pinned file shows as a tab on load and the file reader renders it", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p", pinned: ["page.html"] })));
    setDir({ "": [{ name: "page.html", kind: "file" }] });
    renderAt("/projects/p/files/page.html");
    expect(await screen.findByTestId("file-view")).toHaveTextContent("file: page.html");
    expect(screen.getByRole("tab", { name: /Open page.html tab/i })).toBeInTheDocument();
  });

  it("a pinned nested file shows a tab labelled by basename but addressed by full path", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p", pinned: ["design/plan.md"] })),
    );
    setDir({ "": [{ name: "design", kind: "dir" }], design: [{ name: "plan.md", kind: "file" }] });
    renderAt("/projects/p/files/design/plan.md");
    // The reader renders the deep-linked nested file.
    expect(await screen.findByTestId("file-view")).toHaveTextContent("file: design/plan.md");
    // The tab carries the full project-relative path in its accessible name…
    const tab = screen.getByRole("tab", { name: /Open design\/plan.md tab/i });
    // …but shows only the basename as its visible label to stay compact.
    expect(tab).toHaveTextContent("plan.md");
    expect(tab).not.toHaveTextContent("design/plan.md");
  });

  it("unpinning a viewed pinned tab calls unpin and falls back to the files list", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p", pinned: ["page.html"] })));
    setDir({ "": [{ name: "page.html", kind: "file" }] });
    apiFns.unpinFile.mockResolvedValue(makeProject({ slug: "p", pinned: [] }));
    renderAt("/projects/p/files/page.html");
    await screen.findByTestId("file-view");
    fireEvent.click(screen.getByRole("button", { name: /^Unpin page.html$/i }));
    await waitFor(() => expect(apiFns.unpinFile).toHaveBeenCalledWith("p", "page.html"));
  });
});

describe("ProjectView: chat list (delete + rename)", () => {
  it("lists saved chats and opens one", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), { chats: [makeChat({ sessionId: "s1", name: "First chat" })] }),
    );
    renderAt("/projects/p/chat");
    fireEvent.click(await screen.findByText("First chat"));
    await waitFor(() => expect(chatPaneProps?.initialSessionId).toBe("s1"));
  });

  it("deletes a chat after confirmation", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), { chats: [makeChat({ sessionId: "s1", name: "Doomed chat" })] }),
    );
    apiFns.deleteProjectChat.mockResolvedValue(undefined);
    renderAt("/projects/p/chat");
    await screen.findByText("Doomed chat");
    fireEvent.click(screen.getByRole("button", { name: /Delete chat Doomed chat/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Delete chat$/i }));
    await waitFor(() => expect(apiFns.deleteProjectChat).toHaveBeenCalledWith("p", "s1"));
    await waitFor(() => expect(screen.queryByText("Doomed chat")).not.toBeInTheDocument());
  });

  it("renames a chat via the rename dialog", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), { chats: [makeChat({ sessionId: "s1", name: "Old name" })] }),
    );
    apiFns.renameProjectChat.mockResolvedValue(undefined);
    renderAt("/projects/p/chat");
    await screen.findByText("Old name");
    fireEvent.click(screen.getByRole("button", { name: /Rename chat Old name/i }));
    const input = await screen.findByDisplayValue("Old name");
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(apiFns.renameProjectChat).toHaveBeenCalledWith("p", "s1", "New name"));
    expect(await screen.findByText("New name")).toBeInTheDocument();
  });

  it("rename is a no-op when the dialog is cancelled", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), { chats: [makeChat({ sessionId: "s1", name: "Keep me" })] }),
    );
    renderAt("/projects/p/chat");
    await screen.findByText("Keep me");
    fireEvent.click(screen.getByRole("button", { name: /Rename chat Keep me/i }));
    await screen.findByDisplayValue("Keep me");
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(apiFns.renameProjectChat).not.toHaveBeenCalled());
  });

  // What `window.prompt`'s null-vs-"" return used to carry: clearing the box is
  // a deliberate reset to the generated preview name, and it must still reach
  // the API as `null` rather than being mistaken for a cancel.
  it("clearing the name resets the chat to its preview name", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [makeChat({ sessionId: "s1", name: "Custom name", preview: "Fix the loop" })],
      }),
    );
    apiFns.renameProjectChat.mockResolvedValue(undefined);
    renderAt("/projects/p/chat");
    await screen.findByText("Custom name");
    fireEvent.click(screen.getByRole("button", { name: /Rename chat Custom name/i }));
    const input = await screen.findByDisplayValue("Custom name");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(apiFns.renameProjectChat).toHaveBeenCalledWith("p", "s1", null));
    expect(await screen.findByText("Fix the loop")).toBeInTheDocument();
  });
});

// Issue #154: the open chat must never lack a sidebar row, even when it's
// momentarily missing from the list because the post-turn sweep stole its
// session id (mis-attributed to `sweeper-<slug>` → filtered out of the keeper's
// sessions). ProjectView renders a fallback row for the open activeSession.
describe("ProjectView: open chat missing from list (#154)", () => {
  it("renders a fallback row (not a rowless list) when the open chat is absent", async () => {
    // The list comes back empty (mis-attributed), but we opened /chat/ghost.
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" }), { chats: [] }));
    renderAt("/projects/p/chat/ghost");
    // The open chat still has a row instead of the empty-state message.
    expect(await screen.findByText("Current chat")).toBeInTheDocument();
    expect(screen.queryByText(/No saved chats yet/i)).not.toBeInTheDocument();
    // And the chat pane is genuinely open on that session.
    await waitFor(() => expect(chatPaneProps?.initialSessionId).toBe("ghost"));
  });

  it("keeps the open chat's real row when it drops out of a list refresh", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), { chats: [makeChat({ sessionId: "s1", name: "Live chat" })] }),
    );
    // A later refresh (triggered below) returns a list that no longer has s1 —
    // exactly the sweep mis-attribution flicker.
    apiFns.listProjectChats.mockResolvedValue([]);
    renderAt("/projects/p/chat/s1");
    await screen.findByText("Live chat");

    // A running session we've never seen triggers the #100 refetch, which now
    // returns a list without s1.
    act(() => activeCb?.(new Set(["some-other-session"])));

    // s1 is gone from `chats`, but its cached row keeps the open chat visible —
    // with its real name, not the generic fallback.
    await waitFor(() => expect(apiFns.listProjectChats).toHaveBeenCalled());
    expect(screen.getByText("Live chat")).toBeInTheDocument();
    expect(screen.queryByText("Current chat")).not.toBeInTheDocument();
  });

  it("shows no fallback row when the open chat is present in the list", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), { chats: [makeChat({ sessionId: "s1", name: "Real chat" })] }),
    );
    renderAt("/projects/p/chat/s1");
    await screen.findByText("Real chat");
    // No synthetic "Current chat" row when the real one is listed.
    expect(screen.queryByText("Current chat")).not.toBeInTheDocument();
  });
});

describe("ProjectView: chat search (issue #96)", () => {
  const threeChats = () => ({
    chats: [
      makeChat({ sessionId: "s1", name: "Deploy pipeline", preview: "how do I ship" }),
      makeChat({ sessionId: "s2", name: "Bug triage", preview: "the crash on load" }),
      makeChat({ sessionId: "s3", name: "Random musings", preview: "deploy notes here" }),
    ],
  });

  it("filters the chat list by name substring (case-insensitive)", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" }), threeChats()));
    renderAt("/projects/p/chat");
    await screen.findByText("Deploy pipeline");

    fireEvent.change(screen.getByRole("textbox", { name: /Search chats/i }), {
      target: { value: "bug" },
    });
    expect(screen.getByText("Bug triage")).toBeInTheDocument();
    expect(screen.queryByText("Deploy pipeline")).not.toBeInTheDocument();
    expect(screen.queryByText("Random musings")).not.toBeInTheDocument();
  });

  it("also matches the first-message preview", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" }), threeChats()));
    renderAt("/projects/p/chat");
    await screen.findByText("Deploy pipeline");

    // "deploy" is in "Deploy pipeline"'s name and in "Random musings"'s preview.
    fireEvent.change(screen.getByRole("textbox", { name: /Search chats/i }), {
      target: { value: "deploy" },
    });
    expect(screen.getByText("Deploy pipeline")).toBeInTheDocument();
    expect(screen.getByText("Random musings")).toBeInTheDocument();
    expect(screen.queryByText("Bug triage")).not.toBeInTheDocument();
  });

  it("shows a no-match message and clearing restores the full list", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" }), threeChats()));
    renderAt("/projects/p/chat");
    await screen.findByText("Deploy pipeline");

    const search = screen.getByRole("textbox", { name: /Search chats/i });
    fireEvent.change(search, { target: { value: "zzzzz" } });
    expect(screen.getByText(/No chats match/i)).toBeInTheDocument();
    expect(screen.queryByText("Deploy pipeline")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Clear search/i }));
    expect(screen.getByText("Deploy pipeline")).toBeInTheDocument();
    expect(screen.getByText("Bug triage")).toBeInTheDocument();
    expect(screen.getByText("Random musings")).toBeInTheDocument();
  });

  it("the compact + button starts a new chat", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" }), threeChats()));
    renderAt("/projects/p/chat/s1");
    await waitFor(() => expect(chatPaneProps?.initialSessionId).toBe("s1"));
    fireEvent.click(screen.getByRole("button", { name: /^New Chat$/ }));
    await waitFor(() => expect(chatPaneProps?.initialSessionId ?? "new").toBe("new"));
  });

  // Concurrent-new-chat fusion: while a brand-new chat streams, its establish nav
  // (`/chat` -> `/chat/:id`) may still be in flight, so the route is momentarily
  // session-less. Clicking "New Chat" then navigates to the SAME `/chat` route, so
  // route-driven remounting alone wouldn't reset the (still-streaming) pane — the
  // next message would be queued into that live turn, fusing the two chats. The
  // new-chat nonce must force a genuinely fresh ChatPane instance regardless.
  it("New Chat forces a fresh pane even when the route is already a session-less new chat", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" }), threeChats()));
    renderAt("/projects/p/chat");
    const before = await screen.findByTestId("chat-pane");
    expect(chatPaneProps?.initialSessionId ?? "new").toBe("new");
    fireEvent.click(screen.getByRole("button", { name: /^New Chat$/ }));
    // A remount replaces the DOM node; a mere re-render (the bug) would keep it.
    await waitFor(() => expect(screen.getByTestId("chat-pane")).not.toBe(before));
    expect(chatPaneProps?.initialSessionId ?? "new").toBe("new");
  });
});

describe("ProjectView: archive chats (#95)", () => {
  it("hides the Archived section when no chats are archived", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), { chats: [makeChat({ sessionId: "s1", name: "Active one" })] }),
    );
    renderAt("/projects/p/chat");
    await screen.findByText("Active one");
    expect(screen.queryByRole("button", { name: /^Archived/i })).not.toBeInTheDocument();
  });

  it("archives a chat: it moves into the Archived section and the toggle is persisted", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), { chats: [makeChat({ sessionId: "s1", name: "Filed away" })] }),
    );
    apiFns.archiveProjectChat.mockResolvedValue(undefined);
    renderAt("/projects/p/chat");
    await screen.findByText("Filed away");

    fireEvent.click(screen.getByRole("button", { name: /Archive chat Filed away/i }));
    await waitFor(() => expect(apiFns.archiveProjectChat).toHaveBeenCalledWith("p", "s1", true));

    // The Archived accordion now exists with a count of 1, expanded so the chat
    // is visible, and the row's toggle now reads "Unarchive".
    const archivedHeader = await screen.findByRole("button", { name: /^Archived/i });
    expect(within(archivedHeader).getByText("1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Unarchive chat Filed away/i })).toBeInTheDocument();
  });

  it("partitions current vs. archived chats and unarchives on demand", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [
          makeChat({ sessionId: "s1", name: "Current chat" }),
          makeChat({ sessionId: "s2", name: "Archived chat", archived: true }),
        ],
      }),
    );
    apiFns.archiveProjectChat.mockResolvedValue(undefined);
    renderAt("/projects/p/chat");

    // Header count excludes the archived one; the Archived section shows 1.
    await screen.findByText("Current chat");
    const archivedHeader = screen.getByRole("button", { name: /^Archived/i });
    expect(within(archivedHeader).getByText("1")).toBeInTheDocument();

    // Expand and unarchive it.
    fireEvent.click(archivedHeader);
    fireEvent.click(await screen.findByRole("button", { name: /Unarchive chat Archived chat/i }));
    await waitFor(() => expect(apiFns.archiveProjectChat).toHaveBeenCalledWith("p", "s2", false));
  });

  it("auto-expands the Archived section when the open chat is archived (deep-link)", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [makeChat({ sessionId: "s2", name: "Deep-linked archived", archived: true })],
      }),
    );
    renderAt("/projects/p/chat/s2");
    // Because the active chat is archived, the accordion opens on load so the row
    // (and its Unarchive action) is visible without a click.
    expect(
      await screen.findByRole("button", { name: /Unarchive chat Deep-linked archived/i }),
    ).toBeInTheDocument();
  });
});

// Issue #537: the server computes usage by streaming each transcript end to end,
// so asking for rings the sidebar never shows is real I/O. Archived rings are
// therefore fetched only once the (collapsed-by-default) Archived group opens.
// The failure mode is INVISIBLE — a ring that silently never appears — and three
// separate things open that group, so each one is pinned here.
describe("ProjectView: archived usage rings are fetched lazily (#537)", () => {
  /** Rings keyed by scope, so a test can prove WHICH request filled a ring. */
  const byScope = (
    active: Record<string, { contextTokens: number; contextLimit: number }>,
    archived: Record<string, { contextTokens: number; contextLimit: number }>,
  ) =>
    apiFns.chatUsage.mockImplementation((_slug: unknown, scope?: unknown) =>
      Promise.resolve(scope === "archived" ? archived : active),
    );

  const oneOfEach = () =>
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [
          makeChat({ sessionId: "s1", name: "Current chat" }),
          makeChat({ sessionId: "s2", name: "Archived chat", archived: true }),
        ],
      }),
    );

  it("skips the archived scope on load, then fetches it when the group is expanded", async () => {
    oneOfEach();
    byScope(
      { s1: { contextTokens: 250_000, contextLimit: 1_000_000 } },
      { s2: { contextTokens: 750_000, contextLimit: 1_000_000 } },
    );
    renderAt("/projects/p/chat");

    // The active ring fills from the default (unscoped) request...
    expect(await screen.findByLabelText(/Context 25% full/)).toBeInTheDocument();
    // ...and nothing has asked for the archived half yet.
    expect(apiFns.chatUsage).toHaveBeenCalledWith("p");
    expect(apiFns.chatUsage).not.toHaveBeenCalledWith("p", "archived");

    fireEvent.click(screen.getByRole("button", { name: /^Archived/i }));
    expect(await screen.findByLabelText(/Context 75% full/)).toBeInTheDocument();
    // Merge, not replace: the active ring must survive the archived fetch (#164).
    expect(screen.getByLabelText(/Context 25% full/)).toBeInTheDocument();
  });

  it("fetches archived usage when a deep-link auto-expands the group", async () => {
    oneOfEach();
    byScope({}, { s2: { contextTokens: 750_000, contextLimit: 1_000_000 } });
    // No click anywhere: the group opens because the OPEN chat is archived. This
    // is precisely the case where a user went looking for an archived chat, so a
    // blank ring here would be the worst version of the bug.
    renderAt("/projects/p/chat/s2");
    expect(await screen.findByLabelText(/Context 75% full/)).toBeInTheDocument();
  });

  it("fetches archived usage when archiving a chat opens the group", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), { chats: [makeChat({ sessionId: "s1", name: "Filed away" })] }),
    );
    apiFns.archiveProjectChat.mockResolvedValue(undefined);
    byScope({}, { s1: { contextTokens: 500_000, contextLimit: 1_000_000 } });
    renderAt("/projects/p/chat");
    await screen.findByText("Filed away");

    fireEvent.click(screen.getByRole("button", { name: /Archive chat Filed away/i }));
    // archiveChat force-opens the group; the ring must follow it there.
    await waitFor(() => expect(apiFns.chatUsage).toHaveBeenCalledWith("p", "archived"));
    expect(await screen.findByLabelText(/Context 50% full/)).toBeInTheDocument();
  });
});

describe("ProjectView: sidebar counts are chat counts, not root counts (#491)", () => {
  it("the search badge counts the chats shown, not the roots", async () => {
    // Two matches nested under one non-matching parent, plus an unrelated chat.
    // The parent is kept as scaffolding (withAncestors) so the hits render in
    // place, so three rows show out of four chats. Reading `.length` off the
    // roots array reported `1/4`.
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [
          makeChat({ sessionId: "root", name: "Manager" }),
          makeChat({
            sessionId: "c1",
            name: "Deploy alpha",
            parent: { project: "p", sessionId: "root" },
          }),
          makeChat({
            sessionId: "c2",
            name: "Deploy bravo",
            parent: { project: "p", sessionId: "root" },
          }),
          makeChat({ sessionId: "other", name: "Unrelated" }),
        ],
      }),
    );
    renderAt("/projects/p/chat");
    await screen.findByText("Manager");

    fireEvent.change(screen.getByRole("textbox", { name: /Search chats/i }), {
      target: { value: "deploy" },
    });
    expect(screen.getByText("Deploy alpha")).toBeInTheDocument();
    expect(screen.getByText("Deploy bravo")).toBeInTheDocument();
    expect(screen.queryByText("Unrelated")).not.toBeInTheDocument();
    expect(screen.getByText("3/4")).toBeInTheDocument();
  });

  it("the Archived badge counts nested archived chats too", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [
          makeChat({ sessionId: "a1", name: "Archived parent", archived: true }),
          makeChat({
            sessionId: "a2",
            name: "Archived child",
            archived: true,
            parent: { project: "p", sessionId: "a1" },
          }),
        ],
      }),
    );
    renderAt("/projects/p/chat");
    const archivedHeader = await screen.findByRole("button", { name: /^Archived/i });
    // One archived root with one archived child is TWO archived chats.
    expect(within(archivedHeader).getByText("2")).toBeInTheDocument();
  });
});

describe("ProjectView: running filter + view options", () => {
  /** Drive the WS running-turn set, like `chat:active` frames arriving. */
  const setRunning = (...ids: string[]) => act(() => activeCb!(new Set(ids)));

  const runningToggle = () => screen.getByRole("button", { name: /Show only running chats/i });
  const twisty = (name: string) =>
    screen.queryByRole("button", { name: new RegExp(`(Collapse|Expand).*under ${name}`, "i") });

  /** Parent + child + an unrelated idle chat. */
  function threeChats() {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [
          makeChat({ sessionId: "parent", name: "Manager" }),
          makeChat({
            sessionId: "child",
            name: "Spawned worker",
            parent: { project: "p", sessionId: "parent" },
          }),
          makeChat({ sessionId: "idle", name: "Idle chat" }),
        ],
      }),
    );
  }

  it("stays a plain count while nothing is running", async () => {
    threeChats();
    renderAt("/projects/p/chat");
    await screen.findByText("Manager");
    expect(screen.getByTitle("3 chats")).toHaveTextContent("3");
    // No split, so no filter control at all — an idle project sees no new UI.
    expect(screen.queryByRole("button", { name: /Show only running chats/i })).toBeNull();
  });

  it("splits into total + running the moment a turn goes live", async () => {
    threeChats();
    renderAt("/projects/p/chat");
    await screen.findByText("Manager");

    setRunning("parent", "child");
    const toggle = runningToggle();
    expect(within(toggle).getByText("2")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    // The left half still carries the unfiltered total.
    expect(screen.getByRole("button", { name: /^3 chats$/i })).toBeInTheDocument();
  });

  it("filters to the running chats, and renders them FLAT", async () => {
    threeChats();
    renderAt("/projects/p/chat");
    await screen.findByText("Manager");

    // Nested to begin with: the child sits under its parent behind a twisty.
    expect(twisty("Manager")).toBeInTheDocument();

    setRunning("parent", "child");
    fireEvent.click(runningToggle());

    // Both running chats survive; the idle one is gone.
    expect(screen.getByText("Manager")).toBeInTheDocument();
    expect(screen.getByText("Spawned worker")).toBeInTheDocument();
    expect(screen.queryByText("Idle chat")).toBeNull();
    // And they are SIBLINGS now. This is the case naive filtering gets wrong:
    // both are running, so a tree build would still nest the child under the
    // parent and re-introduce the indentation the filter exists to remove.
    expect(twisty("Manager")).toBeNull();
    expect(runningToggle()).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the OPEN chat pinned when its turn finishes", async () => {
    threeChats();
    renderAt("/projects/p/chat/idle");
    await screen.findByText("Manager");

    setRunning("parent", "idle");
    fireEvent.click(runningToggle());
    expect(screen.getByText("Idle chat")).toBeInTheDocument();

    // `idle` stops running. Without the pin, the chat being read would vanish
    // from the sidebar mid-read.
    setRunning("parent");
    expect(screen.getByText("Idle chat")).toBeInTheDocument();
    expect(screen.queryByText("Spawned worker")).toBeNull();
  });

  it("explains an empty running view and offers the way back", async () => {
    threeChats();
    renderAt("/projects/p/chat");
    await screen.findByText("Manager");

    setRunning("parent");
    fireEvent.click(runningToggle());
    expect(screen.queryByText("Idle chat")).toBeNull();

    // The last turn ends: the filter is still on, and the list is now empty.
    setRunning();
    expect(screen.getByText(/No chats are running/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Show all chats/i }));
    expect(screen.getByText("Idle chat")).toBeInTheDocument();
    expect(screen.queryByText(/No chats are running/i)).toBeNull();
  });

  it("hides the Archived accordion and lists a running archived chat inline", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [
          makeChat({ sessionId: "live", name: "Live one" }),
          // Deliberately NOT named "Archived …": the row button's accessible
          // name is its title, which would collide with the accordion header.
          makeChat({ sessionId: "old", name: "Filed away runner", archived: true }),
        ],
      }),
    );
    renderAt("/projects/p/chat");
    await screen.findByText("Live one");
    expect(screen.getByRole("button", { name: /^Archived/i })).toBeInTheDocument();

    // An archived chat with a live turn is still running, so it belongs in the
    // one flat list rather than folded away where the filter can't show it.
    setRunning("live", "old");
    fireEvent.click(runningToggle());
    expect(screen.getByText("Filed away runner")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Archived/i })).toBeNull();
  });

  it("composes with search instead of fighting it", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [
          makeChat({ sessionId: "parent", name: "Manager" }),
          makeChat({
            sessionId: "c1",
            name: "Deploy alpha",
            parent: { project: "p", sessionId: "parent" },
          }),
          makeChat({ sessionId: "c2", name: "Deploy bravo" }),
        ],
      }),
    );
    renderAt("/projects/p/chat");
    await screen.findByText("Manager");

    setRunning("c1", "c2");
    fireEvent.click(runningToggle());
    fireEvent.change(screen.getByRole("textbox", { name: /Search chats/i }), {
      target: { value: "alpha" },
    });

    expect(screen.getByText("Deploy alpha")).toBeInTheDocument();
    expect(screen.queryByText("Deploy bravo")).toBeNull();
    // `Manager` is `Deploy alpha`'s parent, and search normally keeps ancestors
    // as scaffolding. Here it must NOT — an idle parent dragged back in would
    // defeat the running filter.
    expect(screen.queryByText("Manager")).toBeNull();
  });

  it("remembers the filter globally, with no slug in the key", async () => {
    threeChats();
    renderAt("/projects/p/chat");
    await screen.findByText("Manager");
    setRunning("parent");
    fireEvent.click(runningToggle());
    expect(localStorage.getItem("paddock:chatView:runningOnly")).toBe("1");
  });

  it("does not collide with the mobile drawer's 'Show chats' button", async () => {
    // The layout toggle was first labelled "Show chats as a flat list", which
    // made `getByRole("button", { name: /Show chats/i })` ambiguous — the mobile
    // journey taps that to open the session drawer, and it broke. Two controls
    // whose accessible names start the same way is a real a11y problem, not just
    // a locator one, so the guard lives here rather than in the E2E spec.
    threeChats();
    renderAt("/projects/p/chat");
    await screen.findByText("Manager");
    expect(screen.getAllByRole("button", { name: /Show chats/i })).toHaveLength(1);
  });

  it("toggles the chat tree between nested and flat, and remembers it", async () => {
    threeChats();
    const first = renderAt("/projects/p/chat");
    await screen.findByText("Manager");
    expect(twisty("Manager")).toBeInTheDocument();

    // One button, labelled with the layout it will switch TO — the same
    // convention as the theme toggle in AppShell.
    fireEvent.click(screen.getByRole("button", { name: /Switch to a flat chat list/i }));

    expect(twisty("Manager")).toBeNull();
    expect(screen.getByText("Spawned worker")).toBeInTheDocument();
    expect(localStorage.getItem("paddock:chatView:nested")).toBe("0");
    // Now it offers the way back.
    expect(screen.getByRole("button", { name: /Switch to a nested chat list/i })).toBeInTheDocument();

    // Sticky across a remount.
    first.unmount();
    renderAt("/projects/p/chat");
    await screen.findByText("Manager");
    expect(twisty("Manager")).toBeNull();
    expect(screen.getByRole("button", { name: /Switch to a nested chat list/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("forces flat while filtering to running, without clobbering the preference", async () => {
    threeChats();
    renderAt("/projects/p/chat");
    await screen.findByText("Manager");

    setRunning("parent", "child");
    fireEvent.click(runningToggle());
    // Disabled rather than silently disagreeing with the list: offering "switch
    // to flat" while the list is ALREADY flat would misreport the state.
    const layout = screen.getByRole("button", { name: /Switch to a flat chat list/i });
    expect(layout).toBeDisabled();
    expect(layout).toHaveAttribute("aria-pressed", "true");

    // ...and the nesting comes straight back when the filter comes off.
    fireEvent.click(screen.getByRole("button", { name: /^Show all 3 chats$/i }));
    expect(twisty("Manager")).toBeInTheDocument();
    expect(localStorage.getItem("paddock:chatView:nested")).toBeNull();
  });
});

describe("ProjectView: star chats (#373)", () => {
  // True when `first`'s title appears before `second`'s in document order.
  const isBefore = (first: string, second: string) =>
    !!(
      screen.getByText(first).compareDocumentPosition(screen.getByText(second)) &
      Node.DOCUMENT_POSITION_FOLLOWING
    );

  it("stars a chat: pins it to the top and the toggle flips to Unstar", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [
          makeChat({ sessionId: "s1", name: "Alpha" }),
          makeChat({ sessionId: "s2", name: "Bravo" }),
        ],
      }),
    );
    apiFns.starProjectChat.mockResolvedValue(undefined);
    renderAt("/projects/p/chat");
    await screen.findByText("Alpha");
    // Server order: Alpha before Bravo.
    expect(isBefore("Alpha", "Bravo")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Star chat Bravo/i }));
    await waitFor(() => expect(apiFns.starProjectChat).toHaveBeenCalledWith("p", "s2", true));

    // Bravo is now starred → it floats to the top (before Alpha), and its toggle
    // reads "Unstar".
    await waitFor(() => expect(isBefore("Bravo", "Alpha")).toBe(true));
    expect(screen.getByRole("button", { name: /Unstar chat Bravo/i })).toBeInTheDocument();
  });

  it("renders starred chats at the top of the active list (from the server flag)", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [
          makeChat({ sessionId: "s1", name: "Alpha" }),
          makeChat({ sessionId: "s2", name: "Bravo", starred: true }),
          makeChat({ sessionId: "s3", name: "Charlie" }),
        ],
      }),
    );
    renderAt("/projects/p/chat");
    await screen.findByText("Alpha");
    // Bravo (starred) pinned to top; Alpha/Charlie keep their relative order.
    expect(isBefore("Bravo", "Alpha")).toBe(true);
    expect(isBefore("Alpha", "Charlie")).toBe(true);
  });

  it("floats starred chats to the top of the Archived section", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [
          makeChat({ sessionId: "a1", name: "OldArchived", archived: true }),
          makeChat({ sessionId: "a2", name: "PinnedArchived", archived: true, starred: true }),
        ],
      }),
    );
    renderAt("/projects/p/chat");
    // Expand the Archived accordion, then assert the starred one is on top.
    fireEvent.click(await screen.findByRole("button", { name: /^Archived/i }));
    await screen.findByText("PinnedArchived");
    expect(isBefore("PinnedArchived", "OldArchived")).toBe(true);
  });
});

describe("ProjectView: unread affordance (#160)", () => {
  const FUTURE = "2999-01-01T00:00:00.000Z"; // always newer than lastSeen(0)

  // The row <button> that wraps a chat's title (the unread dot lives inside it).
  function rowButton(name: string): HTMLElement {
    return screen.getByText(name).closest("button") as HTMLElement;
  }

  it("shows the unread cue for a chat whose last turn completed after lastSeen", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [makeChat({ sessionId: "s1", name: "Away chat", lastTurnCompletedAt: FUTURE })],
      }),
    );
    // A session-less new chat is open, so "Away chat" is NOT the focused chat.
    renderAt("/projects/p/chat");
    await screen.findByText("Away chat");
    expect(within(rowButton("Away chat")).getByLabelText("Unread reply")).toBeInTheDocument();
  });

  it("never shows the unread cue for the currently-open chat", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [makeChat({ sessionId: "s1", name: "Open chat", lastTurnCompletedAt: FUTURE })],
      }),
    );
    renderAt("/projects/p/chat/s1"); // s1 IS the focused chat
    await screen.findByText("Open chat");
    expect(within(rowButton("Open chat")).queryByLabelText("Unread reply")).not.toBeInTheDocument();
  });

  it("does not show the cue once lastSeen is newer than the completed turn", async () => {
    // Seen-ness comes from the SERVER DTO (#189/#488) — there is no local mirror.
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [
          makeChat({
            sessionId: "s1",
            name: "Seen chat",
            lastTurnCompletedAt: FUTURE,
            lastSeen: Date.parse(FUTURE) + 1,
          }),
        ],
      }),
    );
    renderAt("/projects/p/chat");
    await screen.findByText("Seen chat");
    expect(within(rowButton("Seen chat")).queryByLabelText("Unread reply")).not.toBeInTheDocument();
  });

  it("opening an unread chat clears its cue", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [makeChat({ sessionId: "s1", name: "Click me", lastTurnCompletedAt: FUTURE })],
      }),
    );
    renderAt("/projects/p/chat");
    await screen.findByText("Click me");
    expect(within(rowButton("Click me")).getByLabelText("Unread reply")).toBeInTheDocument();

    fireEvent.click(rowButton("Click me"));
    await waitFor(() => expect(chatPaneProps?.initialSessionId).toBe("s1"));
    // Now the focused chat — cue gone (and lastSeen persisted).
    expect(within(rowButton("Click me")).queryByLabelText("Unread reply")).not.toBeInTheDocument();
  });

  it("flags a NON-focused chat unread live when its turn completes (running-set transition)", async () => {
    // No server timestamp — the live turn-complete event is the only signal.
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [makeChat({ sessionId: "s1", name: "Streaming chat" })],
      }),
    );
    renderAt("/projects/p/chat"); // a new chat is open, so s1 is not focused
    await screen.findByText("Streaming chat");
    expect(within(rowButton("Streaming chat")).queryByLabelText("Unread reply")).not.toBeInTheDocument();

    // s1's turn starts, then completes: it leaves the running set → unread.
    await act(async () => activeCb!(new Set(["s1"])));
    await act(async () => activeCb!(new Set()));
    expect(within(rowButton("Streaming chat")).getByLabelText("Unread reply")).toBeInTheDocument();
  });
});

describe("ProjectView: delete project", () => {
  it("deletes the project and navigates back to the grid", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p", name: "Goner" })));
    apiFns.deleteProject.mockResolvedValue(undefined);
    renderAt("/projects/p/chat");
    await screen.findByRole("heading", { name: "Goner" });
    // Open the project menu, then Delete.
    fireEvent.click(screen.getByRole("button", { name: /Project actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete project/i }));
    // The ConfirmDialog's confirm button is also "Delete project" — pick the one
    // inside the dialog (role=button, not menuitem; the menu has closed anyway).
    fireEvent.click(await screen.findByRole("button", { name: /^Delete project$/i }));
    await waitFor(() => expect(apiFns.deleteProject).toHaveBeenCalledWith("p"));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("p"));
    expect(await screen.findByText("GRID")).toBeInTheDocument();
  });
});

describe("ProjectView: pending new chat (issue #36)", () => {
  it("shows a pending sidebar entry when a new chat starts streaming, then reconciles on completion", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    renderAt("/projects/p/chat");
    await screen.findByTestId("chat-pane");

    // The new chat learns its session id mid-stream (before the turn completes).
    await act(async () => {
      chatPaneProps!.onSessionStarted!("sess-new");
    });

    // A real, clickable pending entry appears immediately (the pre-send
    // placeholder is a plain div; the pending entry is a button). Match the
    // ellipsis form so it isn't confused with the header's "New Chat" action.
    expect(await screen.findByRole("button", { name: /New chat…/ })).toBeInTheDocument();

    // The turn completes and the server list now carries the chat's real name.
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [makeChat({ sessionId: "sess-new", name: "Curated name" })],
      }),
    );
    await act(async () => {
      chatPaneProps!.onTurnComplete!();
    });

    // The optimistic entry reconciles into the real list entry.
    expect(await screen.findByText("Curated name")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New chat…/ })).not.toBeInTheDocument();
  });
});

describe("ProjectView: new-chat ring seeds from live usage (#164)", () => {
  it("shows a brand-new chat's context ring from the turn-complete frame even when the disk usage read omits it", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    // The disk-derived usage endpoint omits the brand-new session (the read
    // race the ticket describes): it never yields an entry for it, so the ring
    // used to stay blank until a full page reload.
    apiFns.chatUsage.mockResolvedValue({});
    renderAt("/projects/p/chat");
    await screen.findByTestId("chat-pane");

    // The turn completes: the server list now carries the new chat, and the
    // pane hands up the live per-turn usage from the chat:complete frame.
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [makeChat({ sessionId: "sess-new", name: "Fresh chat" })],
      }),
    );
    await act(async () => {
      chatPaneProps!.onTurnComplete!({
        sessionId: "sess-new",
        usage: {
          inputTokens: 100_000,
          outputTokens: 20_000,
          cacheReadTokens: 200_000,
          cacheCreationTokens: 0,
          contextTokens: 300_000,
          contextLimit: 1_000_000,
        },
      });
    });

    // The ring renders immediately from the live seed (300k/1M = 30%), without
    // a reload, even though chatUsage returned nothing for this session.
    expect(await screen.findByLabelText(/Context 30% full/)).toBeInTheDocument();
  });
});

describe("ProjectView: in-flight chat visibility (#100)", () => {
  it("pulls the chat list when a running session isn't listed yet, then shows it", async () => {
    // Load a project with no chats.
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    renderAt("/projects/p/chat");
    await screen.findByTestId("chat-pane");
    // The mount fires onActiveSessions with an empty set — no refetch yet.
    expect(apiFns.listProjectChats).not.toHaveBeenCalled();

    // A chat starts streaming (e.g. from another tab) whose id isn't in the list.
    // The server now attributes/ lists it, so ProjectView refetches and renders it.
    apiFns.listProjectChats.mockResolvedValue([
      makeChat({ sessionId: "s-running", name: "Long running chat" }),
    ]);
    await act(async () => {
      activeCb!(new Set(["s-running"]));
    });
    await waitFor(() => expect(apiFns.listProjectChats).toHaveBeenCalled());
    expect(await screen.findByText("Long running chat")).toBeInTheDocument();

    // A repeat broadcast of the SAME running id does not trigger another refetch
    // (the seen-set guards against a refetch loop).
    apiFns.listProjectChats.mockClear();
    await act(async () => {
      activeCb!(new Set(["s-running"]));
    });
    expect(apiFns.listProjectChats).not.toHaveBeenCalled();
  });

  it("does not refetch for a running session already in the list", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [makeChat({ sessionId: "s-known", name: "Known chat" })],
      }),
    );
    renderAt("/projects/p/chat");
    await screen.findByText("Known chat");

    // The already-listed chat starts a turn — nothing to pull, so no refetch.
    await act(async () => {
      activeCb!(new Set(["s-known"]));
    });
    expect(apiFns.listProjectChats).not.toHaveBeenCalled();
  });
});

/**
 * Subtree (Shift-click) chat actions + detach (#508).
 *
 * A family: Manager with two children, one of which has a child of its own — so
 * every assertion here also proves the walk is RECURSIVE rather than one level
 * deep, which is the failure mode nobody would notice until a grandchild
 * survived a delete that promised to take it.
 */
describe("ProjectView: subtree chat actions (#508)", () => {
  const family = () => [
    makeChat({ sessionId: "mgr", name: "Manager" }),
    makeChat({ sessionId: "c1", name: "Child one", parent: { project: "p", sessionId: "mgr" } }),
    makeChat({ sessionId: "c2", name: "Child two", parent: { project: "p", sessionId: "mgr" } }),
    makeChat({ sessionId: "g1", name: "Grandchild", parent: { project: "p", sessionId: "c1" } }),
    makeChat({ sessionId: "solo", name: "Unrelated" }),
  ];

  const renderFamily = async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), { chats: family() }),
    );
    renderAt("/projects/p/chat");
    await screen.findByText("Manager");
  };

  it("plain-clicking archive still affects only that chat", async () => {
    await renderFamily();
    apiFns.archiveProjectChat.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: /Archive chat Manager/i }));
    await waitFor(() => expect(apiFns.archiveProjectChat).toHaveBeenCalledWith("p", "mgr", true));
    expect(apiFns.archiveProjectChats).not.toHaveBeenCalled();
  });

  it("shift-clicking archive takes the whole family, grandchild included", async () => {
    await renderFamily();
    apiFns.archiveProjectChats.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: /Archive chat Manager/i }), {
      shiftKey: true,
    });
    await waitFor(() => expect(apiFns.archiveProjectChats).toHaveBeenCalled());
    const [slug, ids, archived] = apiFns.archiveProjectChats.mock.calls[0] as [
      string,
      string[],
      boolean,
    ];
    expect(slug).toBe("p");
    expect(archived).toBe(true);
    expect([...ids].sort()).toEqual(["c1", "c2", "g1", "mgr"]);
    // The unrelated chat is untouched, and all four moved together.
    const archivedHeader = await screen.findByRole("button", { name: /^Archived/i });
    expect(within(archivedHeader).getByText("4")).toBeInTheDocument();
    expect(screen.getByText("Unrelated")).toBeInTheDocument();
  });

  it("rolls the whole family back when the batch archive fails", async () => {
    await renderFamily();
    apiFns.archiveProjectChats.mockRejectedValue(new Error("nope"));
    fireEvent.click(screen.getByRole("button", { name: /Archive chat Manager/i }), {
      shiftKey: true,
    });
    // One call, one undo: nothing is left archived, so the family can't be torn.
    await screen.findByText("nope");
    expect(screen.queryByRole("button", { name: /^Archived/i })).toBeNull();
  });

  it("shift-clicking a LEAF behaves exactly like a plain click", async () => {
    await renderFamily();
    apiFns.archiveProjectChat.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: /Archive chat Unrelated/i }), {
      shiftKey: true,
    });
    await waitFor(() => expect(apiFns.archiveProjectChat).toHaveBeenCalledWith("p", "solo", true));
    expect(apiFns.archiveProjectChats).not.toHaveBeenCalled();
  });

  it("shift-clicking mark-unread flags the whole family", async () => {
    await renderFamily();
    apiFns.markChatsUnread.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: /Mark chat Manager unread/i }), {
      shiftKey: true,
    });
    await waitFor(() => expect(apiFns.markChatsUnread).toHaveBeenCalled());
    const [, ids, unread] = apiFns.markChatsUnread.mock.calls[0] as [string, string[], boolean];
    expect([...ids].sort()).toEqual(["c1", "c2", "g1", "mgr"]);
    expect(unread).toBe(true);
  });

  it("announces the subtree in the tooltip and the accessible name", async () => {
    await renderFamily();
    // Shift-click is invisible otherwise. The count is the TOTAL the action
    // affects (the chat plus its 3 descendants), not the descendant count alone —
    // "archive all 3" while archiving four would be a lie.
    const archive = screen.getByRole("button", { name: /Archive chat Manager/i });
    expect(archive).toHaveAccessibleName(/Shift-click to archive all 4/i);
    fireEvent.focus(archive);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Shift-click to archive all 4");
    // The count sits mid-phrase for read/unread, which is why the hint is a
    // completed phrase rather than a "<verb> all <n>" template.
    expect(
      screen.getByRole("button", { name: /Mark chat Manager unread/i }),
    ).toHaveAccessibleName(/Shift-click to mark all 4 unread/i);
    // A childless row promises nothing.
    expect(screen.getByRole("button", { name: /Archive chat Unrelated/i })).toHaveAccessibleName(
      "Archive chat Unrelated",
    );
  });

  describe("count-aware delete confirmation", () => {
    it("names the count and deletes the whole subtree", async () => {
      await renderFamily();
      apiFns.deleteProjectChats.mockResolvedValue({
        removed: ["mgr", "c1", "c2", "g1"],
        failed: [],
      });
      fireEvent.click(screen.getByRole("button", { name: /Delete chat Manager/i }), {
        shiftKey: true,
      });
      // The dialog must say what it is about to destroy — those chats may not
      // even be on screen (a collapsed parent hides them) and there is no undo.
      expect(await screen.findByText("Delete 4 chats?")).toBeInTheDocument();
      expect(screen.getByText(/and its 3 nested chats/i)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /^Delete 4 chats$/i }));
      await waitFor(() => expect(apiFns.deleteProjectChats).toHaveBeenCalled());
      const [slug, ids] = apiFns.deleteProjectChats.mock.calls[0] as [string, string[]];
      expect(slug).toBe("p");
      expect([...ids].sort()).toEqual(["c1", "c2", "g1", "mgr"]);
      await waitFor(() => expect(screen.queryByText("Manager")).toBeNull());
      expect(screen.getByText("Unrelated")).toBeInTheDocument();
    });

    it("keeps the single-chat copy for a plain click", async () => {
      await renderFamily();
      fireEvent.click(screen.getByRole("button", { name: /Delete chat Manager/i }));
      expect(await screen.findByText("Delete chat?")).toBeInTheDocument();
      // No subtree DELETION copy. (The dialog does still mention the nested
      // chats — to say they survive and are moved to the top level — which is a
      // different sentence and covered by its own test below.)
      expect(screen.queryByText(/will be permanently removed — their transcripts/i)).toBeNull();
      expect(screen.queryByRole("button", { name: /^Delete \d+ chats$/i })).toBeNull();
    });

    it("singularises for a one-child family", async () => {
      apiFns.getProjectDetail.mockResolvedValue(
        detail(makeProject({ slug: "p" }), {
          chats: [
            makeChat({ sessionId: "mgr", name: "Manager" }),
            makeChat({
              sessionId: "c1",
              name: "Only child",
              parent: { project: "p", sessionId: "mgr" },
            }),
          ],
        }),
      );
      renderAt("/projects/p/chat");
      await screen.findByText("Manager");
      fireEvent.click(screen.getByRole("button", { name: /Delete chat Manager/i }), {
        shiftKey: true,
      });
      expect(await screen.findByText("Delete 2 chats?")).toBeInTheDocument();
      expect(screen.getByText(/and its 1 nested chat will be/i)).toBeInTheDocument();
    });

    it("keeps a chat the server could NOT delete in the list, and says so", async () => {
      await renderFamily();
      apiFns.deleteProjectChats.mockResolvedValue({
        removed: ["mgr", "c1", "c2"],
        failed: ["g1"],
      });
      fireEvent.click(screen.getByRole("button", { name: /Delete chat Manager/i }), {
        shiftKey: true,
      });
      fireEvent.click(await screen.findByRole("button", { name: /^Delete 4 chats$/i }));
      // A half-succeeded delete is reported rather than silently rendered as a
      // clean sweep — the surviving transcript is still on disk.
      expect(await screen.findByText(/Deleted 3 of 4 chats/i)).toBeInTheDocument();
    });
  });

  describe("detach from parent", () => {
    it("promotes a child to the top level, keeping its own subtree", async () => {
      await renderFamily();
      apiFns.detachProjectChat.mockResolvedValue(undefined);
      // "Child one" renders nested and owns a grandchild.
      fireEvent.click(screen.getByRole("button", { name: /Detach chat Child one/i }));
      await waitFor(() =>
        expect(apiFns.detachProjectChat).toHaveBeenCalledWith("p", "c1", true),
      );
      // It is a root now, so Manager's remaining family is smaller — but the
      // grandchild travelled with it rather than scattering to the top level.
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: /Detach chat Child one/i }),
        ).toBeNull(),
      );
      expect(screen.getByRole("button", { name: /Detach chat Grandchild/i })).toBeInTheDocument();
      expect(screen.getByText("Grandchild")).toBeInTheDocument();
    });

    it("offers no detach on a chat that already renders at the top level", async () => {
      await renderFamily();
      expect(screen.queryByRole("button", { name: /Detach chat Manager/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /Detach chat Unrelated/i })).toBeNull();
    });

    it("restores the nesting when the detach call fails", async () => {
      await renderFamily();
      apiFns.detachProjectChat.mockRejectedValue(new Error("detach failed"));
      fireEvent.click(screen.getByRole("button", { name: /Detach chat Child one/i }));
      await screen.findByText("detach failed");
    });
  });
});

/**
 * Review follow-ups (#508): the two paths that weren't exercised live.
 */
describe("ProjectView: subtree mark-read rollback + delete disclosure (#508)", () => {
  const family = () => [
    makeChat({ sessionId: "mgr", name: "Manager", unread: true }),
    makeChat({
      sessionId: "c1",
      name: "Child one",
      unread: true,
      parent: { project: "p", sessionId: "mgr" },
    }),
    makeChat({ sessionId: "c2", name: "Child two", parent: { project: "p", sessionId: "mgr" } }),
    makeChat({ sessionId: "g1", name: "Grandchild", parent: { project: "p", sessionId: "c1" } }),
  ];

  const unreadCount = () => document.querySelectorAll('[data-unread="true"]').length;

  it("restores every unread cue when the batch mark-read fails", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), { chats: family() }),
    );
    apiFns.markChatsUnread.mockRejectedValue(new Error("nope"));
    renderAt("/projects/p/chat");
    await screen.findByText("Manager");
    expect(unreadCount()).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: /Mark chat Manager read/i }), {
      shiftKey: true,
    });
    await waitFor(() => expect(apiFns.markChatsUnread).toHaveBeenCalled());

    // The optimistic clear touched THREE things (lastSeen, the manual `unread`
    // flag, and the live-unread set). Rolling back only lastSeen — the original
    // bug — left the family reading as read forever, because nothing polls.
    await waitFor(() => expect(unreadCount()).toBe(2));
    expect(
      screen.getByRole("button", { name: /Mark chat Manager read/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Mark chat Child one read/i })).toBeInTheDocument();
    // The chat that was NOT flagged must not acquire a cue from the rollback.
    expect(screen.getByRole("button", { name: /Mark chat Child two unread/i })).toBeInTheDocument();
  });

  it("keeps the cues cleared when the batch mark-read succeeds", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), { chats: family() }),
    );
    apiFns.markChatsUnread.mockResolvedValue(undefined);
    renderAt("/projects/p/chat");
    await screen.findByText("Manager");
    expect(unreadCount()).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: /Mark chat Manager read/i }), {
      shiftKey: true,
    });
    await waitFor(() => expect(unreadCount()).toBe(0));
  });

  describe("delete dialog discloses the chats it will ORPHAN", () => {
    it("names them on a plain delete of a parent", async () => {
      apiFns.getProjectDetail.mockResolvedValue(
        detail(makeProject({ slug: "p" }), { chats: family() }),
      );
      renderAt("/projects/p/chat");
      await screen.findByText("Manager");
      fireEvent.click(screen.getByRole("button", { name: /Delete chat Manager/i }));
      // Deleting Manager alone re-homes all three descendants to the top level.
      // Silently, before this — an irreversible action restructuring the list.
      expect(await screen.findByText(/3 other nested chats will be kept/i)).toBeInTheDocument();
    });

    it("says nothing when the subtree delete takes the whole family", async () => {
      apiFns.getProjectDetail.mockResolvedValue(
        detail(makeProject({ slug: "p" }), { chats: family() }),
      );
      renderAt("/projects/p/chat");
      await screen.findByText("Manager");
      fireEvent.click(screen.getByRole("button", { name: /Delete chat Manager/i }), {
        shiftKey: true,
      });
      expect(await screen.findByText("Delete 4 chats?")).toBeInTheDocument();
      expect(screen.queryByText(/will be kept and moved/i)).toBeNull();
    });

    it("counts the survivors when a SEARCH has narrowed the subtree", async () => {
      // The reviewer's case: a query matches 1 of Manager's 3 descendants, so a
      // shift-delete takes 2 chats and orphans the other 2. Accurate about what
      // it deletes, but silent about the restructuring — until now.
      apiFns.getProjectDetail.mockResolvedValue(
        detail(makeProject({ slug: "p" }), { chats: family() }),
      );
      renderAt("/projects/p/chat");
      await screen.findByText("Manager");
      fireEvent.change(screen.getByRole("textbox", { name: /Search chats/i }), {
        target: { value: "Child one" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Delete chat Manager/i }), {
        shiftKey: true,
      });
      expect(await screen.findByText("Delete 2 chats?")).toBeInTheDocument();
      expect(screen.getByText(/and its 1 nested chat will be/i)).toBeInTheDocument();
      expect(screen.getByText(/2 other nested chats will be kept/i)).toBeInTheDocument();
    });

    it("ignores descendants in the OTHER population", async () => {
      // An archived child of an active parent already renders as a root in the
      // Archived tree, so deleting the parent doesn't re-home it — counting it
      // as orphaned would be noise.
      apiFns.getProjectDetail.mockResolvedValue(
        detail(makeProject({ slug: "p" }), {
          chats: [
            makeChat({ sessionId: "mgr", name: "Manager" }),
            makeChat({
              sessionId: "c1",
              name: "Archived child",
              archived: true,
              parent: { project: "p", sessionId: "mgr" },
            }),
          ],
        }),
      );
      renderAt("/projects/p/chat");
      await screen.findByText("Manager");
      fireEvent.click(screen.getByRole("button", { name: /Delete chat Manager/i }));
      expect(await screen.findByText("Delete chat?")).toBeInTheDocument();
      expect(screen.queryByText(/will be kept and moved/i)).toBeNull();
    });
  });
});

/**
 * Row action-count class (#508 review follow-up). The hover action strip is
 * absolutely positioned over the timestamp, so a narrow sidebar has the icons
 * land on top of it — measured at 44px of overlap on an 8-icon root row.
 *
 * The fix is a pure-CSS container query (see `.chat-row` in index.css), which
 * jsdom can't evaluate. What IS testable, and what the stylesheet depends on, is
 * that each row declares how many icons its strip holds — if that count drifts
 * from the buttons actually rendered, the CSS silently picks the wrong
 * threshold and the overlap comes back.
 */
describe("ProjectView: chat row declares its action count (#508)", () => {
  const rowFor = (name: string) => {
    const title = screen.getByText(name);
    return title.closest(".chat-row") as HTMLElement;
  };
  /** The count the stylesheet will use, read off the row's class. */
  const declaredCount = (row: HTMLElement) =>
    Number(row.className.match(/chat-row--actions-(\d+)/)?.[1]);
  /**
   * The count actually rendered IN THE STRIP. Deliberately not every button in
   * the row: a parent also renders a collapse twisty, which sits in the left
   * gutter and has nothing to do with how wide the strip is.
   */
  const actualCount = (row: HTMLElement) =>
    row.querySelector("div[class*=absolute]")!.querySelectorAll("button[aria-label]").length;

  it("matches the buttons rendered on a plain row", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), { chats: [makeChat({ sessionId: "s1", name: "Solo" })] }),
    );
    renderAt("/projects/p/chat");
    await screen.findByText("Solo");
    const row = rowFor("Solo");
    expect(declaredCount(row)).toBe(6);
    expect(actualCount(row)).toBe(6);
  });

  it("counts the Detach action on a nested row", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [
          makeChat({ sessionId: "mgr", name: "Manager" }),
          makeChat({
            sessionId: "c1",
            name: "Child",
            parent: { project: "p", sessionId: "mgr" },
          }),
        ],
      }),
    );
    renderAt("/projects/p/chat");
    await screen.findByText("Manager");
    // The parent is a root — six actions in its strip (its collapse twisty is
    // not one of them). The child renders nested, so it also has Detach, and its
    // strip is one icon wider.
    expect(declaredCount(rowFor("Manager"))).toBe(6);
    expect(actualCount(rowFor("Manager"))).toBe(6);
    expect(declaredCount(rowFor("Child"))).toBe(7);
    expect(actualCount(rowFor("Child"))).toBe(7);
  });

  it("marks every row as a size container", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), { chats: [makeChat({ sessionId: "s1", name: "Solo" })] }),
    );
    renderAt("/projects/p/chat");
    await screen.findByText("Solo");
    // Without `.chat-row` there is no container for the query to resolve against
    // and the timestamp would never hide.
    expect(rowFor("Solo")).toHaveClass("chat-row");
    expect(rowFor("Solo").querySelector(".chat-row-time")).toBeInTheDocument();
  });
});

/**
 * Importing the user's existing Claude Code CLI chats (#588).
 *
 * The load-bearing property here is that the button is gated on a LIVE COUNT and
 * not on a dismissed flag (gotcha #5 on the issue). A dismiss flag passes the
 * happy path identically — click, button goes away — and then never comes back
 * when the user runs more terminal sessions. So the suite asserts both halves:
 * the button vanishes when the re-read count is 0, AND returns when it isn't.
 */
describe("ProjectView: import native CLI chats (#588)", () => {
  /** The sidebar's import row, or null when it isn't offered. */
  const importRow = () => screen.queryByRole("button", { name: /Import \d+ native/i });

  /** One source's worth of offer, in the shape the server really returns. */
  function source(sourceCwd: string, sessionIds: string[]) {
    return {
      sourceCwd,
      sessionIds,
      sessions: sessionIds.map((sessionId, i) => ({
        sessionId,
        mtime: `2026-07-0${(i % 9) + 1}T10:00:00.000Z`,
        preview: `did some work in ${sourceCwd}`,
        sizeBytes: 4096,
      })),
    };
  }

  /** Offer `count` importable sessions on this workspace's first fetch. */
  function offer(count: number, sessionIds = ["n1", "n2"]) {
    apiFns.getAdoptableChats.mockResolvedValue({
      count,
      sources: [source("/home/ed/code/p", sessionIds)],
    });
  }

  /**
   * Do what a user does to import: open the dialog, then confirm it (#660).
   *
   * The click on the sidebar row no longer imports anything by itself, so every
   * test below that cares about the RESULT of an import goes through here.
   */
  async function confirmImport(offered: RegExp) {
    fireEvent.click(await screen.findByRole("button", { name: offered }));
    fireEvent.click(await screen.findByRole("button", { name: /^Import \d+ chat/i }));
  }

  it("does not offer an import when there is nothing to import", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    offer(0, []);
    renderAt("/projects/p/chat");
    await screen.findByText(/No saved chats yet/);
    await waitFor(() => expect(apiFns.getAdoptableChats).toHaveBeenCalledWith("p"));
    expect(importRow()).toBeNull();
  });

  it("labels the button with the live count, singular for one", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    offer(1, ["n1"]);
    renderAt("/projects/p/chat");
    const btn = await screen.findByRole("button", { name: /Import 1 native/i });
    expect(btn).toHaveTextContent("Import 1 native chat");
    // Not "1 native chats" — the plural is derived, so this is the case that
    // catches a hard-coded "s".
    expect(btn).not.toHaveTextContent("chats");
  });

  it("pluralises the label for more than one", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    offer(7);
    renderAt("/projects/p/chat");
    const btn = await screen.findByRole("button", { name: /Import 7 native/i });
    expect(btn).toHaveTextContent("Import 7 native chats");
    // Reachable by its accessible name, not just its visible text.
    expect(btn.getAttribute("aria-label")).toMatch(/Import 7 native Claude Code chats/i);
  });

  it("fetches the count once per workspace open, not on every render", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    offer(3);
    renderAt("/projects/p/chat");
    await screen.findByRole("button", { name: /Import 3 native/i });
    // Drive an unrelated re-render (the running-set socket frame) and prove it
    // did not trigger a second fetch.
    act(() => activeCb?.(new Set(["whatever"])));
    await waitFor(() => expect(apiFns.getAdoptableChats).toHaveBeenCalledTimes(1));
  });

  // The property #660 adds, and the one the old one-click behaviour failed: the
  // click ASKS. On the instance that prompted this the offer was 26 chats the
  // user recognised none of, with no preview and no undo.
  it("asks before importing anything — the click opens a dialog, not a POST", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    offer(2);
    renderAt("/projects/p/chat");
    fireEvent.click(await screen.findByRole("button", { name: /Import 2 native/i }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // Nothing has been imported by opening it.
    expect(apiFns.adoptChats).not.toHaveBeenCalled();
  });

  it("shows what would be imported, and where it came from", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    apiFns.getAdoptableChats.mockResolvedValue({
      count: 2,
      sources: [source("/data/scratch/qa-copy/p", ["n1", "n2"])],
    });
    renderAt("/projects/p/chat");
    fireEvent.click(await screen.findByRole("button", { name: /Import 2 native/i }));
    await screen.findByRole("dialog");

    // The source path is the load-bearing detail: it is what makes "these are
    // from a scratch copy, not my checkout" visible at all (#659).
    expect(screen.getByText("/data/scratch/qa-copy/p")).toBeInTheDocument();
    expect(screen.getAllByText(/did some work in/)).toHaveLength(2);
  });

  it("cancelling imports nothing and leaves the offer standing", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    offer(2);
    renderAt("/projects/p/chat");
    fireEvent.click(await screen.findByRole("button", { name: /Import 2 native/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Cancel$/ }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(apiFns.adoptChats).not.toHaveBeenCalled();
    expect(importRow()).not.toBeNull();
  });

  it("imports only the sessions still ticked", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    offer(2);
    apiFns.adoptChats.mockResolvedValue({ adopted: ["n2"], skipped: [] });
    renderAt("/projects/p/chat");
    fireEvent.click(await screen.findByRole("button", { name: /Import 2 native/i }));
    await screen.findByRole("dialog");

    // Everything starts ticked — the common case is "yes, all of it".
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.every((b) => (b as HTMLInputElement).checked)).toBe(true);

    fireEvent.click(boxes[0]);
    fireEvent.click(screen.getByRole("button", { name: /^Import 1 chat$/i }));
    await waitFor(() =>
      expect(apiFns.adoptChats).toHaveBeenCalledWith("p", { sessionIds: ["n2"] }),
    );
  });

  it("shows 'Importing…' while the import is in flight", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    apiFns.getAdoptableChats
      .mockResolvedValueOnce({ count: 2, sources: [source("/w", ["n1", "n2"])] })
      .mockResolvedValue({ count: 0, sources: [] });
    let release!: (v: { adopted: string[]; skipped: never[] }) => void;
    apiFns.adoptChats.mockReturnValue(
      new Promise<{ adopted: string[]; skipped: never[] }>((res) => {
        release = res;
      }),
    );
    renderAt("/projects/p/chat");
    await confirmImport(/Import 2 native/i);

    await waitFor(() =>
      expect(apiFns.adoptChats).toHaveBeenCalledWith("p", { sessionIds: ["n1", "n2"] }),
    );
    const busy = screen.getByRole("button", { name: /Import 2 native/i });
    expect(busy).toHaveTextContent("Importing…");
    expect(busy).toBeDisabled();

    act(() => release({ adopted: ["n1", "n2"], skipped: [] }));
    await waitFor(() => expect(importRow()).toBeNull());
  });

  it("re-fetches BOTH the chat list and the count after importing", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    offer(2);
    apiFns.adoptChats.mockResolvedValue({ adopted: ["n1", "n2"], skipped: [] });
    apiFns.listProjectChats.mockResolvedValue([
      makeChat({ sessionId: "n1", name: "From my terminal" }),
    ]);
    renderAt("/projects/p/chat");
    await confirmImport(/Import 2 native/i);

    // The list is what the user came for; the count is what hides the button.
    // Neither is inferred from the POST's response.
    await waitFor(() => expect(apiFns.listProjectChats).toHaveBeenCalledWith("p"));
    await waitFor(() => expect(apiFns.getAdoptableChats).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("From my terminal")).toBeInTheDocument();
  });

  it("hides the button when the re-read count comes back 0", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    apiFns.getAdoptableChats
      .mockResolvedValueOnce({ count: 2, sources: [source("/w", ["n1", "n2"])] })
      .mockResolvedValue({ count: 0, sources: [] });
    apiFns.adoptChats.mockResolvedValue({ adopted: ["n1", "n2"], skipped: [] });
    renderAt("/projects/p/chat");
    await confirmImport(/Import 2 native/i);
    await waitFor(() => expect(importRow()).toBeNull());
  });

  // The live-count property itself. A "dismissed" boolean passes every test
  // above and fails this one.
  it("offers the import AGAIN when the count comes back non-zero", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    apiFns.getAdoptableChats
      .mockResolvedValueOnce({ count: 2, sources: [source("/w", ["n1", "n2"])] })
      // The user has been busy in a terminal since: two imported, three new.
      .mockResolvedValue({ count: 3, sources: [source("/w", ["n3", "n4", "n5"])] });
    apiFns.adoptChats.mockResolvedValue({ adopted: ["n1", "n2"], skipped: [] });
    renderAt("/projects/p/chat");
    await confirmImport(/Import 2 native/i);
    expect(await screen.findByRole("button", { name: /Import 3 native/i })).toBeInTheDocument();
  });

  it("toasts what was imported", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    offer(7);
    apiFns.adoptChats.mockResolvedValue({
      adopted: ["a", "b", "c", "d", "e", "f", "g"],
      skipped: [],
    });
    renderAt("/projects/p/chat");
    await confirmImport(/Import 7 native/i);
    expect(await screen.findByRole("status")).toHaveTextContent("Imported 7 chats");
  });

  it("is honest about skipped sessions rather than reporting a clean success", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    offer(5);
    apiFns.adoptChats.mockResolvedValue({
      adopted: ["a", "b", "c"],
      skipped: [
        { sessionId: "d", reason: "no transcript on disk" },
        { sessionId: "e", reason: "no transcript on disk" },
      ],
    });
    renderAt("/projects/p/chat");
    await confirmImport(/Import 5 native/i);
    const toast = await screen.findByRole("status");
    expect(toast).toHaveTextContent("Imported 3 chats");
    expect(toast).toHaveTextContent("skipped 2");
    // One shared reason is named — it is usually the whole explanation.
    expect(toast).toHaveTextContent("no transcript on disk");
  });

  it("surfaces a failed import WITHOUT blanking the project view or sticking the button", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p", name: "Reactor" })));
    offer(4);
    apiFns.adoptChats.mockRejectedValue(new Error("source transcripts not readable"));
    renderAt("/projects/p/chat");
    await confirmImport(/Import 4 native/i);

    expect(await screen.findByRole("status")).toHaveTextContent("source transcripts not readable");
    // NOT `loadErr`: that is an early return that replaces the whole page, so
    // the project header must still be there.
    expect(screen.getByRole("heading", { name: "Reactor" })).toBeInTheDocument();
    // The offer stands and the button is clickable again — a `finally`, not a
    // success-path reset.
    const btn = screen.getByRole("button", { name: /Import 4 native/i });
    expect(btn).toHaveTextContent("Import 4 native chats");
    expect(btn).not.toBeDisabled();
    // A failed POST must not re-read the count: zeroing it here would retract
    // the offer over a transient error.
    expect(apiFns.getAdoptableChats).toHaveBeenCalledTimes(1);
  });

  // --- undo (#660) --------------------------------------------------------

  it("offers an Undo on the import toast, and undoing releases what came in", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    offer(2);
    apiFns.adoptChats.mockResolvedValue({ adopted: ["n1", "n2"], skipped: [] });
    apiFns.unadoptChats.mockResolvedValue({ released: ["n1", "n2"] });
    renderAt("/projects/p/chat");
    await confirmImport(/Import 2 native/i);

    const toast = await screen.findByRole("status");
    fireEvent.click(within(toast).getByRole("button", { name: /^Undo$/ }));

    // Only ids travel: WHICH files may be deleted is the server's call, from
    // what the import actually did, so an undo can never be talked into
    // removing something it did not create.
    await waitFor(() =>
      expect(apiFns.unadoptChats).toHaveBeenCalledWith("p", { sessionIds: ["n1", "n2"] }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Removed 2 imported chats");
  });

  it("re-reads the list and the count after an undo, so the offer comes back", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    apiFns.getAdoptableChats
      .mockResolvedValueOnce({ count: 1, sources: [source("/w", ["n1"])] })
      .mockResolvedValueOnce({ count: 0, sources: [] })
      // After the undo the session is native again, so it is on offer again.
      .mockResolvedValue({ count: 1, sources: [source("/w", ["n1"])] });
    apiFns.adoptChats.mockResolvedValue({ adopted: ["n1"], skipped: [] });
    apiFns.unadoptChats.mockResolvedValue({ released: ["n1"] });
    renderAt("/projects/p/chat");
    await confirmImport(/Import 1 native/i);
    await waitFor(() => expect(importRow()).toBeNull());

    fireEvent.click(within(await screen.findByRole("status")).getByRole("button", { name: /^Undo$/ }));
    expect(await screen.findByRole("button", { name: /Import 1 native/i })).toBeInTheDocument();
    expect(apiFns.listProjectChats).toHaveBeenCalled();
  });

  it("offers no Undo when the import brought nothing in", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    offer(2);
    apiFns.adoptChats.mockResolvedValue({
      adopted: [],
      skipped: [{ sessionId: "n1", reason: "no transcript on disk" }],
    });
    renderAt("/projects/p/chat");
    await confirmImport(/Import 2 native/i);

    const toast = await screen.findByRole("status");
    expect(within(toast).queryByRole("button", { name: /^Undo$/ })).toBeNull();
  });

  it("says so when there is nothing left to undo, rather than claiming success", async () => {
    // The undo offer is in-memory server-side and expires with a restart, so an
    // empty release is a normal outcome that must not read as "removed 0 chats".
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    offer(1, ["n1"]);
    apiFns.adoptChats.mockResolvedValue({ adopted: ["n1"], skipped: [] });
    apiFns.unadoptChats.mockResolvedValue({ released: [] });
    renderAt("/projects/p/chat");
    await confirmImport(/Import 1 native/i);
    fireEvent.click(within(await screen.findByRole("status")).getByRole("button", { name: /^Undo$/ }));

    expect(await screen.findByRole("status")).toHaveTextContent("Nothing left to undo");
  });

  it("dismisses the toast on request", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    offer(1, ["n1"]);
    apiFns.adoptChats.mockResolvedValue({ adopted: ["n1"], skipped: [] });
    renderAt("/projects/p/chat");
    await confirmImport(/Import 1 native/i);
    await screen.findByRole("status");
    fireEvent.click(screen.getByRole("button", { name: /Dismiss notification/i }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("badges an imported chat in the list so it reads as history, not a paddock chat", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [
          makeChat({ sessionId: "n1", name: "Terminal work", provenance: { origin: "adopted", depth: 0 } }),
          makeChat({ sessionId: "s1", name: "Started here" }),
        ],
      }),
    );
    renderAt("/projects/p/chat");
    await screen.findByText("Terminal work");
    const imported = screen.getByText("Terminal work").closest(".chat-row") as HTMLElement;
    const native = screen.getByText("Started here").closest(".chat-row") as HTMLElement;
    expect(within(imported).getByLabelText("Imported chat")).toBeInTheDocument();
    // The human-origin chat stays unbadged, so the marker actually distinguishes.
    expect(within(native).queryByLabelText("Imported chat")).toBeNull();
  });
});
