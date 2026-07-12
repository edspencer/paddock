import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AppShell } from "./AppShell";
import { makeProject } from "../test/factories";
import { writeLastSeen } from "../lib/lastSeen";
import type { Project } from "../lib/types";

let mockProjects: Project[] = [];
let mockLoading = false;
const upsert = vi.fn();
vi.mock("../lib/projects-context", () => ({
  useProjects: () => ({
    projects: mockProjects,
    loading: mockLoading,
    error: null,
    refresh: vi.fn(),
    upsert,
    remove: vi.fn(),
  }),
}));

// The sidebar badges (#161) subscribe to the WS active-session set for the
// in-flight count. Mock the client so a test can drive `onActiveInfos`
// (sessionId -> projectSlug) without a real socket.
let activeInfos = new Map<string, string>();
const activeInfoCbs = new Set<(m: ReadonlyMap<string, string>) => void>();
function setActiveInfos(entries: [string, string][]) {
  activeInfos = new Map(entries);
  act(() => {
    for (const cb of activeInfoCbs) cb(new Map(activeInfos));
  });
}
vi.mock("../lib/ws", () => ({
  chatClient: {
    onActiveInfos: (cb: (m: ReadonlyMap<string, string>) => void) => {
      activeInfoCbs.add(cb);
      cb(new Map(activeInfos));
      return () => activeInfoCbs.delete(cb);
    },
    onActiveSessions: (cb: (s: ReadonlySet<string>) => void) => {
      cb(new Set());
      return () => {};
    },
  },
}));

// NewProjectModal pulls /api/models; stub it so the modal mounts cleanly.
vi.mock("./NewProjectModal", () => ({
  NewProjectModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="new-project-modal">New project modal</div> : null,
}));

function renderShell(initial = "/") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<div>HOME</div>} />
          <Route path="chat" element={<div>NEW ONE-OFF</div>} />
          <Route path="projects/:slug/*" element={<div>PROJECT</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockProjects = [];
  mockLoading = false;
  upsert.mockReset();
  activeInfos = new Map();
  activeInfoCbs.clear();
  localStorage.clear();
});

describe("AppShell: sidebar shell", () => {
  it("renders the brand, the two CTAs, and the project count", () => {
    mockProjects = [makeProject({ slug: "a", group: "homelab" }), makeProject({ slug: "b", group: "homelab" })];
    renderShell();
    // "Paddock" appears twice: the mobile top bar + the sidebar (both render in
    // jsdom, which ignores the responsive `lg:hidden` media query).
    expect(screen.getAllByText("Paddock").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: /New Project/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New one-off chat/i })).toBeInTheDocument();
    // Project count next to the "Projects" label.
    const nav = screen.getByText("Projects").closest("div")!;
    expect(within(nav).getByText("2")).toBeInTheDocument();
  });

  it("shows the empty state when there are no projects", () => {
    renderShell();
    expect(screen.getByText(/No projects yet/i)).toBeInTheDocument();
  });

  it("renders a configured brand name + logo from the injected global (issue #34)", () => {
    type WithConfig = { __PADDOCK_CONFIG__?: unknown };
    (globalThis as WithConfig).__PADDOCK_CONFIG__ = {
      brand: { name: "Homelab", logo: "🏠", accent: "#3366cc" },
    };
    try {
      renderShell();
      expect(screen.getAllByText("Homelab").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("🏠").length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText("Paddock")).not.toBeInTheDocument();
      expect(document.title).toBe("Homelab");
    } finally {
      delete (globalThis as WithConfig).__PADDOCK_CONFIG__;
    }
  });

  it("shows the Paddock version in the sidebar", () => {
    renderShell();
    // Injected from packages/web/package.json at build time (mirrored in the
    // vitest config), rendered as `v<semver>`.
    expect(screen.getByText(/^v\d+\.\d+\.\d+/)).toBeInTheDocument();
  });

  it("shows loading skeletons while loading", () => {
    mockLoading = true;
    const { container } = renderShell();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });
});

describe("AppShell: area grouping + subheaders", () => {
  it("shows NO area subheaders when all projects share one area", () => {
    mockProjects = [
      makeProject({ slug: "a", name: "Alpha", group: "homelab" }),
      makeProject({ slug: "b", name: "Beta", group: "homelab" }),
    ];
    renderShell();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    // A single area → the "Homelab" subheader is suppressed.
    expect(screen.queryByText("Homelab")).not.toBeInTheDocument();
  });

  it("shows area subheaders (in canonical order) when multiple areas are present", () => {
    mockProjects = [
      makeProject({ slug: "a", name: "Alpha", group: "side-projects" }),
      makeProject({ slug: "b", name: "Beta", group: "homelab" }),
      makeProject({ slug: "c", name: "Gamma", group: "" }), // Unsorted
    ];
    renderShell();
    const subheaders = ["Homelab", "Side Projects", "Unsorted"].map((l) => screen.getByText(l));
    subheaders.forEach((h) => expect(h).toBeInTheDocument());
    // Homelab comes before Side Projects, Unsorted last (DOM order).
    const positions = subheaders.map((h) => h.compareDocumentPosition(subheaders[0]));
    expect(positions[0]).toBe(0); // Homelab is the reference
  });

  it("renders up to two domain tags + overflow, and NO status pill (#161)", () => {
    mockProjects = [
      makeProject({
        slug: "a",
        name: "Tagged",
        group: "homelab",
        status: "blocked",
        domain: ["plumbing", "electrics", "hvac"],
      }),
    ];
    renderShell();
    const link = screen.getByRole("link", { name: /Tagged/ });
    // The per-row StatusPill was removed in #161 — its status text is gone.
    expect(within(link).queryByText("blocked")).not.toBeInTheDocument();
    expect(within(link).getByText("plumbing")).toBeInTheDocument();
    expect(within(link).getByText("electrics")).toBeInTheDocument();
    // Third tag is collapsed into a "+1".
    expect(within(link).getByText("+1")).toBeInTheDocument();
    expect(within(link).queryByText("hvac")).not.toBeInTheDocument();
  });
});

