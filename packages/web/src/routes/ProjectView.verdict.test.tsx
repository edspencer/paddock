import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ProjectView } from "./ProjectView";
import { makeProject, makeChat } from "../test/factories";
import { resetLastSeenForTests } from "../lib/lastSeen";
import type { ChatVerdict, Project, ProjectDetail } from "../lib/types";
import type { ChatPaneProps } from "../components/ChatPane";

// The post-turn verdict marks on a project's sidebar and Home rows. The setup is
// the minimum ProjectView needs to load a project; see ProjectView.test.tsx for
// the rest of its behaviour.
// Captures the pane's props, to check the goal and verdict it is handed.
let chatPaneProps: ChatPaneProps | null = null;
vi.mock("../components/ChatPane", () => ({
  ChatPane: (props: ChatPaneProps) => {
    chatPaneProps = props;
    return <div data-testid="chat-pane" />;
  },
}));

const apiFns = vi.hoisted(() => ({
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
}));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, api: apiFns };
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

// Drive both the running set and `chat:verdict` frames.
let activeCb: ((s: ReadonlySet<string>) => void) | null = null;
const verdictCbs = new Set<(slug: string, sessionId: string, v: ChatVerdict) => void>();
vi.mock("../lib/ws", () => ({
  chatClient: {
    onActiveSessions: (cb: (s: ReadonlySet<string>) => void) => {
      activeCb = cb;
      cb(new Set());
      return () => {
        activeCb = null;
      };
    },
    onVerdict: (cb: (slug: string, sessionId: string, v: ChatVerdict) => void) => {
      verdictCbs.add(cb);
      return () => verdictCbs.delete(cb);
    },
  },
}));

function attentionRow(sessionId: string) {
  return { ...makeChat({ sessionId }), projectSlug: "p", projectName: "P" };
}

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
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  activeCb = null;
  chatPaneProps = null;
  verdictCbs.clear();
  Object.values(apiFns).forEach((m) => m.mockReset());
  apiFns.listProjectFiles.mockResolvedValue([]);
  apiFns.listProjectDir.mockResolvedValue({ path: "", entries: [] });
  apiFns.gitStatus.mockResolvedValue({ repo: false, files: [], clean: true });
  apiFns.listProjectChats.mockResolvedValue([]);
  apiFns.markChatSeen.mockResolvedValue(undefined);
  apiFns.chatUsage.mockResolvedValue({});
  apiFns.projectChatMessages.mockResolvedValue([]);
  apiFns.attentionChats.mockResolvedValue({ running: [], unread: [] });
  apiFns.getAdoptableChats.mockResolvedValue({ count: 0, sources: [] });
  localStorage.clear();
  resetLastSeenForTests();
});

