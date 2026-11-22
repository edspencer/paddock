import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ProjectView } from "./ProjectView";
import { makeProject, makeChat, makeModelsResponse } from "../test/factories";
import { resetLastSeenForTests } from "../lib/lastSeen";
import { writeDraft } from "../lib/draft";
import type { Project, ProjectDetail } from "../lib/types";

/**
 * The sidebar's unsent-draft marker. Kept apart from ProjectView.test.tsx, so
 * this stub set is only what a chat route's sidebar needs to render.
 */
vi.mock("../components/ChatPane", () => ({
  ChatPane: () => <div data-testid="chat-pane" />,
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
  attentionChats: vi.fn(),
  getAdoptableChats: vi.fn(),
  getModels: vi.fn(),
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
      attentionChats: (...a: unknown[]) => apiFns.attentionChats(...a),
      getAdoptableChats: (...a: unknown[]) => apiFns.getAdoptableChats(...a),
      getModels: (...a: unknown[]) => apiFns.getModels(...a),
    },
  };
});

vi.mock("../lib/projects-context", () => ({
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

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:slug/chat/:sessionId" element={<ProjectView />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  Object.values(apiFns).forEach((m) => m.mockReset());
  apiFns.listProjectFiles.mockResolvedValue([]);
  apiFns.listProjectDir.mockResolvedValue({ path: "", entries: [] });
  apiFns.gitStatus.mockResolvedValue({ repo: false, files: [], clean: true });
  apiFns.listProjectChats.mockResolvedValue([]);
  apiFns.chatUsage.mockResolvedValue({});
  apiFns.projectChatMessages.mockResolvedValue([]);
  apiFns.markChatSeen.mockResolvedValue(undefined);
  apiFns.attentionChats.mockResolvedValue({ running: [], unread: [] });
  apiFns.getAdoptableChats.mockResolvedValue({ count: 0, sources: [] });
  apiFns.getModels.mockResolvedValue(makeModelsResponse());
  localStorage.clear();
  resetLastSeenForTests();
});

describe("ProjectView: unsent-draft icon on chat rows", () => {
  const rowButton = (name: string) => screen.getByText(name).closest("button") as HTMLElement;
  const chats = [
    makeChat({ sessionId: "s1", name: "Open chat" }),
    makeChat({ sessionId: "s2", name: "Other chat" }),
  ];

  it("marks a chat with a saved draft, but not the open chat", async () => {
    writeDraft("s1", "p", "typed here");
    writeDraft("s2", "p", "half a thought");
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" }), { chats }));
    renderAt("/projects/p/chat/s1");
    await screen.findByText("Other chat");
    // The drafts are read in an effect, which can land a tick after the rows.
    await waitFor(() =>
      expect(within(rowButton("Other chat")).getByLabelText("Unsent draft")).toBeInTheDocument(),
    );
    expect(within(rowButton("Open chat")).queryByLabelText("Unsent draft")).toBeNull();
  });

  it("follows a draft being written and cleared", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" }), { chats }));
    renderAt("/projects/p/chat/s1");
    await screen.findByText("Other chat");
    expect(within(rowButton("Other chat")).queryByLabelText("Unsent draft")).toBeNull();
    act(() => writeDraft("s2", "p", "later"));
    expect(within(rowButton("Other chat")).getByLabelText("Unsent draft")).toBeInTheDocument();
    act(() => writeDraft("s2", "p", ""));
    expect(within(rowButton("Other chat")).queryByLabelText("Unsent draft")).toBeNull();
  });
});
