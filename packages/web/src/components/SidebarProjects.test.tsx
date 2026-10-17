import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AppShell } from "./AppShell";
import { ProjectsGrid } from "../routes/ProjectsGrid";
import { makeProject } from "../test/factories";
import { resetLastSeenForTests } from "../lib/lastSeen";
import { areaCollapsedKey } from "../lib/areaCollapsed";
import type { Project } from "../lib/types";

// Collapsible group headings in the sidebar. Rendered through the real AppShell
// (and, for the sync tests, the real ProjectsGrid inside it), with the same
// context/WS mocks AppShell.test.tsx uses.

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

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: { ...actual.api, listProjectChats: () => Promise.resolve([]), markChatSeen: vi.fn() },
  };
});

let activeInfos = new Map<string, string>();
vi.mock("../lib/ws", () => ({
  chatClient: {
    onActiveInfos: (cb: (m: ReadonlyMap<string, string>) => void) => {
      cb(new Map(activeInfos));
      return () => {};
    },
    onActiveSessions: (cb: (s: ReadonlySet<string>) => void) => {
      cb(new Set());
      return () => {};
    },
    turnStartedAt: () => null,
  },
}));

const FUTURE = new Date(Date.now() + 60_000).toISOString();

const sidebar = () => within(screen.getByRole("complementary"));
const heading = (name: RegExp) => sidebar().getByRole("button", { name });
const row = (name: RegExp) => sidebar().queryByRole("link", { name });

function renderShell(initial = "/") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<div>HOME</div>} />
          <Route path="projects" element={<ProjectsGrid />} />
          <Route path="projects/:slug/*" element={<div>PROJECT</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  resetLastSeenForTests();
  activeInfos = new Map();
  mockProjects = [
    makeProject({ slug: "a", name: "Alpha", group: "homelab" }),
    makeProject({ slug: "b", name: "Beta", group: "homelab" }),
    makeProject({ slug: "m", name: "Mars", group: "moonshots" }), // not a canonical area
    makeProject({ slug: "u", name: "Loose", group: "" }), // Unsorted
  ];
});

describe("Sidebar group headings: collapse/expand", () => {
  it("renders each heading as a button, expanded by default", () => {
    renderShell();
    for (const name of [/^Homelab/, /^Moonshots/, /^Unsorted/]) {
      expect(heading(name)).toHaveAttribute("aria-expanded", "true");
    }
    expect(row(/Alpha/)).toBeInTheDocument();
  });

  it("toggles a group's rows and persists the fold under the grid's key", () => {
    renderShell();
    fireEvent.click(heading(/^Homelab/));
    expect(heading(/^Homelab/)).toHaveAttribute("aria-expanded", "false");
    expect(row(/Alpha/)).not.toBeInTheDocument();
    expect(row(/Beta/)).not.toBeInTheDocument();
    // Other groups untouched.
    expect(row(/Mars/)).toBeInTheDocument();
    expect(localStorage.getItem("paddock:area-collapsed:homelab")).toBe("1");

    fireEvent.click(heading(/^Homelab/));
    expect(row(/Alpha/)).toBeInTheDocument();
    expect(localStorage.getItem("paddock:area-collapsed:homelab")).toBe("0");
  });

  it("is keyboard-operable (Enter and Space)", async () => {
    const user = userEvent.setup();
    renderShell();
    heading(/^Moonshots/).focus();
    await user.keyboard("{Enter}");
    expect(row(/Mars/)).not.toBeInTheDocument();
    await user.keyboard(" ");
    expect(row(/Mars/)).toBeInTheDocument();
  });

  it("stays collapsed across a remount (a page reload)", () => {
    const first = renderShell();
    fireEvent.click(heading(/^Unsorted/));
    fireEvent.click(heading(/^Moonshots/));
    first.unmount();

    renderShell();
    expect(heading(/^Unsorted/)).toHaveAttribute("aria-expanded", "false");
    expect(heading(/^Moonshots/)).toHaveAttribute("aria-expanded", "false");
    expect(row(/Loose/)).not.toBeInTheDocument();
    expect(row(/Mars/)).not.toBeInTheDocument();
    expect(heading(/^Homelab/)).toHaveAttribute("aria-expanded", "true");
    expect(localStorage.getItem(areaCollapsedKey(""))).toBe("1");
  });

  it("can fold every group at once, leaving just the headings", () => {
    renderShell();
    for (const name of [/^Homelab/, /^Moonshots/, /^Unsorted/]) fireEvent.click(heading(name));
    expect(sidebar().queryAllByRole("link", { name: /Alpha|Beta|Mars|Loose/ })).toHaveLength(0);
    expect(sidebar().getAllByRole("button", { expanded: false })).toHaveLength(3);
  });

  it("ignores a persisted fold when there is only one group (no heading to undo it)", () => {
    localStorage.setItem(areaCollapsedKey("homelab"), "1");
    mockProjects = mockProjects.filter((p) => p.group === "homelab");
    renderShell();
    expect(sidebar().queryByRole("button", { name: /^Homelab/ })).not.toBeInTheDocument();
    expect(row(/Alpha/)).toBeInTheDocument();
    expect(row(/Beta/)).toBeInTheDocument();
  });
});

