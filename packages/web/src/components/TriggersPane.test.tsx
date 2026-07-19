import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TriggersPane } from "./TriggersPane";
import type { GrantableTool, Project, Trigger, TriggersResponse } from "../lib/types";

// --- api mock ---------------------------------------------------------------
const listTriggers = vi.fn();
const putTrigger = vi.fn();
const deleteTrigger = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      listTriggers: (...a: unknown[]) => listTriggers(...a),
      putTrigger: (...a: unknown[]) => putTrigger(...a),
      deleteTrigger: (...a: unknown[]) => deleteTrigger(...a),
    },
  };
});

const GRANTABLE: GrantableTool[] = [
  { name: "Read", group: "read", description: "Read files" },
  { name: "Bash", group: "write", description: "Run shell commands" },
];

function response(triggers: Trigger[]): TriggersResponse {
  return {
    triggers,
    grantableTools: GRANTABLE,
    events: ["onArchive", "afterTurn"],
    triggerTypes: ["schedule", "event", "webhook"],
  };
}

const project = { slug: "p", name: "P" } as unknown as Project;

const dailyManager: Trigger = {
  name: "daily-manager",
  agentName: "trigger-p-daily-manager",
  trigger: { type: "schedule", cron: "0 9 * * *" },
  run: { session: "resume", tools: ["Read", "Bash"], model: "claude-opus-4-8" },
  enabled: true,
};

const archiveCleanup: Trigger = {
  name: "archive-cleanup",
  agentName: "trigger-p-archive-cleanup",
  trigger: { type: "event", on: "onArchive" },
  run: { session: "new", tools: ["Bash"] },
  enabled: false,
};

beforeEach(() => {
  listTriggers.mockReset();
  putTrigger.mockReset();
  deleteTrigger.mockReset();
  listTriggers.mockResolvedValue(response([dailyManager, archiveCleanup]));
  putTrigger.mockImplementation((_slug, name, input) =>
    Promise.resolve({ name, agentName: `trigger-p-${name}`, ...input }),
  );
  deleteTrigger.mockResolvedValue(undefined);
});

describe("TriggersPane (Epic T / T4)", () => {
  it("lists triggers with a type badge, firing condition and capability summary", async () => {
    render(<TriggersPane project={project} />);
    await screen.findByTestId("triggers-pane");
    const sched = await screen.findByRole("row", { name: /daily-manager/ });
    // Type badge reflects the discriminant.
    expect(within(sched).getByText(/schedule/i)).toBeInTheDocument();
    expect(sched.querySelector('[data-trigger-type="schedule"]')).not.toBeNull();
    // Firing condition + capability summary.
    expect(within(sched).getByText("0 9 * * *")).toBeInTheDocument();
    expect(within(sched).getByText(/2 tools/)).toBeInTheDocument();

    const evt = await screen.findByRole("row", { name: /archive-cleanup/ });
    expect(evt.querySelector('[data-trigger-type="event"]')).not.toBeNull();
    expect(within(evt).getByText("onArchive")).toBeInTheDocument();
  });

  it("creates an EVENT trigger through the discriminated form", async () => {
    listTriggers.mockResolvedValueOnce(response([]));
    render(<TriggersPane project={project} />);
    await screen.findByTestId("triggers-pane");
    fireEvent.click(await screen.findByTestId("add-trigger"));

    fireEvent.change(screen.getByTestId("trigger-name"), { target: { value: "cleanup" } });
    fireEvent.change(screen.getByTestId("trigger-type"), { target: { value: "event" } });
    fireEvent.change(screen.getByTestId("trigger-event"), { target: { value: "onArchive" } });
    fireEvent.change(screen.getByTestId("trigger-prompt"), { target: { value: "Tidy up." } });
    // Grant a tool.
    fireEvent.click(screen.getByTestId("trigger-tools").querySelector('[data-tool="Bash"]')!);
    fireEvent.click(screen.getByTestId("trigger-save"));

    await waitFor(() => expect(putTrigger).toHaveBeenCalled());
    const [, name, input] = putTrigger.mock.calls[0];
    expect(name).toBe("cleanup");
    expect(input.trigger).toEqual({ type: "event", on: "onArchive" });
    expect(input.run.tools).toEqual(["Bash"]);
    expect(input.run.prompt).toBe("Tidy up.");
    // New triggers default disabled.
    expect(input.enabled).toBe(false);
  });

  it("creates a SCHEDULE trigger with a cron expression", async () => {
    listTriggers.mockResolvedValueOnce(response([]));
    render(<TriggersPane project={project} />);
    await screen.findByTestId("triggers-pane");
    fireEvent.click(await screen.findByTestId("add-trigger"));

    fireEvent.change(screen.getByTestId("trigger-name"), { target: { value: "nightly" } });
    fireEvent.change(screen.getByTestId("trigger-type"), { target: { value: "schedule" } });
    fireEvent.change(screen.getByTestId("trigger-schedule-kind"), { target: { value: "cron" } });
    fireEvent.change(screen.getByTestId("trigger-expr"), { target: { value: "0 3 * * *" } });
    fireEvent.change(screen.getByTestId("trigger-prompt"), { target: { value: "Dream." } });
    fireEvent.click(screen.getByTestId("trigger-save"));

    await waitFor(() => expect(putTrigger).toHaveBeenCalled());
    const [, name, input] = putTrigger.mock.calls[0];
    expect(name).toBe("nightly");
    expect(input.trigger).toEqual({ type: "schedule", cron: "0 3 * * *" });
    expect(input.run.session).toBe("new");
  });

  it("shows the webhook type but marks it reserved and blocks saving", async () => {
    listTriggers.mockResolvedValueOnce(response([]));
    render(<TriggersPane project={project} />);
    await screen.findByTestId("triggers-pane");
    fireEvent.click(await screen.findByTestId("add-trigger"));

    fireEvent.change(screen.getByTestId("trigger-name"), { target: { value: "wh" } });
    fireEvent.change(screen.getByTestId("trigger-type"), { target: { value: "webhook" } });
    fireEvent.change(screen.getByTestId("trigger-path"), { target: { value: "/gh" } });
    fireEvent.change(screen.getByTestId("trigger-prompt"), { target: { value: "Triage." } });

    expect(screen.getByTestId("trigger-webhook-reserved")).toBeInTheDocument();
    expect(screen.getByTestId("trigger-save")).toBeDisabled();
  });

  it("toggles enabled via a full-replace PUT with the flag flipped", async () => {
    render(<TriggersPane project={project} />);
    await screen.findByTestId("triggers-pane");
    const evt = await screen.findByRole("row", { name: /archive-cleanup/ });
    fireEvent.click(within(evt).getByRole("button", { name: /enable/i }));

    await waitFor(() => expect(putTrigger).toHaveBeenCalled());
    const [, name, input] = putTrigger.mock.calls[0];
    expect(name).toBe("archive-cleanup");
    expect(input.enabled).toBe(true);
    // Full replace preserves the WHEN + WHAT.
    expect(input.trigger).toEqual({ type: "event", on: "onArchive" });
    expect(input.run.tools).toEqual(["Bash"]);
  });

  it("deletes a trigger after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<TriggersPane project={project} />);
    await screen.findByTestId("triggers-pane");
    const sched = await screen.findByRole("row", { name: /daily-manager/ });
    fireEvent.click(within(sched).getByRole("button", { name: /delete daily-manager/i }));
    await waitFor(() => expect(deleteTrigger).toHaveBeenCalledWith("p", "daily-manager"));
  });
});
