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
  listProjectChats: vi.fn(),
  projectChatMessages: vi.fn(),
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
      listProjectChats: (...a: unknown[]) => apiFns.listProjectChats(...a),
      projectChatMessages: (...a: unknown[]) => apiFns.projectChatMessages(...a),
    },
  };
});

const upsert = vi.fn();
const remove = vi.fn();
vi.mock("../lib/projects-context", () => ({
  useProjects: () => ({ projects: [], loading: false, error: null, refresh: vi.fn(), upsert, remove }),
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
        <Route path="/" element={<div>HOME</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  chatPaneProps = null;
  Object.values(apiFns).forEach((m) => m.mockReset());
  apiFns.listProjectFiles.mockResolvedValue([]);
  apiFns.gitStatus.mockResolvedValue({ repo: false, files: [], clean: true } as GitProjectStatus);
  apiFns.listProjectChats.mockResolvedValue([]);
  apiFns.projectChatMessages.mockResolvedValue([]);
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
