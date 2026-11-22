import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ProjectView } from "./ProjectView";
import { makeProject, makeChat, makeModelsResponse } from "../test/factories";
import { resetLastSeenForTests } from "../lib/lastSeen";
import type { LiveBackgroundTask, Project, ProjectDetail } from "../lib/types";

vi.mock("../components/ChatPane", () => ({
  ChatPane: () => <div data-testid="chat-pane" />,
}));

// `vi.hoisted` because `vi.mock` is lifted above the imports, and these
// factories close over the spies and the captured callbacks.
const { apiFns, ws } = vi.hoisted(() => ({
  apiFns: {
    getProjectDetail: vi.fn(),
    listProjectFiles: vi.fn(),
    listProjectDir: vi.fn(),
    gitStatus: vi.fn(),
    listProjectChats: vi.fn(),
    chatUsage: vi.fn(),
    projectChatMessages: vi.fn(),
    markChatSeen: vi.fn(),
    getModels: vi.fn(),
    listTriggers: vi.fn(),
    attentionChats: vi.fn(),
    getAdoptableChats: vi.fn(),
  },
  ws: {
    active: null as ((s: ReadonlySet<string>) => void) | null,
    turns: null as ((s: ReadonlySet<string>) => void) | null,
    background: null as ((m: ReadonlyMap<string, LiveBackgroundTask[]>) => void) | null,
  },
}));
vi.mock("../lib/api", async () => ({
  ...(await vi.importActual<typeof import("../lib/api")>("../lib/api")),
  api: apiFns,
}));
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
      ws.active = cb;
      cb(new Set());
      return () => {};
    },
    onTurnSessions: (cb: (s: ReadonlySet<string>) => void) => {
      ws.turns = cb;
      cb(new Set());
      return () => {};
    },
    onAllBackgroundWork: (cb: (m: ReadonlyMap<string, LiveBackgroundTask[]>) => void) => {
      ws.background = cb;
      cb(new Map());
      return () => {};
    },
    // Home orders Running rows by turn start; unknown is fine here.
    turnStartedAt: () => undefined,
  },
}));

function detail(project: Project, over: Partial<ProjectDetail> = {}): ProjectDetail {
  return { project, changelog: "", chats: [], ...over };
}

/** One row for Home's attention feed. */
function attentionRow(sessionId: string) {
  return { ...makeChat({ sessionId }), projectSlug: "p", projectName: "P" };
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:slug/home" element={<ProjectView />} />
        <Route path="/projects/:slug/chat" element={<ProjectView />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  ws.active = ws.turns = ws.background = null;
  Object.values(apiFns).forEach((m) => m.mockReset());
  apiFns.listProjectFiles.mockResolvedValue([]);
  apiFns.listProjectDir.mockResolvedValue({ path: "", entries: [] });
  apiFns.gitStatus.mockResolvedValue({ repo: false, files: [], clean: true });
  apiFns.listProjectChats.mockResolvedValue([]);
  apiFns.chatUsage.mockResolvedValue({});
  apiFns.projectChatMessages.mockResolvedValue([]);
  apiFns.markChatSeen.mockResolvedValue(undefined);
  apiFns.getModels.mockResolvedValue(makeModelsResponse());
  apiFns.listTriggers.mockResolvedValue({
    triggers: [],
    grantableTools: [],
    events: [],
    triggerTypes: [],
  });
  apiFns.attentionChats.mockResolvedValue({ running: [], unread: [] });
  apiFns.getAdoptableChats.mockResolvedValue({ count: 0, sources: [] });
  localStorage.clear();
  resetLastSeenForTests();
});

/**
 * Idle, but background work running (#604): `running` covers both a live turn
 * and work a finished turn left behind, and the rows draw the two differently.
 */
