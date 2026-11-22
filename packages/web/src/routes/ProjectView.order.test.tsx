import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ProjectView } from "./ProjectView";
import { makeProject, makeChat, makeModelsResponse } from "../test/factories";
import { resetLastSeenForTests } from "../lib/lastSeen";
import type { Project, ProjectDetail } from "../lib/types";
import type { ChatPaneProps } from "../components/ChatPane";
import { slotRect } from "../test/pointerEvent";

/**
 * `ProjectView` chat list ordering: the sort-mode menu, and reordering by hand
 * (drag or Alt+Arrow) in Manual mode. The panes around the list are stubbed;
 * only the list is under test.
 */
vi.mock("../components/ChatPane", () => ({
  ChatPane: (props: ChatPaneProps) => (
    <div data-testid="chat-pane">
      chat for {props.projectSlug} / {props.initialSessionId ?? "new"}
    </div>
  ),
}));

// Hoisted: the api mock's factory builds its delegates from this table.
const apiFns = vi.hoisted(() => ({
  getProjectDetail: vi.fn(),
  listProjectFiles: vi.fn(),
  listProjectDir: vi.fn(),
  gitStatus: vi.fn(),
  markChatSeen: vi.fn(),
  listProjectChats: vi.fn(),
  chatUsage: vi.fn(),
  projectChatMessages: vi.fn(),
  getModels: vi.fn(),
  listTriggers: vi.fn(),
  attentionChats: vi.fn(),
  getAdoptableChats: vi.fn(),
  getChatOrder: vi.fn(),
  patchChatOrder: vi.fn(),
}));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: Object.fromEntries(
      Object.entries(apiFns).map(([k, fn]) => [k, (...a: unknown[]) => fn(...a)]),
    ),
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

