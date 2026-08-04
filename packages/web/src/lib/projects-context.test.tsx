import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { ProjectsProvider, useProjects } from "./projects-context";
import { makeProject } from "../test/factories";
import type { Project } from "./types";

const ROOT_DEFAULT = makeProject({ slug: "", name: "Instance Root" });

const listProjects = vi.fn();
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    api: {
      listProjects: (...a: unknown[]) => listProjects(...a),
    },
  };
});

/**
 * `GET /api/projects` carries the children AND the root in one payload (#553),
 * so a single mock stands in for both. The root defaults to present, because
 * the instance's own directory always resolves (#516).
 */
function mockList(projects: Project[], root: Project | null = ROOT_DEFAULT) {
  listProjects.mockResolvedValue({ projects, root });
}
function mockListOnce(projects: Project[], root: Project | null = ROOT_DEFAULT) {
  listProjects.mockResolvedValueOnce({ projects, root });
}

// A tiny probe component that surfaces the context for assertions + exposes the
// mutators on window so tests can drive upsert/remove/refresh.
function Probe() {
  const ctx = useProjects();
  (window as unknown as { __ctx: typeof ctx }).__ctx = ctx;
  return (
    <div>
      <span data-testid="loading">{String(ctx.loading)}</span>
      <span data-testid="error">{ctx.error ?? ""}</span>
      <ul>
        {ctx.projects.map((p) => (
          <li key={p.slug}>{p.slug}</li>
        ))}
      </ul>
    </div>
  );
}

function ctx() {
  return (window as unknown as { __ctx: ReturnType<typeof useProjects> }).__ctx;
}

beforeEach(() => {
  listProjects.mockReset();
});

describe("ProjectsProvider", () => {
  it("loads projects on mount and clears the loading flag", async () => {
    mockList([makeProject({ slug: "a" }), makeProject({ slug: "b" })]);
    render(
      <ProjectsProvider>
        <Probe />
      </ProjectsProvider>,
    );
    expect(screen.getByTestId("loading")).toHaveTextContent("true");
    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
    expect(screen.getByText("b")).toBeInTheDocument();
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
  });

  it("surfaces a load error and stops loading", async () => {
    listProjects.mockRejectedValue(new Error("nope"));
    render(
      <ProjectsProvider>
        <Probe />
      </ProjectsProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("nope"));
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
  });

  it("upsert inserts a new project at the front and replaces an existing one", async () => {
    mockList([makeProject({ slug: "a", name: "A" })]);
    render(
      <ProjectsProvider>
        <Probe />
      </ProjectsProvider>,
    );
    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());

    act(() => ctx().upsert(makeProject({ slug: "b", name: "B" })));
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["b", "a"]); // new one prepended

    // Upserting an existing slug replaces (no dupe), moving it to the front.
    act(() => ctx().upsert(makeProject({ slug: "a", name: "A2" })));
    const after = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(after).toEqual(["a", "b"]);
  });

  it("remove drops a project locally", async () => {
    mockList([makeProject({ slug: "a" }), makeProject({ slug: "b" })]);
    render(
      <ProjectsProvider>
        <Probe />
      </ProjectsProvider>,
    );
    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
    act(() => ctx().remove("a"));
    expect(screen.queryByText("a")).not.toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
  });

  it("refresh re-fetches the list", async () => {
    mockListOnce([makeProject({ slug: "a" })]);
    render(
      <ProjectsProvider>
        <Probe />
      </ProjectsProvider>,
    );
    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
    mockListOnce([makeProject({ slug: "c" })]);
    await act(async () => {
      await ctx().refresh();
    });
    expect(screen.getByText("c")).toBeInTheDocument();
    expect(screen.queryByText("a")).not.toBeInTheDocument();
  });

  // #572: `loading` used to mean two different things — "we have never loaded
  // the list" and "we are re-checking a list we are already showing". Only the
  // first deserves a placeholder; `ProjectView` refreshes from three
  // turn-lifecycle callbacks, so the second blanked the sidebar mid-turn.
  it("stays out of the loading state on a refresh once the list has loaded (#572)", async () => {
    mockListOnce([makeProject({ slug: "a" })]);
    render(
      <ProjectsProvider>
        <Probe />
      </ProjectsProvider>,
    );
    // First fetch DOES get the placeholder…
    expect(screen.getByTestId("loading")).toHaveTextContent("true");
    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
    expect(screen.getByTestId("loading")).toHaveTextContent("false");

    // …a subsequent one revalidates quietly. Hold the second response open so
    // the state is observed WHILE the refetch is in flight, not just after.
    let release!: (v: { projects: Project[]; root: Project | null }) => void;
    listProjects.mockReturnValueOnce(
      new Promise<{ projects: Project[]; root: Project | null }>((r) => {
        release = r;
      }),
    );
    let settled!: Promise<void>;
    act(() => {
      settled = ctx().refresh();
    });
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
    // …and the stale list is still on screen rather than replaced.
    expect(screen.getByText("a")).toBeInTheDocument();

    await act(async () => {
      release({ projects: [makeProject({ slug: "c" })], root: ROOT_DEFAULT });
      await settled;
    });
    expect(screen.getByText("c")).toBeInTheDocument();
  });

  it("useProjects throws when used outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/must be used within ProjectsProvider/);
    spy.mockRestore();
  });
});

describe("ProjectsProvider — the root workspace (#516)", () => {
  it("exposes the root workspace separately, never inside `projects`", async () => {
    mockList([makeProject({ slug: "a" })], makeProject({ slug: "", name: "Root" }));
    render(
      <ProjectsProvider>
        <Probe />
      </ProjectsProvider>,
    );
    await waitFor(() => expect(ctx().rootWorkspace).not.toBeNull());
    expect(ctx().rootWorkspace?.slug).toBe("");
    // `GET /api/projects` enumerates the root's CHILDREN, so the root itself is
    // absent from it — and must stay out of the sidebar + grid, which render
    // `projects`.
    expect(ctx().projects.map((p) => p.slug)).toEqual(["a"]);
  });

  it("routes an upsert of the root workspace to `rootWorkspace`, not the list", async () => {
    mockList([makeProject({ slug: "a" })]);
    render(
      <ProjectsProvider>
        <Probe />
      </ProjectsProvider>,
    );
    await waitFor(() => expect(ctx().rootWorkspace?.name).toBe("Instance Root"));
    act(() => ctx().upsert(makeProject({ slug: "", name: "Renamed Root" })));
    expect(ctx().rootWorkspace?.name).toBe("Renamed Root");
    expect(ctx().projects.map((p) => p.slug)).toEqual(["a"]);
  });

  it("leaves the root null when the payload omits it, without failing the page", async () => {
    // The server returns `root: null` only when it could not read the root
    // record — a degraded case that must not take the children list with it.
    mockList([], null);
    render(
      <ProjectsProvider>
        <Probe />
      </ProjectsProvider>,
    );
    await waitFor(() => expect(ctx().loading).toBe(false));
    expect(ctx().rootWorkspace).toBeNull();
    // An unreadable root record is NOT a page-level error — the children list it
    // rode along with is still good, so the grid and sidebar keep rendering.
    expect(ctx().error).toBeNull();
  });
});