describe("ProjectView: post-turn verdict marks", () => {
  const rowButton = (name: string) => screen.getByText(name).closest("button") as HTMLElement;
  const verdict = (over: Partial<ChatVerdict> = {}): ChatVerdict => ({
    verdict: "finished",
    reason: "Tests pass and the fix is merged.",
    turnCompletedAt: "2026-11-05T10:00:00.000Z",
    judgedAt: "2026-11-05T10:00:04.000Z",
    ...over,
  });

  it("marks sidebar rows finished / could-continue, and shows nothing unjudged", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [
          makeChat({ sessionId: "s1", name: "Done chat", verdict: verdict() }),
          makeChat({
            sessionId: "s2",
            name: "Open question",
            verdict: verdict({ verdict: "could-continue", reason: "Asked which option." }),
          }),
          makeChat({ sessionId: "s3", name: "Unjudged" }),
        ],
      }),
    );
    renderAt("/projects/p/chat");
    await screen.findByText("Unjudged");
    expect(
      within(rowButton("Done chat")).getByLabelText(
        "Looks finished — Tests pass and the fix is merged.",
      ),
    ).toHaveAttribute("data-verdict", "finished");
    expect(
      within(rowButton("Open question")).getByLabelText("Could continue — Asked which option."),
    ).toHaveAttribute("data-verdict", "could-continue");
    expect(rowButton("Unjudged").querySelector("[data-verdict]")).toBeNull();
  });

  it("hides the mark while the chat is running", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [makeChat({ sessionId: "s1", name: "Done chat", verdict: verdict() })],
      }),
    );
    renderAt("/projects/p/chat");
    await screen.findByText("Done chat");
    expect(rowButton("Done chat").querySelector("[data-verdict]")).not.toBeNull();
    await act(async () => activeCb!(new Set(["s1"])));
    expect(rowButton("Done chat").querySelector("[data-verdict]")).toBeNull();
  });

  it("applies a chat:verdict frame to the row live, ignoring other projects", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [makeChat({ sessionId: "s1", name: "Live chat" })],
      }),
    );
    renderAt("/projects/p/chat");
    await screen.findByText("Live chat");
    expect(rowButton("Live chat").querySelector("[data-verdict]")).toBeNull();
    act(() => {
      for (const cb of verdictCbs) cb("other", "s1", verdict());
    });
    expect(rowButton("Live chat").querySelector("[data-verdict]")).toBeNull();
    act(() => {
      for (const cb of verdictCbs) cb("p", "s1", verdict({ verdict: "could-continue" }));
    });
    expect(rowButton("Live chat").querySelector("[data-verdict]")).toHaveAttribute(
      "data-verdict",
      "could-continue",
    );
  });

  it("patches Home's Running & Recent row from the frame without a refetch", async () => {
    apiFns.getProjectDetail.mockResolvedValue(detail(makeProject({ slug: "p" })));
    apiFns.attentionChats.mockResolvedValue({
      running: [],
      unread: [],
      recent: [{ ...attentionRow("h1"), name: "Home row" }],
    });
    renderAt("/projects/p/home");
    const feed = await screen.findByTestId("home-attention-chats");
    await within(feed).findByText("Home row");
    const calls = apiFns.attentionChats.mock.calls.length;
    act(() => {
      for (const cb of verdictCbs) cb("p", "h1", verdict());
    });
    expect(within(feed).getByLabelText(/^Looks finished/)).toHaveAttribute(
      "data-verdict",
      "finished",
    );
    expect(apiFns.attentionChats.mock.calls.length).toBe(calls);
  });

  it("puts the goal in the row title and hands goal and verdict to the pane", async () => {
    const v = verdict({ goal: "Fix the flaky login test." });
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [
          makeChat({ sessionId: "s1", name: "Goal chat", verdict: v, goal: v.goal }),
          makeChat({ sessionId: "s2", name: "No goal" }),
        ],
      }),
    );
    renderAt("/projects/p/chat/s1");
    await screen.findByText("No goal");
    expect(screen.getByText("Goal chat")).toHaveAttribute(
      "title",
      "Goal chat — Goal: Fix the flaky login test.",
    );
    expect(screen.getByText("No goal")).not.toHaveAttribute("title");
    expect(chatPaneProps?.goal).toBe("Fix the flaky login test.");
    expect(chatPaneProps?.verdict).toEqual(v);
  });

  it("takes a new goal from a chat:verdict frame", async () => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [makeChat({ sessionId: "s1", name: "Live chat", goal: "Old goal." })],
      }),
    );
    renderAt("/projects/p/chat/s1");
    await screen.findByText("Live chat");
    // A verdict without a goal keeps the one the row had.
    act(() => {
      for (const cb of verdictCbs) cb("p", "s1", verdict());
    });
    expect(chatPaneProps?.goal).toBe("Old goal.");
    act(() => {
      for (const cb of verdictCbs) cb("p", "s1", verdict({ goal: "New goal." }));
    });
    expect(chatPaneProps?.goal).toBe("New goal.");
    expect(screen.getByText("Live chat")).toHaveAttribute("title", "Live chat — Goal: New goal.");
  });
});
