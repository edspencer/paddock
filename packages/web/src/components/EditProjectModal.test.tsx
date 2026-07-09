import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditProjectModal } from "./EditProjectModal";
import { makeProject } from "../test/factories";

const updateProject = vi.fn();
const getModels = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      updateProject: (...a: unknown[]) => updateProject(...a),
      getModels: (...a: unknown[]) => getModels(...a),
    },
  };
});

describe("EditProjectModal", () => {
  beforeEach(() => {
    updateProject.mockReset();
    updateProject.mockImplementation((_slug, patch) =>
      Promise.resolve(makeProject({ slug: "p1", ...patch })),
    );
    getModels.mockReset();
    getModels.mockResolvedValue({
      models: [
        { id: "claude-opus-4-8", label: "Opus 4.8", contextLimit: 1_000_000 },
        { id: "claude-sonnet-5", label: "Sonnet 5", contextLimit: 1_000_000 },
        { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", contextLimit: 200_000 },
      ],
      keeperDefault: "claude-opus-4-8",
      sweeperDefault: "claude-haiku-4-5-20251001",
    });
  });

  it("prefills fields from the project", () => {
    const project = makeProject({
      slug: "p1",
      name: "Heater",
      summary: "old summary",
      domain: ["home", "plumbing"],
      group: "house",
      status: "paused",
    });
    render(<EditProjectModal open project={project} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByDisplayValue("old summary")).toBeInTheDocument();
    expect(screen.getByDisplayValue("home, plumbing")).toBeInTheDocument();
    expect((screen.getByRole("option", { name: "House" }) as HTMLOptionElement).selected).toBe(true);
    expect((screen.getByRole("option", { name: "paused" }) as HTMLOptionElement).selected).toBe(true);
  });

  it("builds the update patch the server expects (status, group, summary, tags)", async () => {
    const project = makeProject({ slug: "p1", summary: "s", domain: ["a"], group: "homelab" });
    const onSaved = vi.fn();
    render(<EditProjectModal open project={project} onClose={() => {}} onSaved={onSaved} />);

    const summary = screen.getByDisplayValue("s");
    await userEvent.clear(summary);
    await userEvent.type(summary, "  new summary  ");
    const tags = screen.getByDisplayValue("a");
    await userEvent.clear(tags);
    await userEvent.type(tags, "x , y, ,z");
    fireEvent.change(screen.getByDisplayValue("Homelab"), { target: { value: "house" } });
    fireEvent.change(screen.getByDisplayValue("active"), { target: { value: "done" } });

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
    expect(updateProject).toHaveBeenCalledWith("p1", {
      status: "done",
      group: "house",
      summary: "new summary",
      domain: ["x", "y", "z"],
      // Keeper settings default to the project's current (concrete) values.
      model: "claude-opus-4-8",
      permissionMode: "acceptEdits",
      maxTurns: 200,
      docker: false,
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("edits keeper-agent settings and sends them in the patch (issue #12)", async () => {
    const project = makeProject({ slug: "p1" });
    render(<EditProjectModal open project={project} onClose={() => {}} onSaved={vi.fn()} />);

    // Wait for the model list to load so the Sonnet option is selectable.
    await screen.findByRole("option", { name: "Sonnet 5" });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-sonnet-5" } });
    fireEvent.change(screen.getByLabelText("Permission mode"), { target: { value: "plan" } });
    fireEvent.change(screen.getByLabelText("Max turns"), { target: { value: "50" } });
    fireEvent.click(screen.getByLabelText("Docker sandbox"));

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
    expect(updateProject).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        model: "claude-sonnet-5",
        permissionMode: "plan",
        maxTurns: 50,
        docker: true,
      }),
    );
  });

  it("preserves a custom/legacy area not in the canonical list", async () => {
    const project = makeProject({ slug: "p1", group: "garage" });
    render(<EditProjectModal open project={project} onClose={() => {}} onSaved={() => {}} />);
    // Let the async model load settle (flushes the setState inside act).
    await screen.findByRole("option", { name: "Opus 4.8" });
    // A custom <option> is injected and selected.
    const opt = screen.getByRole("option", { name: "garage" }) as HTMLOptionElement;
    expect(opt.selected).toBe(true);
  });

  it("surfaces an API error and stays open", async () => {
    const { ApiError } = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    updateProject.mockRejectedValueOnce(new ApiError("Unknown model: foo", 400));
    const onSaved = vi.fn();
    render(
      <EditProjectModal open project={makeProject({ slug: "p1" })} onClose={() => {}} onSaved={onSaved} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(screen.getByText(/Unknown model/i)).toBeInTheDocument());
    expect(onSaved).not.toHaveBeenCalled();
  });
});
