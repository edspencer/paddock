import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { InstanceSettings } from "./InstanceSettings";
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
            value: 4000,
            default: 4000,
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
      <InstanceSettings />
    </MemoryRouter>,
  );

describe("InstanceSettings (#385)", () => {
  beforeEach(() => {
    getInstanceConfig.mockReset();
    updateInstanceConfig.mockReset();
    getInstanceConfig.mockResolvedValue(sampleConfig());
    updateInstanceConfig.mockResolvedValue({ restartRequired: true, configPath: "/data/paddock.config.yaml" });
  });

  it("renders grouped fields and the restart banner", async () => {
    renderScreen();
    expect(await screen.findByText("OVERVIEW.md max tokens")).toBeInTheDocument();
    expect(screen.getByText("Curation")).toBeInTheDocument();
    expect(screen.getByText("Advanced (read-only)")).toBeInTheDocument();
    // The persistent restart notice is always present.
    expect(screen.getByText(/take effect only after the server restarts/i)).toBeInTheDocument();
  });

  it("renders env-overridden fields read-only with the env note", async () => {
    renderScreen();
    await screen.findByText("OVERVIEW.md max tokens");
    // The env-shadowed field shows the override note and no editable input.
    expect(screen.getByText(/Overridden by environment variable/i)).toBeInTheDocument();
    expect(screen.getByText("PADDOCK_CURATION_CHANGELOG_MAX_TOKENS")).toBeInTheDocument();
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
