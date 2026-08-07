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

/** A small, representative config payload covering the states the UI branches on. */
function sampleConfig(overrides: Partial<InstanceConfig> = {}): InstanceConfig {
  return {
    configPath: "/data/paddock.config.yaml",
    restartRequired: false,
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
    updateInstanceConfig.mockResolvedValue({ restartRequired: true, configPath: "/data/paddock.config.yaml" });
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
    expect(updateInstanceConfig).toHaveBeenCalledWith({ "curation.overviewMaxTokens": 2500 });
    // Success banner appears after the write.
    expect(await screen.findByText(/Saved to disk/i)).toBeInTheDocument();
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