// The running-turn set, drivable so a test can switch on the running-only filter.
let activeCb: ((s: ReadonlySet<string>) => void) | null = null;
vi.mock("../lib/ws", () => ({
  chatClient: {
    onActiveSessions: (cb: (s: ReadonlySet<string>) => void) => {
      activeCb = cb;
      cb(new Set());
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
        <Route path="/projects/:slug/chat" element={<ProjectView />} />
        <Route path="/projects/:slug/chat/:sessionId" element={<ProjectView />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  activeCb = null;
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
  apiFns.getChatOrder.mockResolvedValue({ mode: "recent", orders: {} });
  apiFns.patchChatOrder.mockImplementation(() => Promise.resolve({}));
  apiFns.getModels.mockResolvedValue(
    makeModelsResponse({
      models: [{ id: "claude-opus-4-8", label: "Opus 4.8", contextLimit: 1_000_000 }],
      defaultModel: "claude-opus-4-8",
    }),
  );
  apiFns.listTriggers.mockResolvedValue({
    triggers: [],
    grantableTools: [],
    events: ["onArchive", "afterTurn"],
    triggerTypes: ["schedule", "event", "webhook"],
  });
  localStorage.clear();
  resetLastSeenForTests();
});

describe("ProjectView: chat sort modes", () => {
  const at = (h: string) => `2026-06-21T${h}:00:00.000Z`;
  const rowNames = () =>
    Array.from(document.querySelectorAll(".chat-row")).map(
      (r) => r.querySelector("span.truncate")?.textContent,
    );
  const pick = async (label: RegExp) => {
    fireEvent.click(screen.getByRole("button", { name: /^Sort chats/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: label }));
  };

  beforeEach(() => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [
          makeChat({
            sessionId: "old",
            name: "Old",
            createdAt: at("01"),
            updatedAt: at("09"),
            lastTurnCompletedAt: at("09"),
          }),
          makeChat({
            sessionId: "new",
            name: "New",
            createdAt: at("05"),
            updatedAt: at("12"),
            lastTurnCompletedAt: at("08"),
          }),
        ],
      }),
    );
  });

  it("defaults to most recent reply, and the menu says so", async () => {
    renderAt("/projects/p/chat");
    await screen.findByText("New");
    // "New" has the newer message but the older reply.
    expect(rowNames()).toEqual(["Old", "New"]);
    expect(screen.getByRole("button", { name: "Sort chats (Most recent reply)" })).toBeTruthy();
    expect(apiFns.getChatOrder).toHaveBeenCalledWith("p");
  });

  it("switches to Created, re-orders at once, and persists the mode", async () => {
    renderAt("/projects/p/chat");
    await screen.findByText("New");
    await pick(/^Created/);
    expect(rowNames()).toEqual(["New", "Old"]);
    expect(apiFns.patchChatOrder).toHaveBeenCalledWith("p", { mode: "created" });
    fireEvent.click(screen.getByRole("button", { name: /^Sort chats/ }));
    expect(screen.getByRole("menuitemradio", { name: /^Created/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("renders the persisted mode on load", async () => {
    apiFns.getChatOrder.mockResolvedValue({
      mode: "manual",
      orders: { "active:nested:": ["new", "old"] },
    });
    renderAt("/projects/p/chat");
    await screen.findByText("New");
    await waitFor(() => expect(rowNames()).toEqual(["New", "Old"]));
  });

  it("switching to Manual seeds every group from the current order, so nothing moves", async () => {
    renderAt("/projects/p/chat");
    await screen.findByText("New");
    await pick(/^Manual/);
    expect(rowNames()).toEqual(["Old", "New"]);
    const [, patch] = apiFns.patchChatOrder.mock.calls[0];
    expect(patch.mode).toBe("manual");
    expect(patch.orders["active:nested:"]).toEqual(["old", "new"]);
    expect(patch.orders["active:flat:"]).toEqual(["old", "new"]);
  });

  it("rolls back and shows a toast when the save fails", async () => {
    apiFns.patchChatOrder.mockRejectedValue(new Error("disk full"));
    renderAt("/projects/p/chat");
    await screen.findByText("New");
    await pick(/^Created/);
    await screen.findByText("disk full");
    expect(rowNames()).toEqual(["Old", "New"]);
  });
});

/**
 * Drag-to-reorder in the chat list, plus its keyboard form (Alt+Arrow) and the
 * filters that switch it off.
 */
describe("ProjectView: reordering chats by hand", () => {
  const at = (h: string) => `2026-06-21T${h}:00:00.000Z`;
  const mouse = { pointerType: "mouse", button: 0, pointerId: 1, clientX: 10 };
  const rowNames = () =>
    Array.from(document.querySelectorAll(".chat-row")).map(
      (r) => r.querySelector("span.truncate")?.textContent,
    );
  const row = (name: string) => screen.getByText(name).closest(".chat-row") as HTMLElement;
  /** Give each chat row a 40px slot, top to bottom. */
  const layout = () =>
    document.querySelectorAll<HTMLElement>(".chat-row").forEach((el, i) => {
      el.getBoundingClientRect = () => slotRect(i);
    });
  const drag = (name: string, toY: number, fromY = 5) => {
    const el = row(name);
    fireEvent.pointerDown(el, { ...mouse, clientY: fromY });
    fireEvent.pointerMove(el, { ...mouse, clientY: toY });
    fireEvent.pointerUp(el, { ...mouse, clientY: toY });
    fireEvent.click(screen.getByText(name));
  };

  beforeEach(() => {
    apiFns.getProjectDetail.mockResolvedValue(
      detail(makeProject({ slug: "p" }), {
        chats: [
          makeChat({ sessionId: "a", name: "Alpha", lastTurnCompletedAt: at("12") }),
          makeChat({ sessionId: "b", name: "Beta", lastTurnCompletedAt: at("11") }),
          makeChat({ sessionId: "c", name: "Gamma", lastTurnCompletedAt: at("10") }),
          makeChat({
            sessionId: "c1",
            name: "Gamma child",
            lastTurnCompletedAt: at("09"),
            parent: { project: "p", sessionId: "c" },
          }),
        ],
      }),
    );
  });

  it("a drag from Most recent reply switches to Manual, moving only that chat", async () => {
    renderAt("/projects/p/chat");
    await screen.findByText("Gamma");
    expect(rowNames()).toEqual(["Alpha", "Beta", "Gamma", "Gamma child"]);
    layout();
    // Gamma's slot is 80-120: drop Alpha on its lower half's neighbour, i.e.
    // past Beta and before Gamma.
    drag("Alpha", 85);
    expect(rowNames()).toEqual(["Beta", "Alpha", "Gamma", "Gamma child"]);
    const [slug, patch] = apiFns.patchChatOrder.mock.calls[0];
    expect(slug).toBe("p");
    expect(patch.mode).toBe("manual");
    expect(patch.orders["active:nested:"]).toEqual(["b", "a", "c"]);
    // Every other group was seeded as it stood, so nothing else moves later.
    expect(patch.orders["active:nested:c"]).toEqual(["c1"]);
    expect(patch.orders["active:flat:"]).toEqual(["a", "b", "c", "c1"]);
    // The click that ended the drag did not open the chat.
    expect(screen.getByTestId("chat-pane").textContent).toContain("/ new");
  });

  it("a nested chat stays within its own sibling group", async () => {
    const base = await apiFns.getProjectDetail.getMockImplementation()!();
    apiFns.getProjectDetail.mockResolvedValue({
      ...base,
      chats: [
        ...base.chats,
        makeChat({
          sessionId: "c2",
          name: "Second child",
          lastTurnCompletedAt: at("08"),
          parent: { project: "p", sessionId: "c" },
        }),
      ],
    });
    renderAt("/projects/p/chat");
    await screen.findByText("Second child");
    layout();
    // Dragged over Alpha, a top-level chat: it can only reach the top of its
    // own group.
    drag("Second child", 5, 180);
    const [, patch] = apiFns.patchChatOrder.mock.calls[0];
    expect(patch.orders["active:nested:c"]).toEqual(["c2", "c1"]);
    expect(patch.orders["active:nested:"]).toEqual(["a", "b", "c"]);
    expect(rowNames()).toEqual(["Alpha", "Beta", "Gamma", "Second child", "Gamma child"]);
  });

  it("a short press still opens the chat", async () => {
    renderAt("/projects/p/chat");
    await screen.findByText("Beta");
    layout();
    drag("Beta", 7);
    expect(apiFns.patchChatOrder).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("chat-pane").textContent).toContain("/ b"));
  });

  it("Alt+ArrowDown moves the focused chat one place down", async () => {
    apiFns.getChatOrder.mockResolvedValue({
      mode: "manual",
      orders: { "active:nested:": ["a", "b", "c"] },
    });
    renderAt("/projects/p/chat");
    await waitFor(() => expect(rowNames()[0]).toBe("Alpha"));
    fireEvent.keyDown(row("Alpha").querySelector("button")!, {
      key: "ArrowDown",
      altKey: true,
    });
    expect(rowNames()).toEqual(["Beta", "Alpha", "Gamma", "Gamma child"]);
    expect(apiFns.patchChatOrder).toHaveBeenCalledWith("p", {
      orders: { "active:nested:": ["b", "a", "c"] },
    });
  });

  it("is off while searching, and the sort menu's tooltip says why", async () => {
    renderAt("/projects/p/chat");
    await screen.findByText("Gamma");
    fireEvent.change(screen.getByRole("textbox", { name: /Search chats/i }), {
      target: { value: "a" },
    });
    layout();
    drag("Alpha", 85);
    expect(apiFns.patchChatOrder).not.toHaveBeenCalled();
    fireEvent.focus(screen.getByRole("button", { name: /^Sort chats/ }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Drag to reorder is off while searching",
    );
  });

  it("is off while the running-only filter is on", async () => {
    localStorage.setItem("paddock:chatView:runningOnly", "1");
    renderAt("/projects/p/chat");
    await waitFor(() => expect(activeCb).not.toBeNull());
    act(() => activeCb!(new Set(["a", "b"])));
    await screen.findByText("Beta");
    layout();
    drag("Alpha", 45);
    expect(apiFns.patchChatOrder).not.toHaveBeenCalled();
  });
});
