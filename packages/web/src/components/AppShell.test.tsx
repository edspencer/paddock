import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AppShell } from "./AppShell";
import { makeProject } from "../test/factories";
import { markSeenLocally, resetLastSeenForTests } from "../lib/lastSeen";
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

function renderShell(initial = "/") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<div>HOME</div>} />
          <Route path="chat" element={<div>ROOT CHAT</div>} />
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
  resetLastSeenForTests();
});

describe("AppShell: sidebar shell", () => {
  it("renders the brand, the Home link, and the project count", () => {
    mockProjects = [makeProject({ slug: "a", group: "homelab" }), makeProject({ slug: "b", group: "homelab" })];
    renderShell();
    // "Paddock" appears twice: the mobile top bar + the sidebar (both render in
    // jsdom, which ignores the responsive `lg:hidden` media query).
    expect(screen.getAllByText("Paddock").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    // Project count next to the "Projects" label.
    const nav = screen.getByText("Projects").closest("div")!;
    expect(within(nav).getByText("2")).toBeInTheDocument();
  });

  it("has no New Project / New root chat CTAs — both live on root Home now", () => {
    // Ported, not weakened: the assertions that these two actions EXIST moved
    // to their new home. "New Project" is asserted on the embedded grid
    // (ProjectsGrid.test.tsx, ProjectView.root.test.tsx) and starting a root
    // chat via that grid's "New chat". What belongs HERE is the other half —
    // that the sidebar no longer carries a second copy of either.
    mockProjects = [makeProject({ slug: "a" })];
    renderShell();
    expect(screen.queryByRole("button", { name: /New Project/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New root chat/i })).not.toBeInTheDocument();
  });

  it("points the Projects section label at root Home, where the list lives", () => {
    mockProjects = [makeProject({ slug: "a" })];
    renderShell();
    expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute("href", "/");
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
    markSeenLocally("s1", Date.now() + 120_000);
    renderShell();
    const link = screen.getByRole("link", { name: /Alpha/ });
    expect(within(link).getByLabelText(/1 unread reply/i)).toHaveTextContent("1");
  });

  it("counts a manually-unread chat (#458) even after its completed turn was seen", () => {
    mockProjects = [
      makeProject({
        slug: "a",
        name: "Alpha",
        group: "homelab",
        chatTurns: [
          // Seen AFTER its completed turn (so NOT timestamp-unread), but the user
          // manually flagged it unread — the badge must still count it.
          { sessionId: "s1", lastTurnCompletedAt: FUTURE, unread: true },
          { sessionId: "s2", lastTurnCompletedAt: FUTURE },
        ],
      }),
    ];
    markSeenLocally("s1", Date.now() + 120_000); // s1 seen; only the manual flag keeps it unread
    renderShell();
    const link = screen.getByRole("link", { name: /Alpha/ });
    // s1 (manual) + s2 (timestamp) → "2".
    expect(within(link).getByLabelText(/2 unread replies/i)).toHaveTextContent("2");
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
  it("the Home link routes to `/`, the root workspace's Home", () => {
    renderShell("/projects/alpha/chat");
    expect(screen.getByText("PROJECT")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Home" }));
    expect(screen.getByText("HOME")).toBeInTheDocument();
  });

  it("marks the Home link active on `/` only, not inside a project", () => {
    // `end` on the NavLink: without it every route matches `/` as a prefix and
    // the Home item reads as active on every page in the app.
    const { unmount } = renderShell("/");
    expect(screen.getByRole("link", { name: "Home" }).className).toMatch(/bg-paddock-200/);
    unmount();
    renderShell("/projects/alpha/chat");
    expect(screen.getByRole("link", { name: "Home" }).className).not.toMatch(/bg-paddock-200/);
  });

  it("a project nav link routes to that project", () => {
    mockProjects = [makeProject({ slug: "alpha", name: "Alpha", group: "homelab" })];
    renderShell();
    fireEvent.click(screen.getByRole("link", { name: /Alpha/ }));
    expect(screen.getByText("PROJECT")).toBeInTheDocument();
  });
});