describe("ProjectView: idle chats with background work", () => {
  const task = (over: Partial<LiveBackgroundTask>): LiveBackgroundTask => ({
    id: "t1",
    type: "local_agent",
    role: "subagent",
    description: "background research",
    startedAt: 1,
    agentType: "general-purpose",
    ...over,
  });
  /** One frame's worth of fleet state: running, turn subset, task lists. */
  const fleet = (
    running: string[],
    turns: string[],
    tasks: Record<string, LiveBackgroundTask[]> = {},
  ) =>
    act(() => {
      ws.active!(new Set(running));
      ws.turns!(new Set(turns));
      ws.background!(new Map(Object.entries(tasks)));
    });
  const row = (name: string) => screen.getByText(name).closest(".chat-row") as HTMLElement;
  const mark = (el: HTMLElement) => el.querySelector("[data-background-work]");
  const spinning = (el: HTMLElement) => el.querySelector(".spin-eco");

  beforeEach(() => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [
          makeChat({ sessionId: "s1", name: "Worker", contextTokens: 1000, contextLimit: 200_000 }),
        ],
      }),
    );
  });

  it("a live turn keeps the spinning ring and gets no background mark", async () => {
    renderAt("/projects/p/chat");
    await screen.findByText("Worker");
    // Background work during the turn does not change that: the ring says busy.
    fleet(["s1"], ["s1"], { s1: [task({})] });
    expect(spinning(row("Worker"))).not.toBeNull();
    expect(mark(row("Worker"))).toBeNull();
  });

  it("background-only: a still ring plus the mark, naming each task", async () => {
    renderAt("/projects/p/chat");
    await screen.findByText("Worker");
    fleet(["s1"], [], {
      s1: [
        task({}),
        task({
          id: "t2",
          type: "local_bash",
          role: "shell",
          description: "wait for CI",
          agentType: undefined,
        }),
      ],
    });
    const m = mark(row("Worker"));
    expect(m).not.toBeNull();
    expect(m).toHaveAttribute(
      "aria-label",
      "Idle, but 2 background tasks running: " +
        "general-purpose (background research), shell (wait for CI)",
    );
    expect(m).toHaveTextContent("2");
    expect(spinning(row("Worker"))).toBeNull();
  });

  it("background-only with the task list not yet arrived still says so", async () => {
    renderAt("/projects/p/chat");
    await screen.findByText("Worker");
    fleet(["s1"], []);
    expect(mark(row("Worker"))).toHaveAttribute("aria-label", "Idle, but background work running");
  });

  it("idle: no mark and no spin, even with a stale task list", async () => {
    renderAt("/projects/p/chat");
    await screen.findByText("Worker");
    // The trust is in `running`: a task list for a chat the server calls idle
    // is a frame still in flight, not a reason to mark the row.
    fleet([], [], { s1: [task({})] });
    expect(mark(row("Worker"))).toBeNull();
    expect(spinning(row("Worker"))).toBeNull();
  });

  it("marks a background-only Home row, Running or recent, not a live or idle one", async () => {
    // The server counts background work as running, so a background-only chat
    // normally sits in `running`; one can still be in `recent` while the feed
    // catches up with the socket.
    apiFns.attentionChats.mockResolvedValue({
      running: [
        { ...attentionRow("live"), name: "Live turn" },
        { ...attentionRow("bg"), name: "Agents left running" },
      ],
      unread: [],
      recent: [
        { ...attentionRow("late"), name: "Feed behind" },
        { ...attentionRow("quiet"), name: "Quiet chat" },
      ],
    });
    renderAt("/projects/p/home");
    const feed = await screen.findByTestId("home-attention-chats");
    await within(feed).findByText("Agents left running");
    fleet(["live", "bg", "late"], ["live"], {
      live: [task({})],
      bg: [task({})],
      late: [task({})],
    });
    const homeRow = (name: string) => within(feed).getByText(name).closest("button")!;
    const pulsing = (el: HTMLElement) => el.querySelector('[aria-label="running"].animate-pulse');

    expect(homeRow("Agents left running")).toHaveAttribute("data-state", "running");
    expect(mark(homeRow("Agents left running"))).toHaveAttribute(
      "aria-label",
      "Idle, but 1 background task running: general-purpose (background research)",
    );
    expect(homeRow("Agents left running").querySelector('[aria-label="running"]')).not.toBeNull();
    expect(pulsing(homeRow("Agents left running"))).toBeNull();

    expect(mark(homeRow("Live turn"))).toBeNull();
    expect(pulsing(homeRow("Live turn"))).not.toBeNull();

    expect(homeRow("Feed behind")).toHaveAttribute("data-state", "read");
    expect(mark(homeRow("Feed behind"))).not.toBeNull();

    expect(mark(homeRow("Quiet chat"))).toBeNull();
  });
});
