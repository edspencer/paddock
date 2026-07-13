import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ProjectView } from "./ProjectView";
import { makeProject, makeChat } from "../test/factories";
import type { Project, GitProjectStatus, ProjectDetail } from "../lib/types";
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
  gitStatus: vi.fn(),
  pinFile: vi.fn(),
  unpinFile: vi.fn(),
  deleteProject: vi.fn(),
  deleteProjectChat: vi.fn(),
  renameProjectChat: vi.fn(),
  archiveProjectChat: vi.fn(),
  markChatSeen: vi.fn(),
  listProjectChats: vi.fn(),
  chatUsage: vi.fn(),
  projectChatMessages: vi.fn(),
  getModels: vi.fn(),
  updateProject: vi.fn(),
};
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      getProjectDetail: (...a: unknown[]) => apiFns.getProjectDetail(...a),
      listProjectFiles: (...a: unknown[]) => apiFns.listProjectFiles(...a),
      gitStatus: (...a: unknown[]) => apiFns.gitStatus(...a),
      pinFile: (...a: unknown[]) => apiFns.pinFile(...a),
      unpinFile: (...a: unknown[]) => apiFns.unpinFile(...a),
      deleteProject: (...a: unknown[]) => apiFns.deleteProject(...a),
      deleteProjectChat: (...a: unknown[]) => apiFns.deleteProjectChat(...a),
      renameProjectChat: (...a: unknown[]) => apiFns.renameProjectChat(...a),
      archiveProjectChat: (...a: unknown[]) => apiFns.archiveProjectChat(...a),
      markChatSeen: (...a: unknown[]) => apiFns.markChatSeen(...a),
      listProjectChats: (...a: unknown[]) => apiFns.listProjectChats(...a),
      chatUsage: (...a: unknown[]) => apiFns.chatUsage(...a),
      projectChatMessages: (...a: unknown[]) => apiFns.projectChatMessages(...a),
      getModels: (...a: unknown[]) => apiFns.getModels(...a),
      updateProject: (...a: unknown[]) => apiFns.updateProject(...a),
    },
  };
});

