import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HooksPane } from "./HooksPane";
import { makeProject } from "../test/factories";
import type { GrantableTool, Hook } from "../lib/types";

const listHooks = vi.fn();
const putHook = vi.fn();
const deleteHook = vi.fn();

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      listHooks: (...a: unknown[]) => listHooks(...a),
      putHook: (...a: unknown[]) => putHook(...a),
      deleteHook: (...a: unknown[]) => deleteHook(...a),
    },
  };
});

const TOOLS: GrantableTool[] = [
  { name: "Read", group: "read", description: "Read a file." },
  { name: "Write", group: "write", description: "Write a file." },
  { name: "Bash", group: "write", description: "Run shell commands." },
];

function makeHook(over: Partial<Hook> = {}): Hook {
  return {
    name: "cleanup",
    agentName: "hook-p1-cleanup",
    event: "onArchive",
    capabilities: { allowedTools: ["Bash", "Read"] },
    prompt: "spin down servers",
    enabled: false,
    ...over,
  };
}

function listResp(hooks: Hook[]) {
  return { hooks, grantableTools: TOOLS, events: ["onArchive"] as const };
}

const project = makeProject({ slug: "p1" });

describe("HooksPane", () => {
  beforeEach(() => {
    listHooks.mockReset();
    putHook.mockReset();
    deleteHook.mockReset();
  });

  it("lists a project's hooks with event, capability summary, and status", async () => {
    listHooks.mockResolvedValue(listResp([makeHook()]));
    render(<HooksPane project={project} />);
    const row = await screen.findByRole("row", { name: /cleanup/ });
    expect(within(row).getByText("onArchive")).toBeInTheDocument();
    expect(within(row).getByText("2 tools")).toBeInTheDocument();
    expect(within(row).getByText("Disabled")).toBeInTheDocument();
  });

  it("shows a tool-less hook as such", async () => {
    listHooks.mockResolvedValue(listResp([makeHook({ capabilities: undefined })]));
    render(<HooksPane project={project} />);
    const row = await screen.findByRole("row", { name: /cleanup/ });
    expect(within(row).getByText("Tool-less")).toBeInTheDocument();
  });

  it("creates a hook through the capability picker (disabled by default)", async () => {
    listHooks
      .mockResolvedValueOnce(listResp([]))
      .mockResolvedValueOnce(listResp([makeHook({ name: "onarch" })]));
    putHook.mockResolvedValue(makeHook({ name: "onarch" }));
    render(<HooksPane project={project} />);

    await screen.findByText(/No hooks yet/i);
    fireEvent.click(screen.getByTestId("add-hook"));

    await userEvent.type(screen.getByTestId("hook-name"), "onarch");
    await userEvent.type(screen.getByTestId("hook-prompt"), "do cleanup");
    // Grant Bash via the capability picker.
    const bash = screen.getByTestId("hook-tools").querySelector('input[data-tool="Bash"]');
    fireEvent.click(bash as Element);
    fireEvent.click(screen.getByTestId("hook-save"));

    await waitFor(() => expect(putHook).toHaveBeenCalledTimes(1));
    expect(putHook).toHaveBeenCalledWith("p1", "onarch", {
      event: "onArchive",
      enabled: false, // new hooks default disabled (GG-3)
      capabilities: { allowedTools: ["Bash"] },
      prompt: "do cleanup",
    });
    expect(await screen.findByRole("row", { name: /onarch/ })).toBeInTheDocument();
  });

  it("warns when Bash is granted", async () => {
    listHooks.mockResolvedValue(listResp([]));
    render(<HooksPane project={project} />);
    await screen.findByText(/No hooks yet/i);
    fireEvent.click(screen.getByTestId("add-hook"));
    expect(screen.queryByText(/arbitrary shell commands/i)).not.toBeInTheDocument();
    const bash = screen.getByTestId("hook-tools").querySelector('input[data-tool="Bash"]');
    fireEvent.click(bash as Element);
    expect(screen.getByText(/arbitrary shell commands/i)).toBeInTheDocument();
  });

  it("blocks save until name and prompt are valid", async () => {
    listHooks.mockResolvedValue(listResp([]));
    render(<HooksPane project={project} />);
    await screen.findByText(/No hooks yet/i);
    fireEvent.click(screen.getByTestId("add-hook"));

    const save = screen.getByTestId("hook-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true); // empty form
    await userEvent.type(screen.getByTestId("hook-name"), "ok");
    expect(save.disabled).toBe(true); // prompt still empty
    await userEvent.type(screen.getByTestId("hook-prompt"), "go");
    expect(save.disabled).toBe(false);
  });

  it("toggles enabled via a set with the flag flipped (no separate verb)", async () => {
    listHooks.mockResolvedValue(listResp([makeHook({ enabled: false })]));
    putHook.mockResolvedValue(makeHook({ enabled: true }));
    render(<HooksPane project={project} />);
    await screen.findByRole("row", { name: /cleanup/ });
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() =>
      expect(putHook).toHaveBeenCalledWith(
        "p1",
        "cleanup",
        expect.objectContaining({ enabled: true, event: "onArchive" }),
      ),
    );
    expect(await screen.findByRole("button", { name: "Disable" })).toBeInTheDocument();
  });

  it("edits an existing hook, prefilling its granted tools", async () => {
    listHooks.mockResolvedValue(listResp([makeHook()]));
    putHook.mockResolvedValue(makeHook());
    render(<HooksPane project={project} />);
    await screen.findByRole("row", { name: /cleanup/ });
    fireEvent.click(screen.getByRole("button", { name: /Edit cleanup/ }));
    // The picker reflects the persisted grant (Bash + Read checked).
    const tools = screen.getByTestId("hook-tools");
    expect((tools.querySelector('input[data-tool="Bash"]') as HTMLInputElement).checked).toBe(true);
    expect((tools.querySelector('input[data-tool="Read"]') as HTMLInputElement).checked).toBe(true);
    expect((tools.querySelector('input[data-tool="Write"]') as HTMLInputElement).checked).toBe(false);
    // The name is read-only when editing.
    expect((screen.getByTestId("hook-name") as HTMLInputElement).disabled).toBe(true);
  });

  it("deletes a hook", async () => {
    listHooks.mockResolvedValue(listResp([makeHook()]));
    deleteHook.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<HooksPane project={project} />);
    await screen.findByRole("row", { name: /cleanup/ });
    fireEvent.click(screen.getByRole("button", { name: /Delete cleanup/ }));
    await waitFor(() => expect(deleteHook).toHaveBeenCalledWith("p1", "cleanup"));
    expect(screen.queryByRole("row", { name: /cleanup/ })).not.toBeInTheDocument();
  });
});