describe("AppShell: per-project badges (#161)", () => {
  const FUTURE = new Date(Date.now() + 60_000).toISOString();

  it("shows an unread count when a chat's completed turn is newer than lastSeen", () => {
    mockProjects = [
      makeProject({
        slug: "a",
        name: "Alpha",
        group: "homelab",
        chatTurns: [
          { sessionId: "s1", lastTurnCompletedAt: FUTURE },
          { sessionId: "s2", lastTurnCompletedAt: FUTURE },
        ],
      }),
    ];
    renderShell();
    const link = screen.getByRole("link", { name: /Alpha/ });
    // Two never-seen chats with a completed turn → unread badge reads "2".
    expect(within(link).getByLabelText(/2 unread replies/i)).toHaveTextContent("2");
  });

  it("clears a chat's unread contribution once it has been seen", () => {
    mockProjects = [
      makeProject({
        slug: "a",
        name: "Alpha",
        group: "homelab",
        chatTurns: [
          { sessionId: "s1", lastTurnCompletedAt: FUTURE },
          { sessionId: "s2", lastTurnCompletedAt: FUTURE },
        ],
      }),
    ];
    // s1 already seen AFTER its completed turn → only s2 remains unread.
    writeLastSeen("s1", Date.now() + 120_000);
    renderShell();
    const link = screen.getByRole("link", { name: /Alpha/ });
    expect(within(link).getByLabelText(/1 unread reply/i)).toHaveTextContent("1");
  });

  it("renders no badges when the project is quiet (no unread, none in flight)", () => {
    mockProjects = [makeProject({ slug: "a", name: "Alpha", group: "homelab" })];
    renderShell();
    const link = screen.getByRole("link", { name: /Alpha/ });
    expect(within(link).queryByLabelText(/unread/i)).not.toBeInTheDocument();
    expect(within(link).queryByLabelText(/in flight/i)).not.toBeInTheDocument();
  });

  it("shows an in-flight count from the WS active-session set, per project", () => {
    activeInfos = new Map([
      ["s1", "a"],
      ["s2", "a"],
      ["s3", "b"],
    ]);
    mockProjects = [
      makeProject({ slug: "a", name: "Alpha", group: "homelab" }),
      makeProject({ slug: "b", name: "Beta", group: "homelab" }),
    ];
    renderShell();
    expect(
      within(screen.getByRole("link", { name: /Alpha/ })).getByLabelText(/2 chats in flight/i),
    ).toHaveTextContent("2");
    expect(
      within(screen.getByRole("link", { name: /Beta/ })).getByLabelText(/1 chat in flight/i),
    ).toBeInTheDocument();
  });

  it("a chat completing over the WS bumps unread live, and is not double-counted while running", () => {
    mockProjects = [makeProject({ slug: "a", name: "Alpha", group: "homelab" })];
    renderShell();
    const link = () => screen.getByRole("link", { name: /Alpha/ });
    // Turn starts running → in-flight 1, no unread yet.
    setActiveInfos([["s1", "a"]]);
    expect(within(link()).getByLabelText(/1 chat in flight/i)).toBeInTheDocument();
    expect(within(link()).queryByLabelText(/unread/i)).not.toBeInTheDocument();
    // Turn stops → in-flight clears, unread becomes 1 (reply landed, not viewed).
    setActiveInfos([]);
    expect(within(link()).queryByLabelText(/in flight/i)).not.toBeInTheDocument();
    expect(within(link()).getByLabelText(/1 unread reply/i)).toHaveTextContent("1");
  });
});

describe("AppShell: navigation", () => {
  it("opens the New Project modal", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: /New Project/i }));
    expect(screen.getByTestId("new-project-modal")).toBeInTheDocument();
  });

  it("navigates to a one-off chat", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: /New one-off chat/i }));
    expect(screen.getByText("NEW ONE-OFF")).toBeInTheDocument();
  });

  it("a project nav link routes to that project", () => {
    mockProjects = [makeProject({ slug: "alpha", name: "Alpha", group: "homelab" })];
    renderShell();
    fireEvent.click(screen.getByRole("link", { name: /Alpha/ }));
    expect(screen.getByText("PROJECT")).toBeInTheDocument();
  });
});
