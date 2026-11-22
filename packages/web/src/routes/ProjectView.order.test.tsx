import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ProjectView } from "./ProjectView";
import { makeProject, makeChat, makeModelsResponse } from "../test/factories";
import { resetLastSeenForTests } from "../lib/lastSeen";
import type { Project, ProjectDetail } from "../lib/types";
import type { ChatPaneProps } from "../components/ChatPane";

/**
 * `ProjectView` chat list ordering: the sort-mode menu and the order it
 * persists. The panes around the list are stubbed; only the list is under test.
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
        <Route path="/projects/:slug/chat" element={<ProjectView />} />
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
