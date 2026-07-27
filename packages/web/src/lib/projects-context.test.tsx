import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { ProjectsProvider, useProjects } from "./projects-context";
import { makeProject } from "../test/factories";

const listProjects = vi.fn();
const getRootProject = vi.fn();
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    api: {
      listProjects: (...a: unknown[]) => listProjects(...a),
      getRootProject: (...a: unknown[]) => getRootProject(...a),
    },
  };
});

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
  // Most instances have no root project (#516) — the default everywhere.
  getRootProject.mockReset();
  getRootProject.mockResolvedValue(null);
});

describe("ProjectsProvider", () => {
  it("loads projects on mount and clears the loading flag", async () => {
    listProjects.mockResolvedValue([makeProject({ slug: "a" }), makeProject({ slug: "b" })]);
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
    listProjects.mockResolvedValue([makeProject({ slug: "a", name: "A" })]);
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
    listProjects.mockResolvedValue([makeProject({ slug: "a" }), makeProject({ slug: "b" })]);
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
    listProjects.mockResolvedValueOnce([makeProject({ slug: "a" })]);
    render(
      <ProjectsProvider>
        <Probe />
      </ProjectsProvider>,
    );
    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
    listProjects.mockResolvedValueOnce([makeProject({ slug: "c" })]);
    await act(async () => {
      await ctx().refresh();
    });
    expect(screen.getByText("c")).toBeInTheDocument();
    expect(screen.queryByText("a")).not.toBeInTheDocument();
  });

  it("useProjects throws when used outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/must be used within ProjectsProvider/);
    spy.mockRestore();
  });
});

describe("ProjectsProvider — the root project (#516)", () => {
  it("exposes the root project separately, never inside `projects`", async () => {
    listProjects.mockResolvedValue([makeProject({ slug: "a" })]);
    getRootProject.mockResolvedValue(makeProject({ slug: "__root", name: "Root" }));
    render(
      <ProjectsProvider>
        <Probe />
      </ProjectsProvider>,
    );
    await waitFor(() => expect(ctx().rootProject).not.toBeUndefined());
    expect(ctx().rootProject?.slug).toBe("__root");
    // The root is invisible to `GET /api/projects` and must stay out of the
    // sidebar + grid, both of which render `projects`.
    expect(ctx().projects.map((p) => p.slug)).toEqual(["a"]);
  });

  it("routes an upsert of the root project to `rootProject`, not the list", async () => {
    listProjects.mockResolvedValue([makeProject({ slug: "a" })]);
    render(
      <ProjectsProvider>
        <Probe />
      </ProjectsProvider>,
    );
    await waitFor(() => expect(ctx().rootProject).toBeNull());
    act(() => ctx().upsert(makeProject({ slug: "__root", name: "Root" })));
    expect(ctx().rootProject?.name).toBe("Root");
    expect(ctx().projects.map((p) => p.slug)).toEqual(["a"]);
  });

  it("resolves the root to null when the endpoint fails (an older server)", async () => {
    listProjects.mockResolvedValue([]);
    getRootProject.mockRejectedValue(new Error("404"));
    render(
      <ProjectsProvider>
        <Probe />
      </ProjectsProvider>,
    );
    await waitFor(() => expect(ctx().rootProject).toBeNull());
    // A failed root lookup is NOT a page-level error: no root project is the
    // normal state, and `/` must keep rendering the projects grid.
    expect(ctx().error).toBeNull();
  });
});