const upsert = vi.fn();
const remove = vi.fn();
vi.mock("../lib/projects-context", () => ({
  useProjects: () => ({ projects: [], loading: false, error: null, refresh: vi.fn(), upsert, remove }),
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
        <Route path="/projects/:slug/files/:name" element={<ProjectView />} />
        <Route path="/projects/:slug/changes" element={<ProjectView />} />
        <Route path="/projects/:slug/changes/:file" element={<ProjectView />} />
        <Route path="/projects/:slug/settings" element={<ProjectView />} />
        <Route path="/" element={<div>HOME</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  chatPaneProps = null;
  activeCb = null;
  Object.values(apiFns).forEach((m) => m.mockReset());
  apiFns.listProjectFiles.mockResolvedValue([]);
  apiFns.gitStatus.mockResolvedValue({ repo: false, files: [], clean: true } as GitProjectStatus);
  apiFns.listProjectChats.mockResolvedValue([]);
  apiFns.markChatSeen.mockResolvedValue(undefined);
  apiFns.chatUsage.mockResolvedValue({});
  apiFns.projectChatMessages.mockResolvedValue([]);
  apiFns.getModels.mockResolvedValue({
    models: [{ id: "claude-opus-4-8", label: "Opus 4.8", contextLimit: 1_000_000 }],
    keeperDefault: "claude-opus-4-8",
    sweeperDefault: "claude-haiku-4-5-20251001",
    keeperDriveModeDefault: "batch",
  });
  apiFns.updateProject.mockImplementation((_slug: string, patch: Partial<Project>) =>
    Promise.resolve(makeProject({ slug: "p", ...patch })),
  );
  upsert.mockReset();
  remove.mockReset();
  localStorage.clear();
});

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
    apiFns.listProjectFiles.mockResolvedValue(["OVERVIEW.md", "page.html"]);
    renderAt("/projects/p/chat");
    expect(await screen.findByTestId("chat-pane")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Files$/ }));
    expect(await screen.findByText("OVERVIEW.md")).toBeInTheDocument();
    expect(screen.getByText("page.html")).toBeInTheDocument();
    // The changelog moved to the Home tab — it is not on the Files tab.
    expect(screen.queryByText(/did a thing/)).not.toBeInTheDocument();
  });

  it("Home tab shows the project overview (summary) and the changelog", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p", summary: "the overview blurb" }), {
        changelog: "# Changes\n- did a thing",
        chats: [makeChat({ sessionId: "s1", name: "First chat" })],
      }),
    );
    apiFns.listProjectFiles.mockResolvedValue(["OVERVIEW.md"]);
    renderAt("/projects/p/home");
    // Summary appears both in the header and the Home overview card.
    expect(await screen.findAllByText("the overview blurb")).not.toHaveLength(0);
    expect(screen.getByText(/did a thing/)).toBeInTheDocument();
    // Recent chats + files are surfaced on Home (the chat also appears in the
    // session-list column, so match all occurrences).
    expect(screen.getAllByText("First chat").length).toBeGreaterThan(0);
    expect(screen.getByText("OVERVIEW.md")).toBeInTheDocument();
  });

  it("the project name is a breadcrumb to the Home tab", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p", name: "Reactor" })),
    );
    renderAt("/projects/p/chat");
    await screen.findByTestId("chat-pane");
    // The name in the header is a button that navigates up to Home.
    fireEvent.click(screen.getByRole("button", { name: "Reactor" }));
    // Home renders — its "Edit details" overview action is present.
    expect(await screen.findByRole("button", { name: /Edit details/i })).toBeInTheDocument();
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
    apiFns.listProjectFiles.mockResolvedValue(["doc.md"]);
    renderAt("/projects/p/files");
    fireEvent.click(await screen.findByText("doc.md"));
    expect(await screen.findByTestId("file-view")).toHaveTextContent("file: doc.md");
  });

  it("pinning a file calls the API and renders a pinned sibling tab", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p", pinned: [] })));
    apiFns.listProjectFiles.mockResolvedValue(["page.html"]);
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
    apiFns.listProjectFiles.mockResolvedValue(["page.html"]);
    renderAt("/projects/p/files/page.html");
    expect(await screen.findByTestId("file-view")).toHaveTextContent("file: page.html");
    expect(screen.getByRole("tab", { name: /Open page.html tab/i })).toBeInTheDocument();
  });

  it("unpinning a viewed pinned tab calls unpin and falls back to the files list", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p", pinned: ["page.html"] })));
    apiFns.listProjectFiles.mockResolvedValue(["page.html"]);
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

  it("renames a chat via window.prompt", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), { chats: [makeChat({ sessionId: "s1", name: "Old name" })] }),
    );
    apiFns.renameProjectChat.mockResolvedValue(undefined);
    vi.spyOn(window, "prompt").mockReturnValue("New name");
    renderAt("/projects/p/chat");
    await screen.findByText("Old name");
    fireEvent.click(screen.getByRole("button", { name: /Rename chat Old name/i }));
    await waitFor(() => expect(apiFns.renameProjectChat).toHaveBeenCalledWith("p", "s1", "New name"));
    expect(await screen.findByText("New name")).toBeInTheDocument();
  });

  it("rename is a no-op when prompt is cancelled", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), { chats: [makeChat({ sessionId: "s1", name: "Keep me" })] }),
    );
    vi.spyOn(window, "prompt").mockReturnValue(null);
    renderAt("/projects/p/chat");
    await screen.findByText("Keep me");
    fireEvent.click(screen.getByRole("button", { name: /Rename chat Keep me/i }));
    await waitFor(() => expect(apiFns.renameProjectChat).not.toHaveBeenCalled());
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
    localStorage.setItem("paddock:lastSeen:s1", String(Date.parse(FUTURE) + 1));
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [makeChat({ sessionId: "s1", name: "Seen chat", lastTurnCompletedAt: FUTURE })],
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
  it("deletes the project and navigates home", async () => {
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
    expect(await screen.findByText("HOME")).toBeInTheDocument();
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
