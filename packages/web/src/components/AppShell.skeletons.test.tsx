// The sidebar project list under a REAL `ProjectsProvider` (#572).
//
// Separate from `AppShell.test.tsx` because that file mocks
// `../lib/projects-context` wholesale — with the context stubbed, `loading` is
// whatever the test sets, so it can say nothing about when the provider enters
// that state. The user-visible claim in #572 is about the SKELETONS, not the
// flag, and it only holds with the provider and the shell wired together.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AppShell } from "./AppShell";
import { ProjectsProvider, useProjects } from "../lib/projects-context";
import { makeProject } from "../test/factories";
import type { Project } from "../lib/types";

const listProjects = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      listProjects: (...a: unknown[]) => listProjects(...a),
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
  },
}));

type ListResponse = { projects: Project[]; root: Project | null };

const ROOT = makeProject({ slug: "", name: "Instance Root" });

/** Exposes the provider's `refresh` so a test can drive a revalidation. */
let refreshProjects: () => Promise<void>;
function Probe() {
  refreshProjects = useProjects().refresh;
  return null;
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <ProjectsProvider>
        <Probe />
        <Routes>
          <Route path="/" element={<AppShell />}>
            <Route index element={<div>HOME</div>} />
          </Route>
        </Routes>
      </ProjectsProvider>
    </MemoryRouter>,
  );
}

/** The three pulsing placeholder blocks the nav renders while `loading`. */
function skeletons(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll("nav .animate-pulse");
}

beforeEach(() => {
  listProjects.mockReset();
});

describe("AppShell sidebar: stale-while-revalidate project list (#572)", () => {
  it("shows skeletons on the very first load, before any list exists", async () => {
    let release!: (v: ListResponse) => void;
    listProjects.mockReturnValueOnce(
      new Promise<ListResponse>((r) => {
        release = r;
      }),
    );
    const { container } = renderShell();

    expect(skeletons(container)).toHaveLength(3);

    await act(async () => {
      release({ projects: [makeProject({ slug: "alpha", name: "Alpha" })], root: ROOT });
    });
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    expect(skeletons(container)).toHaveLength(0);
  });

  it("does NOT replace a populated list with skeletons while a refresh is in flight", async () => {
    // `ProjectView` calls `refreshProjects()` from three turn-lifecycle
    // callbacks (onSessionStarted / onSessionEstablished / onTurnComplete), so
    // this is what a keeper turn does to the sidebar — twice, measured.
    listProjects.mockResolvedValueOnce({
      projects: [makeProject({ slug: "alpha", name: "Alpha" })],
      root: ROOT,
    } satisfies ListResponse);
    const { container } = renderShell();
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());

    // Hold the refetch open: the flash is a state the UI passes THROUGH, so it
    // has to be observed mid-flight rather than after the promise settles.
    let release!: (v: ListResponse) => void;
    listProjects.mockReturnValueOnce(
      new Promise<ListResponse>((r) => {
        release = r;
      }),
    );
    let settled!: Promise<void>;
    act(() => {
      settled = refreshProjects();
    });

    expect(skeletons(container)).toHaveLength(0);
    expect(screen.getByText("Alpha")).toBeInTheDocument();

    await act(async () => {
      release({ projects: [makeProject({ slug: "alpha", name: "Alpha" })], root: ROOT });
      await settled;
    });
    expect(skeletons(container)).toHaveLength(0);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });
});
