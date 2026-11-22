import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AppShell } from "./AppShell";
import { makeProject } from "../test/factories";
import { resetLastSeenForTests } from "../lib/lastSeen";
import type { ListOrder, Project } from "../lib/types";

// The left nav project list's sort modes, rendered through the real AppShell
// with the same context/WS mocks SidebarProjects.test.tsx uses.

let mockProjects: Project[] = [];
vi.mock("../lib/projects-context", () => ({
  useProjects: () => ({
    projects: mockProjects,
    rootWorkspace: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn(),
  }),
}));

const getProjectOrder = vi.fn<() => Promise<ListOrder>>();
const patchProjectOrder = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      listProjectChats: () => Promise.resolve([]),
      markChatSeen: vi.fn(),
      getProjectOrder: () => getProjectOrder(),
      patchProjectOrder: (...a: unknown[]) => patchProjectOrder(...a),
    },
  };
});

vi.mock("../lib/ws", () => ({
  chatClient: {
    onActiveInfos: (cb: (m: ReadonlyMap<string, string>) => void) => {
      cb(new Map());
      return () => {};
    },
    onActiveSessions: (cb: (s: ReadonlySet<string>) => void) => {
      cb(new Set());
      return () => {};
    },
    turnStartedAt: () => null,
  },
}));

const sidebar = () => within(screen.getByRole("complementary"));
/** Project names in render order, per area heading. */
const rowNames = () =>
  sidebar()
    .getAllByRole("link")
    .map((a) => a.querySelector("span.truncate")?.textContent)
    .filter((n): n is string => !!n);

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<div>HOME</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const turn = (at: string) => [{ sessionId: at, lastTurnCompletedAt: at }];

beforeEach(() => {
  localStorage.clear();
  resetLastSeenForTests();
  getProjectOrder.mockReset().mockResolvedValue({ mode: "recent", orders: {} });
  patchProjectOrder.mockReset().mockResolvedValue({});
  mockProjects = [
    makeProject({
      slug: "a",
      name: "Alpha",
      group: "homelab",
      started: "2026-01-01",
      chatTurns: turn("2026-06-01T00:00:00Z"),
    }),
    makeProject({
      slug: "b",
      name: "Beta",
      group: "homelab",
      started: "2026-03-01",
      chatTurns: turn("2026-05-01T00:00:00Z"),
    }),
    makeProject({ slug: "u", name: "Loose", group: "", started: "2026-02-01" }),
  ];
});

describe("Sidebar project list: sort modes", () => {
  it("defaults to most recent reply within each area, areas in their fixed order", async () => {
    renderShell();
    await waitFor(() => expect(getProjectOrder).toHaveBeenCalled());
    expect(rowNames()).toEqual(["Alpha", "Beta", "Loose"]);
    expect(
      sidebar().getByRole("button", { name: "Sort projects (Most recent reply)" }),
    ).toBeTruthy();
  });

  it("switches to Created and persists the mode", async () => {
    renderShell();
    fireEvent.click(sidebar().getByRole("button", { name: /^Sort projects/ }));
    fireEvent.click(sidebar().getByRole("menuitemradio", { name: /^Created/ }));
    expect(rowNames()).toEqual(["Beta", "Alpha", "Loose"]);
    expect(patchProjectOrder).toHaveBeenCalledWith({ mode: "created" });
  });

  it("renders a persisted manual order on load", async () => {
    getProjectOrder.mockResolvedValue({ mode: "manual", orders: { homelab: ["b", "a"] } });
    renderShell();
    await waitFor(() => expect(rowNames()).toEqual(["Beta", "Alpha", "Loose"]));
  });

  it("switching to Manual seeds each area from its current order", async () => {
    renderShell();
    await waitFor(() => expect(getProjectOrder).toHaveBeenCalled());
    fireEvent.click(sidebar().getByRole("button", { name: /^Sort projects/ }));
    fireEvent.click(sidebar().getByRole("menuitemradio", { name: /^Manual/ }));
    expect(rowNames()).toEqual(["Alpha", "Beta", "Loose"]);
    expect(patchProjectOrder).toHaveBeenCalledWith({
      mode: "manual",
      orders: { homelab: ["a", "b"], "": ["u"] },
    });
  });

  it("rolls back and shows a toast when the save fails", async () => {
    patchProjectOrder.mockRejectedValue(new Error("server said no"));
    renderShell();
    await waitFor(() => expect(getProjectOrder).toHaveBeenCalled());
    fireEvent.click(sidebar().getByRole("button", { name: /^Sort projects/ }));
    fireEvent.click(sidebar().getByRole("menuitemradio", { name: /^Created/ }));
    await screen.findByText("server said no");
    expect(rowNames()).toEqual(["Alpha", "Beta", "Loose"]);
  });
});
