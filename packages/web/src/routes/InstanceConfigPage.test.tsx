import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { InstanceConfigPage } from "./InstanceConfigPage";
import type { InstanceConfig } from "../lib/types";

const getInstanceConfig = vi.fn();
const updateInstanceConfig = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      getInstanceConfig: (...a: unknown[]) => getInstanceConfig(...a),
      updateInstanceConfig: (...a: unknown[]) => updateInstanceConfig(...a),
    },
  };
});

/**
 * A small, representative config payload covering the states the UI branches on.
 * `pendingValue` (what the config FILE holds) equals `value` (what the running
 * process resolved) unless a case says otherwise — that is an instance whose
 * file and process agree.
 */
function sampleConfig(overrides: Partial<InstanceConfig> = {}): InstanceConfig {
  return {
    configPath: "/data/paddock.config.yaml",
    restartRequired: false,
    configVersion: "v1",
    groups: [
      {
        id: "curation",
        label: "Curation",
        fields: [
          {
            key: "curation.overviewMaxTokens",
            group: "curation",
            label: "OVERVIEW.md max tokens",
            type: "number",
            value: 2000,
            pendingValue: 2000,
            pendingRestart: false,
            default: 2000,
            editable: true,
            sensitive: false,
            envOverridden: false,
          },
          {
            key: "curation.changelogMaxTokens",
            group: "curation",
            label: "CHANGELOG.md max tokens",
            type: "number",
            value: 8000,
            pendingValue: 8000,
            pendingRestart: false,
            default: 8000,
            editable: true,
            sensitive: false,
            envOverridden: true,
            envVar: "PADDOCK_CURATION_CHANGELOG_MAX_TOKENS",
          },
        ],
      },
      {
        id: "advanced",
        label: "Advanced (read-only)",
        fields: [
          {
            key: "port",
            group: "advanced",
            label: "Port",
            type: "number",
            value: 7233,
            pendingValue: 7233,
            pendingRestart: false,
            default: 7233,
            editable: false,
            sensitive: false,
            envOverridden: false,
          },
        ],
      },
    ],
    ...overrides,
  };
}

/**
 * The same instance after a write the running process hasn't picked up: the file
 * says `pending`, the process is still on 2000. This is what the server reports
 * to the tab that just saved — and to any OTHER tab that reloads.
 */
function divergedConfig(pending: number, version = "v2"): InstanceConfig {
  const c = sampleConfig({ restartRequired: true, configVersion: version });
  const overview = c.groups[0].fields[0];
  overview.pendingValue = pending;
  overview.pendingRestart = true;
  return c;
}

const renderScreen = () =>
  render(
    <MemoryRouter>
      <InstanceConfigPage />
    </MemoryRouter>,
  );