describe("Sidebar group headings: badge roll-up", () => {
  beforeEach(() => {
    mockProjects = [
      makeProject({
        slug: "a",
        name: "Alpha",
        group: "homelab",
        chatTurns: [{ sessionId: "a1", lastTurnCompletedAt: FUTURE }],
      }),
      makeProject({
        slug: "b",
        name: "Beta",
        group: "homelab",
        chatTurns: [
          { sessionId: "b1", lastTurnCompletedAt: FUTURE },
          { sessionId: "b2", lastTurnCompletedAt: FUTURE },
        ],
      }),
      makeProject({ slug: "m", name: "Mars", group: "moonshots" }),
    ];
    // One running turn in each homelab project.
    activeInfos = new Map([
      ["a-run", "a"],
      ["b-run", "b"],
    ]);
  });

  it("shows nothing on an expanded heading — the rows carry their own badges", () => {
    renderShell();
    expect(within(heading(/^Homelab/)).queryByLabelText(/unread/)).not.toBeInTheDocument();
    expect(within(heading(/^Homelab/)).queryByLabelText(/in flight/)).not.toBeInTheDocument();
  });

  it("sums the hidden rows' unread and in-flight counts onto a folded heading", () => {
    renderShell();
    fireEvent.click(heading(/^Homelab/));
    const h = heading(/^Homelab/);
    expect(within(h).getByLabelText("3 unread replies")).toHaveTextContent("3");
    expect(within(h).getByLabelText("2 chats in flight")).toHaveTextContent("2");
  });

  it("renders no roll-up on a folded group that is quiet", () => {
    renderShell();
    fireEvent.click(heading(/^Moonshots/));
    const h = heading(/^Moonshots/);
    expect(within(h).queryByLabelText(/unread|in flight/)).not.toBeInTheDocument();
  });

  it("keeps the active project's row under a folded heading, and counts only the hidden rows", () => {
    localStorage.setItem(areaCollapsedKey("homelab"), "1");
    renderShell("/projects/b/chat");
    expect(row(/Beta/)).toBeInTheDocument();
    expect(row(/Alpha/)).not.toBeInTheDocument();
    const h = heading(/^Homelab/);
    expect(h).toHaveAttribute("aria-expanded", "false");
    // Beta's 2 unread + 1 running are on its own row; the heading reports Alpha's.
    expect(within(h).getByLabelText("1 unread reply")).toBeInTheDocument();
    expect(within(h).getByLabelText("1 chat in flight")).toBeInTheDocument();
    // Navigating there did not unfold the group.
    expect(localStorage.getItem(areaCollapsedKey("homelab"))).toBe("1");
  });

  it("drops the active row again on navigating away, without touching the fold", () => {
    localStorage.setItem(areaCollapsedKey("homelab"), "1");
    renderShell("/projects/b/chat");
    fireEvent.click(screen.getByRole("link", { name: "Home" }));
    expect(row(/Beta/)).not.toBeInTheDocument();
    expect(localStorage.getItem(areaCollapsedKey("homelab"))).toBe("1");
  });
});

describe("Sidebar group headings: sync with the /projects grid", () => {
  // The grid's section header is a button wrapping an <h2> in <main>.
  const gridHeader = (label: string) =>
    within(screen.getByRole("main"))
      .getByRole("heading", { level: 2, name: label })
      .closest("button") as HTMLButtonElement;

  it("folding in the sidebar folds the grid section, and vice versa", () => {
    renderShell("/projects");
    expect(gridHeader("Homelab")).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(heading(/^Homelab/));
    expect(gridHeader("Homelab")).toHaveAttribute("aria-expanded", "false");
    expect(within(screen.getByRole("main")).queryByText("Alpha")).not.toBeInTheDocument();

    fireEvent.click(gridHeader("Homelab"));
    expect(heading(/^Homelab/)).toHaveAttribute("aria-expanded", "true");
    expect(row(/Alpha/)).toBeInTheDocument();

    // Unsorted too — its "" slug must resolve to the same key on both sides.
    fireEvent.click(gridHeader("Unsorted"));
    expect(heading(/^Unsorted/)).toHaveAttribute("aria-expanded", "false");
  });

  it("follows a fold made in another tab", () => {
    renderShell("/projects");
    act(() => {
      localStorage.setItem(areaCollapsedKey("moonshots"), "1");
      window.dispatchEvent(
        new StorageEvent("storage", { key: areaCollapsedKey("moonshots"), newValue: "1" }),
      );
    });
    expect(heading(/^Moonshots/)).toHaveAttribute("aria-expanded", "false");
    expect(gridHeader("Moonshots")).toHaveAttribute("aria-expanded", "false");
  });
});
