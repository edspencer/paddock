/**
 * The `string-list` control on the instance-settings form (issue #756).
 *
 * The sibling `text` type already keeps three states visibly distinct
 * (see InstanceConfigTextField.test.tsx); `string-list` did not, and the
 * consequence went past cosmetics:
 *
 *   pending `null` → "using the built-in default" (renders the default list)
 *   `[]`           → "empty — none offered" (an explicit empty override)
 *   `[…]`          → that list instead of the default
 *
 * `null` used to render as a completely blank box with no placeholder, so
 * "unset" and "explicitly emptied" looked identical and neither said what was in
 * force — Offered models showed nothing while all five catalog models were being
 * offered. And because the onChange filters empty strings, an emptied box
 * produces `[]` and never `null`: without a Restore default, "unset" was
 * UNREACHABLE from the UI once the field had been touched. That is the half a
 * placeholder alone would not have fixed, so it gets its own test below.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InstanceConfigForm } from "./InstanceConfigForm";
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

const CATALOG = [
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
];
const JOINED = CATALOG.join(", ");

function configWith(value: unknown): InstanceConfig {
  return {
    configPath: "/data/paddock.config.yaml",
    restartRequired: false,
    configVersion: "v1",
    groups: [
      {
        id: "capabilities",
        label: "Capabilities",
        fields: [
          {
            key: "models",
            group: "capabilities",
            label: "Offered models",
            type: "string-list",
            value,
            pendingValue: value,
            pendingRestart: false,
            default: CATALOG,
            editable: true,
            sensitive: false,
            envOverridden: false,
          },
        ],
      },
    ],
  };
}

const box = () => screen.getByRole("textbox") as HTMLInputElement;

describe("InstanceConfigForm — `string-list` field (#756)", () => {
  beforeEach(() => {
    getInstanceConfig.mockReset();
    updateInstanceConfig.mockReset();
    updateInstanceConfig.mockResolvedValue({
      restartRequired: true,
      configPath: "/data/paddock.config.yaml",
    });
  });

  it("shows the default that is in force when there is no override, not a blank box", async () => {
    getInstanceConfig.mockResolvedValue(configWith(null));
    render(<InstanceConfigForm />);
    await screen.findByText("Offered models");
    // The bug: this was "".
    expect(box().value).toBe(JOINED);
    expect(screen.getByText(/using the built-in default/i)).toBeInTheDocument();
    expect(screen.getByText("No changes")).toBeInTheDocument();
  });

  it("does not offer Restore default when nothing is overridden", async () => {
    getInstanceConfig.mockResolvedValue(configWith(null));
    render(<InstanceConfigForm />);
    await screen.findByText("Offered models");
    expect(screen.queryByRole("button", { name: /restore default/i })).toBeNull();
  });

  it("keeps an explicit empty override distinct from unset", async () => {
    getInstanceConfig.mockResolvedValue(configWith(null));
    render(<InstanceConfigForm />);
    await screen.findByText("Offered models");

    fireEvent.change(box(), { target: { value: "" } });
    expect(screen.getByText(/none offered/i)).toBeInTheDocument();
    expect(screen.queryByText(/using the built-in default/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(updateInstanceConfig).toHaveBeenCalledTimes(1));
    expect(updateInstanceConfig).toHaveBeenCalledWith({ models: [] }, "v1");
  });

  it("makes `null` reachable from an override, even after the box is emptied", async () => {
    // The half a placeholder cannot fix. Starting from a SAVED override (so
    // there is really something to undo), empty the box — the onChange filters
    // empties, so this yields `[]` and never `null` — and then get back to
    // unset. Restore default is the only control that can do it.
    getInstanceConfig.mockResolvedValue(configWith(["claude-opus-5"]));
    render(<InstanceConfigForm />);
    await screen.findByText("Offered models");
    expect(box().value).toBe("claude-opus-5");

    fireEvent.change(box(), { target: { value: "" } });
    expect(screen.getByText(/none offered/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /restore default/i }));
    expect(box().value).toBe(JOINED);
    expect(screen.getByText(/using the built-in default/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(updateInstanceConfig).toHaveBeenCalledTimes(1));
    // null ⇒ the writer deletes the key, so the instance tracks future catalog
    // additions instead of pinning today's five models.
    expect(updateInstanceConfig).toHaveBeenCalledWith({ models: null }, "v1");
  });

  it("sends a real override as a trimmed list", async () => {
    getInstanceConfig.mockResolvedValue(configWith(null));
    render(<InstanceConfigForm />);
    await screen.findByText("Offered models");

    fireEvent.change(box(), { target: { value: " claude-opus-5 ,claude-sonnet-5 " } });
    expect(screen.getByText(/2 in the list/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(updateInstanceConfig).toHaveBeenCalledTimes(1));
    expect(updateInstanceConfig).toHaveBeenCalledWith(
      { models: ["claude-opus-5", "claude-sonnet-5"] },
      "v1",
    );
  });

  it("treats a saved list identical to the default as defaulted", async () => {
    // Same reasoning as the `text` field: what is in force IS the default, so
    // offering Restore default would imply an override the operator can undo.
    getInstanceConfig.mockResolvedValue(configWith(CATALOG));
    render(<InstanceConfigForm />);
    await screen.findByText("Offered models");
    expect(box().value).toBe(JOINED);
    expect(screen.getByText(/using the built-in default/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /restore default/i })).toBeNull();
  });
});
