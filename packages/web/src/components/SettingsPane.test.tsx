import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsPane } from "./SettingsPane";
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

describe("SettingsPane", () => {
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
      keeperDriveModeDefault: "batch",
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
      visibility: "private",
    });
    render(<SettingsPane project={project} onSaved={() => {}} />);
    expect(screen.getByDisplayValue("Heater")).toBeInTheDocument();
    expect(screen.getByDisplayValue("old summary")).toBeInTheDocument();
    expect(screen.getByDisplayValue("home, plumbing")).toBeInTheDocument();
    expect((screen.getByRole("option", { name: "House" }) as HTMLOptionElement).selected).toBe(true);
    expect((screen.getByRole("option", { name: "paused" }) as HTMLOptionElement).selected).toBe(true);
    expect((screen.getByRole("option", { name: "Private" }) as HTMLOptionElement).selected).toBe(true);
  });

  it("shows immutable fields read-only (slug + dates)", () => {
    const project = makeProject({ slug: "p1", started: "2026-01-02", created: "2026-01-01" });
    render(<SettingsPane project={project} onSaved={() => {}} />);
    expect(screen.getByText("p1")).toBeInTheDocument();
    expect(screen.getByText("2026-01-02")).toBeInTheDocument();
    expect(screen.getByText("2026-01-01")).toBeInTheDocument();
    // The slug is shown as text, not an editable input.
    expect(screen.queryByDisplayValue("p1")).not.toBeInTheDocument();
  });

  it("disables Save until a field changes (dirty tracking)", async () => {
    const project = makeProject({ slug: "p1", summary: "s" });
    render(<SettingsPane project={project} onSaved={() => {}} />);
    const save = screen.getByRole("button", { name: /save changes/i });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByDisplayValue("s"), { target: { value: "changed" } });
    expect(save).not.toBeDisabled();
  });

  it("builds the update patch the server expects (identity + keeper fields)", async () => {
    const project = makeProject({ slug: "p1", summary: "s", domain: ["a"], group: "homelab" });
    const onSaved = vi.fn();
    render(<SettingsPane project={project} onSaved={onSaved} />);

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
      name: "Test Project",
      status: "done",
      group: "house",
      summary: "new summary",
      domain: ["x", "y", "z"],
      visibility: "public",
      links: [],
      // Keeper settings default to the project's current (concrete) values.
      model: "claude-opus-4-8",
      permissionMode: "acceptEdits",
      maxTurns: 200,
      docker: false,
      driveMode: null,
      // No per-project override set -> inherits the instance default (issue #262).
      maxSpawnDepth: null,
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("edits keeper-agent settings and sends them in the patch (issue #12)", async () => {
    const project = makeProject({ slug: "p1" });
    render(<SettingsPane project={project} onSaved={vi.fn()} />);

    // Wait for the model list to load so the Sonnet option is selectable.
    await screen.findByRole("option", { name: "Sonnet 5" });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-sonnet-5" } });
    fireEvent.change(screen.getByLabelText("Permission mode"), { target: { value: "plan" } });
    fireEvent.change(screen.getByLabelText("Max turns"), { target: { value: "50" } });
    fireEvent.click(screen.getByLabelText(/Run the keeper in a Docker sandbox/i));

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

  it("warns when bypassPermissions is selected", async () => {
    const project = makeProject({ slug: "p1", permissionMode: "acceptEdits" });
    render(<SettingsPane project={project} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Permission mode"), {
      target: { value: "bypassPermissions" },
    });
    expect(screen.getByText(/without asking/i)).toBeInTheDocument();
  });

  it("driveMode: shows the inherited global default and clears an override", async () => {
    const project = makeProject({ slug: "p1", driveMode: "session" });
    render(<SettingsPane project={project} onSaved={vi.fn()} />);
    // Load models so the global default (batch) is known.
    await screen.findByRole("option", { name: "Sonnet 5" });

    // Override is Session -> the reset affordance is shown.
    const drive = screen.getByLabelText("Drive mode") as HTMLSelectElement;
    expect(drive.value).toBe("session");
    fireEvent.click(screen.getByRole("button", { name: /reset to global default/i }));
    expect(drive.value).toBe("");
    // The inherited effective default (batch) is surfaced.
    expect(screen.getByText(/Inheriting the box-wide default/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
    expect(updateProject).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ driveMode: null }),
    );
  });

  it("maxSpawnDepth: sets a per-project override and sends it in the patch (issue #262)", async () => {
    const project = makeProject({ slug: "p1" });
    render(<SettingsPane project={project} onSaved={vi.fn()} />);
    await screen.findByRole("option", { name: "Sonnet 5" });

    const depth = screen.getByLabelText("Max spawn depth") as HTMLSelectElement;
    // No override initially -> inherits the instance default.
    expect(depth.value).toBe("");
    // Override to 0 (disables spawned tooling) -> the reset affordance appears.
    fireEvent.change(depth, { target: { value: "0" } });
    expect(depth.value).toBe("0");
    expect(
      screen.getByText(/Overriding the instance default/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
    expect(updateProject).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ maxSpawnDepth: 0 }),
    );
  });

  it("edits and persists labelled links", async () => {
    const project = makeProject({ slug: "p1", links: [] });
    render(<SettingsPane project={project} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /add link/i }));
    await userEvent.type(screen.getByLabelText("Link 1 label"), "Docs");
    await userEvent.type(screen.getByLabelText("Link 1 URL"), "https://example.com");

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
    expect(updateProject).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ links: [{ label: "Docs", url: "https://example.com" }] }),
    );
  });

  it("blocks save on an empty name", () => {
    const project = makeProject({ slug: "p1", name: "Named" });
    render(<SettingsPane project={project} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue("Named"), { target: { value: "  " } });
    expect(screen.getByRole("button", { name: /save changes/i })).toBeDisabled();
    expect(screen.getByText(/can’t be empty/i)).toBeInTheDocument();
  });

  it("surfaces an API error and does not call onSaved", async () => {
    const { ApiError } = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    updateProject.mockRejectedValueOnce(new ApiError("Unknown model: foo", 400));
    const project = makeProject({ slug: "p1", summary: "s" });
    const onSaved = vi.fn();
    render(<SettingsPane project={project} onSaved={onSaved} />);
    fireEvent.change(screen.getByDisplayValue("s"), { target: { value: "changed" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(screen.getByText(/Unknown model/i)).toBeInTheDocument());
    expect(onSaved).not.toHaveBeenCalled();
  });
});
