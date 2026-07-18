import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SchedulesSection } from "./SchedulesSection";
import { makeProject } from "../test/factories";
import type { Schedule } from "../lib/types";

const listSchedules = vi.fn();
const putSchedule = vi.fn();
const deleteSchedule = vi.fn();
const setScheduleEnabled = vi.fn();
const triggerSchedule = vi.fn();

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      listSchedules: (...a: unknown[]) => listSchedules(...a),
      putSchedule: (...a: unknown[]) => putSchedule(...a),
      deleteSchedule: (...a: unknown[]) => deleteSchedule(...a),
      setScheduleEnabled: (...a: unknown[]) => setScheduleEnabled(...a),
      triggerSchedule: (...a: unknown[]) => triggerSchedule(...a),
    },
  };
});

function makeSchedule(over: Partial<Schedule> = {}): Schedule {
  return {
    name: "daily",
    type: "cron",
    cron: "0 9 * * *",
    interval: null,
    prompt: "morning triage",
    promptFile: null,
    resumeSession: false,
    enabled: true,
    status: "idle",
    lastRunAt: null,
    nextRunAt: null,
    lastError: null,
    ...over,
  };
}

const project = makeProject({ slug: "p1" });

describe("SchedulesSection", () => {
  beforeEach(() => {
    listSchedules.mockReset();
    putSchedule.mockReset();
    deleteSchedule.mockReset();
    setScheduleEnabled.mockReset();
    triggerSchedule.mockReset();
  });

  it("lists a project's schedules with type, expression, and session mode", async () => {
    listSchedules.mockResolvedValue({ schedules: [makeSchedule()], mutationEnabled: true });
    render(<SchedulesSection project={project} />);
    const row = await screen.findByRole("row", { name: /daily/ });
    expect(within(row).getByText("cron")).toBeInTheDocument();
    expect(within(row).getByText("0 9 * * *")).toBeInTheDocument();
    expect(within(row).getByText("New chat")).toBeInTheDocument();
  });

  it("renders read-only with a hint when mutation is disabled", async () => {
    listSchedules.mockResolvedValue({ schedules: [makeSchedule()], mutationEnabled: false });
    render(<SchedulesSection project={project} />);
    await screen.findByRole("row", { name: /daily/ });
    // The disabled-deployment hint shows, and there's no Add / edit / delete.
    expect(screen.getByText(/Schedule editing is disabled/i)).toBeInTheDocument();
    expect(screen.queryByTestId("add-schedule")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit daily/ })).not.toBeInTheDocument();
    // Trigger-now stays available even when editing is off.
    expect(screen.getByRole("button", { name: /Trigger daily now/ })).toBeInTheDocument();
  });

  it("creates a schedule through the editor", async () => {
    listSchedules
      .mockResolvedValueOnce({ schedules: [], mutationEnabled: true })
      .mockResolvedValueOnce({
        schedules: [makeSchedule({ name: "triage", type: "interval", cron: null, interval: "30m" })],
        mutationEnabled: true,
      });
    putSchedule.mockResolvedValue(makeSchedule({ name: "triage" }));
    render(<SchedulesSection project={project} />);

    await screen.findByText(/No schedules yet/i);
    fireEvent.click(screen.getByTestId("add-schedule"));

    await userEvent.type(screen.getByTestId("schedule-name"), "triage");
    // Default type is interval — fill the interval expression + inline prompt.
    await userEvent.type(screen.getByTestId("schedule-expr"), "30m");
    await userEvent.type(screen.getByTestId("schedule-prompt"), "do the triage");
    fireEvent.click(screen.getByTestId("schedule-save"));

    await waitFor(() => expect(putSchedule).toHaveBeenCalledTimes(1));
    expect(putSchedule).toHaveBeenCalledWith("p1", "triage", {
      type: "interval",
      interval: "30m",
      prompt: "do the triage",
      resume_session: false,
      enabled: true,
    });
    // The list reloaded and shows the new row.
    expect(await screen.findByRole("row", { name: /triage/ })).toBeInTheDocument();
  });

  it("blocks save until name, expression, and prompt are valid", async () => {
    listSchedules.mockResolvedValue({ schedules: [], mutationEnabled: true });
    render(<SchedulesSection project={project} />);
    await screen.findByText(/No schedules yet/i);
    fireEvent.click(screen.getByTestId("add-schedule"));

    const save = screen.getByTestId("schedule-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true); // empty form
    await userEvent.type(screen.getByTestId("schedule-name"), "ok");
    await userEvent.type(screen.getByTestId("schedule-expr"), "30m");
    expect(save.disabled).toBe(true); // prompt still empty
    await userEvent.type(screen.getByTestId("schedule-prompt"), "go");
    expect(save.disabled).toBe(false);
  });

  it("triggers a schedule now", async () => {
    listSchedules.mockResolvedValue({ schedules: [makeSchedule()], mutationEnabled: true });
    triggerSchedule.mockResolvedValue("sess-123");
    render(<SchedulesSection project={project} />);
    await screen.findByRole("row", { name: /daily/ });
    fireEvent.click(screen.getByRole("button", { name: /Trigger daily now/ }));
    await waitFor(() => expect(triggerSchedule).toHaveBeenCalledWith("p1", "daily"));
    expect(await screen.findByText(/a scheduled chat is starting/i)).toBeInTheDocument();
  });

  it("toggles enabled state", async () => {
    listSchedules.mockResolvedValue({ schedules: [makeSchedule({ enabled: true })], mutationEnabled: true });
    setScheduleEnabled.mockResolvedValue(makeSchedule({ enabled: false, status: "disabled" }));
    render(<SchedulesSection project={project} />);
    await screen.findByRole("row", { name: /daily/ });
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(setScheduleEnabled).toHaveBeenCalledWith("p1", "daily", false));
    // The row now offers Enable.
    expect(await screen.findByRole("button", { name: "Enable" })).toBeInTheDocument();
  });
});
