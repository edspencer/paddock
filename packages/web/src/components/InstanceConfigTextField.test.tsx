/**
 * The multi-line `text` control on the instance-settings form (issue #635).
 *
 * A prompt is the first setting on this screen where an empty box is a real
 * choice rather than an absence, so the three states must stay visibly
 * distinct in the UI:
 *
 *   pending `null` → "using the built-in default" (renders the default text)
 *   `""`           → "empty — nothing will be appended" (the opt-out)
 *   any text       → that text, sent verbatim
 *
 * Collapsing the first two — the obvious implementation — would make "restore
 * the default" and "turn it off" look identical in the box, which is exactly
 * the confusion this control exists to avoid.
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

const BUILT_IN = "You are running in Paddock, a web app.\n\n- Show, don't describe.";

function configWith(value: unknown, envOverridden = false): InstanceConfig {
  return {
    configPath: "/data/paddock.config.yaml",
    restartRequired: false,
    groups: [
      {
        id: "capabilities",
        label: "Capabilities",
        fields: [
          {
            key: "environmentPrompt",
            group: "capabilities",
            label: "Environment prompt",
            type: "text",
            value,
            default: BUILT_IN,
            editable: true,
            sensitive: false,
            envOverridden,
            ...(envOverridden ? { envVar: "PADDOCK_ENVIRONMENT_PROMPT" } : {}),
          },
        ],
      },
    ],
  };
}

const textarea = () => screen.getByRole("textbox") as HTMLTextAreaElement;

describe("InstanceConfigForm — multi-line `text` field (#635)", () => {
  beforeEach(() => {
    getInstanceConfig.mockReset();
    updateInstanceConfig.mockReset();
    updateInstanceConfig.mockResolvedValue({
      restartRequired: true,
      configPath: "/data/paddock.config.yaml",
    });
  });

  it("renders a textarea seeded with the effective text", async () => {
    getInstanceConfig.mockResolvedValue(configWith(BUILT_IN));
    render(<InstanceConfigForm />);
    await screen.findByText("Environment prompt");
    expect(textarea().tagName).toBe("TEXTAREA");
    expect(textarea().value).toBe(BUILT_IN);
    expect(screen.getByText("No changes")).toBeInTheDocument();
  });

  it("keeps newlines and sends multi-line text verbatim", async () => {
    getInstanceConfig.mockResolvedValue(configWith(BUILT_IN));
    getInstanceConfig.mockResolvedValueOnce(configWith(BUILT_IN));
    render(<InstanceConfigForm />);
    await screen.findByText("Environment prompt");

    const multi = "line one: colons\n  `backticked` — ✅\nline three\n";
    fireEvent.change(textarea(), { target: { value: multi } });
    expect(textarea().value).toBe(multi);
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(updateInstanceConfig).toHaveBeenCalledTimes(1));
    expect(updateInstanceConfig).toHaveBeenCalledWith({ environmentPrompt: multi });
  });

  it("clearing the box sends an empty string — the opt-out, not a reset", async () => {
    getInstanceConfig.mockResolvedValue(configWith(BUILT_IN));
    render(<InstanceConfigForm />);
    await screen.findByText("Environment prompt");

    fireEvent.change(textarea(), { target: { value: "" } });
    expect(screen.getByText(/nothing will be appended/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(updateInstanceConfig).toHaveBeenCalledTimes(1));
    expect(updateInstanceConfig).toHaveBeenCalledWith({ environmentPrompt: "" });
  });

  it("\"Restore default\" sends null (delete the key), and shows the default text", async () => {
    getInstanceConfig.mockResolvedValue(configWith("custom operator text"));
    render(<InstanceConfigForm />);
    await screen.findByText("Environment prompt");
    expect(textarea().value).toBe("custom operator text");

    fireEvent.click(screen.getByRole("button", { name: /restore default/i }));
    // The box now previews what would actually be in force.
    expect(textarea().value).toBe(BUILT_IN);
    expect(screen.getByText(/using the built-in default/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(updateInstanceConfig).toHaveBeenCalledTimes(1));
    // null ⇒ the writer deletes the key, so the instance tracks future revisions
    // of the built-in text rather than pinning today's copy of it.
    expect(updateInstanceConfig).toHaveBeenCalledWith({ environmentPrompt: null });
  });

  it("offers no Restore default when the value already IS the default", async () => {
    getInstanceConfig.mockResolvedValue(configWith(BUILT_IN));
    render(<InstanceConfigForm />);
    await screen.findByText("Environment prompt");
    expect(screen.queryByRole("button", { name: /restore default/i })).toBeNull();
  });

  it("renders read-only, multi-line, when an env var shadows it", async () => {
    getInstanceConfig.mockResolvedValue(configWith("from the environment", true));
    render(<InstanceConfigForm />);
    await screen.findByText("Environment prompt");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("from the environment")).toBeInTheDocument();
    expect(screen.getByText("PADDOCK_ENVIRONMENT_PROMPT")).toBeInTheDocument();
  });

  it("says 'nothing appended' rather than '(not set)' for a shadowed empty value", async () => {
    // A defined-but-blank PADDOCK_ENVIRONMENT_PROMPT is the env-level opt-out;
    // calling that "(not set)" would read as the opposite of what it does.
    getInstanceConfig.mockResolvedValue(configWith("", true));
    render(<InstanceConfigForm />);
    await screen.findByText("Environment prompt");
    expect(screen.getByText(/nothing appended/i)).toBeInTheDocument();
  });
});
