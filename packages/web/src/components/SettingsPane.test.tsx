import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsPane } from "./SettingsPane";
import { makeProject } from "../test/factories";

const updateProject = vi.fn();
const getModels = vi.fn();
const promoteProject = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      updateProject: (...a: unknown[]) => updateProject(...a),
      getModels: (...a: unknown[]) => getModels(...a),
      promoteProject: (...a: unknown[]) => promoteProject(...a),
      // Schedules moved out of Settings into the Triggers tab (Epic T / T4), so
      // SettingsPane no longer fetches them on mount.
    },
  };
});

describe("SettingsPane", () => {
  beforeEach(() => {
    updateProject.mockReset();
    updateProject.mockImplementation((_slug, patch) =>
      Promise.resolve(makeProject({ slug: "p1", ...patch })),
    );
    promoteProject.mockReset();
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
      curationDefault: { overviewMaxTokens: 2000, changelogMaxTokens: 8000, claudeMaxTokens: 6000 },
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
      // No curation budget override set -> inherits the instance defaults (issue #384).
      curation: null,
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("sends a per-project curation budget override in the patch (issue #384)", async () => {
    const project = makeProject({ slug: "p1", summary: "s" });
    render(<SettingsPane project={project} onSaved={() => {}} />);
    // The instance default is shown as the placeholder until overridden.
    const changelogField = await screen.findByLabelText("CHANGELOG.md token budget");
    expect(changelogField).toHaveAttribute("placeholder", "Instance default (8000)");

    await userEvent.type(changelogField, "3000");
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
    const patch = updateProject.mock.calls[0][1] as { curation: unknown };
    // Only the field set is sent; the others inherit (absent from the override).
    expect(patch.curation).toEqual({ changelogMaxTokens: 3000 });
  });

  it("prefills a curation override and clears it back to inherit (issue #384)", async () => {
    const project = makeProject({ slug: "p1", curation: { overviewMaxTokens: 1500 } });
    render(<SettingsPane project={project} onSaved={() => {}} />);
    const overviewField = await screen.findByLabelText("OVERVIEW.md token budget");
    expect(overviewField).toHaveValue(1500);

    // Clearing the field makes the whole override null (inherit) -> a dirty change.
    await userEvent.clear(overviewField);
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
    const patch = updateProject.mock.calls[0][1] as { curation: unknown };
    expect(patch.curation).toBeNull();
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

  // --- Repository backing / promotion (issue #213) -----------------------

  it("shows a promote affordance for a notebook project", () => {
    const project = makeProject({ slug: "p1", repoBacked: false });
    render(<SettingsPane project={project} onSaved={vi.fn()} />);
    expect(screen.getByText("Repository backing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /promote to repo-backed/i })).toBeDisabled();
    // Entering a valid URL enables the promote button.
    fireEvent.change(screen.getByLabelText("Git repository URL"), {
      target: { value: "https://github.com/owner/repo.git" },
    });
    expect(screen.getByRole("button", { name: /promote to repo-backed/i })).not.toBeDisabled();
  });

  it("flags an obviously-bad repo URL and keeps promote disabled", () => {
    const project = makeProject({ slug: "p1", repoBacked: false });
    render(<SettingsPane project={project} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Git repository URL"), {
      target: { value: "not a url" },
    });
    expect(screen.getByText(/doesn’t look like a git URL/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /promote to repo-backed/i })).toBeDisabled();
  });

  it("promotes through a two-step confirm and reports the updated project", async () => {
    const project = makeProject({ slug: "p1", name: "Note Book", repoBacked: false });
    const promoted = makeProject({
      slug: "p1",
      name: "Note Book",
      repoBacked: true,
      repo: "https://github.com/owner/repo.git",
      workingDir: "/data/projects/p1/repo",
    });
    promoteProject.mockResolvedValueOnce(promoted);
    const onSaved = vi.fn();
    render(<SettingsPane project={project} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText("Git repository URL"), {
      target: { value: "https://github.com/owner/repo.git" },
    });
    // First step reveals the confirm panel; it does NOT call the API yet.
    fireEvent.click(screen.getByRole("button", { name: /promote to repo-backed/i }));
    expect(promoteProject).not.toHaveBeenCalled();
    // Second step confirms.
    fireEvent.click(screen.getByRole("button", { name: /^yes, promote$/i }));
    await waitFor(() =>
      expect(promoteProject).toHaveBeenCalledWith("p1", "https://github.com/owner/repo.git"),
    );
    expect(onSaved).toHaveBeenCalledWith(promoted);
  });

  it("surfaces a promote API error without calling onSaved", async () => {
    const { ApiError } = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    promoteProject.mockRejectedValueOnce(new ApiError("git clone failed", 400));
    const project = makeProject({ slug: "p1", repoBacked: false });
    const onSaved = vi.fn();
    render(<SettingsPane project={project} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Git repository URL"), {
      target: { value: "https://github.com/owner/repo.git" },
    });
    fireEvent.click(screen.getByRole("button", { name: /promote to repo-backed/i }));
    fireEvent.click(screen.getByRole("button", { name: /^yes, promote$/i }));
    await waitFor(() => expect(screen.getByText(/git clone failed/i)).toBeInTheDocument());
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("shows the backing read-only for an already repo-backed project (no promote form)", () => {
    const project = makeProject({
      slug: "p1",
      repoBacked: true,
      repo: "https://github.com/owner/repo.git",
      workingDir: "/data/projects/p1/repo",
    });
    render(<SettingsPane project={project} onSaved={vi.fn()} />);
    expect(screen.getByText("Repository backing")).toBeInTheDocument();
    expect(screen.getByText("https://github.com/owner/repo.git")).toBeInTheDocument();
    expect(screen.getByText("/data/projects/p1/repo")).toBeInTheDocument();
    expect(screen.queryByLabelText("Git repository URL")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /promote to repo-backed/i }),
    ).not.toBeInTheDocument();
  });
});