describe("InstanceConfigPage (#385)", () => {
  beforeEach(() => {
    getInstanceConfig.mockReset();
    updateInstanceConfig.mockReset();
    getInstanceConfig.mockResolvedValue(sampleConfig());
    updateInstanceConfig.mockResolvedValue({
      restartRequired: true,
      configPath: "/data/paddock.config.yaml",
      configVersion: "v2",
    });
  });

  it("renders grouped fields and the restart banner", async () => {
    renderScreen();
    expect(await screen.findByText("OVERVIEW.md max tokens")).toBeInTheDocument();
    // Each group is a section heading. (Its label also appears in the section
    // rail, so match the heading specifically rather than the bare text.)
    expect(screen.getByRole("heading", { name: "Curation" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Advanced (read-only)" })).toBeInTheDocument();
    // The persistent restart notice is always present.
    expect(screen.getByText(/take effect only after the server restarts/i)).toBeInTheDocument();
  });

  it("renders env-overridden fields read-only, marked with the shadowing var", async () => {
    renderScreen();
    await screen.findByText("OVERVIEW.md max tokens");
    // The explanation is stated once as a legend, not repeated per field —
    // on a containerized instance most fields are env-shadowed.
    expect(screen.getByText(/overridden by an environment variable/i)).toBeInTheDocument();
    // The field itself carries an `env` chip and names the variable.
    expect(screen.getByText("PADDOCK_CURATION_CHANGELOG_MAX_TOKENS")).toBeInTheDocument();
    expect(
      screen.getByTitle(/Overridden by environment variable PADDOCK_CURATION_CHANGELOG_MAX_TOKENS/i),
    ).toBeInTheDocument();
  });

  it("filters fields live, across every group, by label / key / env var", async () => {
    renderScreen();
    await screen.findByText("OVERVIEW.md max tokens");
    const search = screen.getByRole("searchbox", { name: /search settings/i });

    // A label substring narrows to the one field, dropping the other group
    // entirely — search spans sections rather than being scoped to one.
    fireEvent.change(search, { target: { value: "overview" } });
    expect(screen.getByText("OVERVIEW.md max tokens")).toBeInTheDocument();
    expect(screen.queryByText("Port")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();

    // An operator who thinks in PADDOCK_* names finds the field by typing one.
    fireEvent.change(search, { target: { value: "PADDOCK_CURATION_CHANGELOG" } });
    expect(screen.getByText("CHANGELOG.md max tokens")).toBeInTheDocument();
    expect(screen.queryByText("OVERVIEW.md max tokens")).not.toBeInTheDocument();

    // No match says so rather than rendering an empty page.
    fireEvent.change(search, { target: { value: "zzzz" } });
    expect(screen.getByText(/No settings match/i)).toBeInTheDocument();
  });

  it("takes focus on load on a pointer device, and Escape clears the filter", async () => {
    // The autofocus is gated on `(min-width: 1024px)` so a phone does not get
    // the on-screen keyboard thrown over the page.
    vi.stubGlobal(
      "matchMedia",
      (q: string) =>
        ({
          matches: q === "(min-width: 1024px)",
          media: q,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    renderScreen();
    await screen.findByText("OVERVIEW.md max tokens");
    const search = screen.getByRole("searchbox", { name: /search settings/i });
    expect(search).toHaveFocus();

    fireEvent.change(search, { target: { value: "overview" } });
    expect(screen.queryByText("Port")).not.toBeInTheDocument();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.getByText("Port")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("does NOT take focus on a small screen", async () => {
    vi.stubGlobal(
      "matchMedia",
      (q: string) =>
        ({
          matches: false,
          media: q,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    renderScreen();
    await screen.findByText("OVERVIEW.md max tokens");
    expect(screen.getByRole("searchbox", { name: /search settings/i })).not.toHaveFocus();
    vi.unstubAllGlobals();
  });

  it("'Modified only' shows just the fields that differ from their default", async () => {
    renderScreen();
    await screen.findByText("OVERVIEW.md max tokens");
    // Every sample field currently equals its default.
    fireEvent.click(screen.getByRole("button", { name: /modified only/i }));
    expect(screen.getByText(/No settings match/i)).toBeInTheDocument();

    // A pending edit makes that field — and only it — modified.
    fireEvent.click(screen.getByRole("button", { name: /modified only/i }));
    fireEvent.change((await screen.findAllByRole("spinbutton"))[0], { target: { value: "2500" } });
    fireEvent.click(screen.getByRole("button", { name: /modified only/i }));
    expect(screen.getByText("OVERVIEW.md max tokens")).toBeInTheDocument();
    expect(screen.queryByText("Port")).not.toBeInTheDocument();
  });

  it("shows read-only bindings without an input", async () => {
    renderScreen();
    await screen.findByText("Port");
    // The editable curation field is a spinbutton; port (read-only) is not.
    const spinners = screen.getAllByRole("spinbutton");
    // Only the single editable, non-shadowed number field is an input.
    expect(spinners).toHaveLength(1);
  });

  it("saves only the dirty editable field and confirms restart", async () => {
    renderScreen();
    const input = (await screen.findAllByRole("spinbutton"))[0] as HTMLInputElement;
    // Initially nothing is dirty.
    expect(screen.getByText("No changes")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "2500" } });
    expect(screen.getByText(/1 unsaved change/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(updateInstanceConfig).toHaveBeenCalledTimes(1));
    // The version of the snapshot the edit was made against rides along, so a
    // concurrent write by another tab is refused rather than silently clobbered.
    expect(updateInstanceConfig).toHaveBeenCalledWith({ "curation.overviewMaxTokens": 2500 }, "v1");
    // Success banner appears after the write.
    expect(await screen.findByText(/Saved to disk/i)).toBeInTheDocument();
  });

  /**
   * Issue #722, the defect an operator actually saw: save 2500, get a green
   * "Saved to disk", and watch the box go back to 2000. The write was fine — the
   * form re-fetches after saving and rendered `value`, the boot-frozen number,
   * which no write can move. It must render what the FILE now says.
   */
  it("keeps the saved value on screen after the post-save re-fetch", async () => {
    getInstanceConfig
      .mockResolvedValueOnce(sampleConfig()) // initial load
      .mockResolvedValueOnce(divergedConfig(2500)); // the re-fetch after saving
    renderScreen();
    const input = (await screen.findAllByRole("spinbutton"))[0] as HTMLInputElement;

    fireEvent.change(input, { target: { value: "2500" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByText(/Saved to disk/i)).toBeInTheDocument();
    // The value the operator typed is still the value on screen…
    expect((screen.getAllByRole("spinbutton")[0] as HTMLInputElement).value).toBe("2500");
    // …and nothing is left dirty: the file already holds it.
    expect(screen.getByText("No changes")).toBeInTheDocument();
    // The running process is still on the old number, and the field says so.
    expect(screen.getByText(/In force now:/)).toBeInTheDocument();
    expect(screen.getByText("2000")).toBeInTheDocument();
  });

  it("shows a pending-restart banner when the file has diverged from the process", async () => {
    // e.g. another tab (or a hand edit) wrote the file since this instance booted.
    getInstanceConfig.mockResolvedValue(divergedConfig(1111));
    renderScreen();
    await screen.findByText("OVERVIEW.md max tokens");
    expect(screen.getByText(/Restart pending/i)).toBeInTheDocument();
    // The editor shows the FILE's value — before #722 no client could see it.
    expect((screen.getAllByRole("spinbutton")[0] as HTMLInputElement).value).toBe("1111");
    expect(screen.getByText("No changes")).toBeInTheDocument();
  });

  it("refuses to silently overwrite another tab's write, and keeps the edits", async () => {
    const { ApiError } = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    getInstanceConfig
      .mockResolvedValueOnce(sampleConfig()) // this tab loaded at v1
      .mockResolvedValueOnce(divergedConfig(1111, "v9")); // …the file is at v9 now
    updateInstanceConfig.mockRejectedValueOnce(
      new ApiError("The config file changed on disk since this page loaded", 409),
    );
    renderScreen();
    const input = (await screen.findAllByRole("spinbutton"))[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2222" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByText(/changed on disk/i)).toBeInTheDocument();
    // The edit is not thrown away — it is still pending against the refreshed
    // snapshot, so saving again is a deliberate, informed overwrite.
    expect((screen.getAllByRole("spinbutton")[0] as HTMLInputElement).value).toBe("2222");
    expect(screen.getByText(/1 unsaved change/)).toBeInTheDocument();
    await waitFor(() => expect(getInstanceConfig).toHaveBeenCalledTimes(2));

    updateInstanceConfig.mockResolvedValueOnce({
      restartRequired: true,
      configPath: "/data/paddock.config.yaml",
      configVersion: "v10",
    });
    getInstanceConfig.mockResolvedValueOnce(divergedConfig(2222, "v10"));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(updateInstanceConfig).toHaveBeenCalledTimes(2));
    // Second attempt carries the version it just re-read, not the stale one.
    expect(updateInstanceConfig).toHaveBeenLastCalledWith(
      { "curation.overviewMaxTokens": 2222 },
      "v9",
    );
  });

  it("surfaces a server validation error", async () => {
    const { ApiError } = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    updateInstanceConfig.mockRejectedValue(new ApiError("OVERVIEW.md max tokens must be a positive integer", 400));
    renderScreen();
    const input = (await screen.findAllByRole("spinbutton"))[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(await screen.findByText(/must be a positive integer/i)).toBeInTheDocument();
  });
});
