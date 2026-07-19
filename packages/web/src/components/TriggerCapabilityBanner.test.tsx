import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TriggerCapabilityBanner } from "./TriggerCapabilityBanner";
import type { ChatTriggerInfo } from "../lib/types";

/**
 * The read-only capability banner atop a trigger chat (Epic T / T4 — the unified
 * successor to the hook banner). It must be truthful-from-config: it states the
 * trigger's type + firing condition and the EXACT tools its agent was granted, and
 * offers an affordance toward the Triggers tab. It never grants or escalates anything.
 */
function renderBanner(trigger: ChatTriggerInfo, slug = "my-proj") {
  return render(
    <MemoryRouter>
      <TriggerCapabilityBanner trigger={trigger} projectSlug={slug} />
    </MemoryRouter>,
  );
}

const cleanup: ChatTriggerInfo = {
  name: "cleanup",
  type: "event",
  event: "onArchive",
  agentName: "trigger-my-proj-cleanup",
  enabled: true,
  allowedTools: ["Bash", "Read"],
  maxTurns: 12,
};

const nightly: ChatTriggerInfo = {
  name: "nightly-dreamer",
  type: "schedule",
  cron: "0 3 * * *",
  agentName: "trigger-my-proj-nightly-dreamer",
  enabled: true,
  allowedTools: ["Read", "Grep"],
  maxTurns: 30,
};

describe("TriggerCapabilityBanner (Epic T / T4)", () => {
  it("identifies it as a trigger agent, naming the trigger, its type and firing event", () => {
    renderBanner(cleanup);
    const banner = screen.getByTestId("trigger-capability-banner");
    expect(banner).toHaveTextContent("Trigger agent");
    expect(banner).toHaveTextContent("cleanup");
    expect(banner).toHaveTextContent(/event/i);
    expect(banner).toHaveTextContent("onArchive");
  });

  it("states a schedule trigger's cron expression", () => {
    renderBanner(nightly);
    const banner = screen.getByTestId("trigger-capability-banner");
    expect(banner).toHaveTextContent(/schedule/i);
    expect(banner).toHaveTextContent("0 3 * * *");
  });

  it("lists the exact granted tools (truthful from config)", () => {
    renderBanner(cleanup);
    const tools = screen.getByTestId("trigger-allowed-tools");
    expect(tools).toHaveTextContent("Bash");
    expect(tools).toHaveTextContent("Read");
  });

  it("describes a tool-less EVENT trigger as reasoning-only rather than listing tools", () => {
    renderBanner({ ...cleanup, allowedTools: [] });
    expect(screen.queryByTestId("trigger-allowed-tools")).toBeNull();
    const banner = screen.getByTestId("trigger-capability-banner");
    expect(banner).toHaveTextContent(/no tools|reasoning only|can only read/i);
  });

  it("describes a tool-less SCHEDULE trigger as running as the keeper", () => {
    renderBanner({ ...nightly, allowedTools: [] });
    const banner = screen.getByTestId("trigger-capability-banner");
    expect(banner).toHaveTextContent(/keeper/i);
  });

  it("flags a disabled trigger", () => {
    renderBanner({ ...cleanup, enabled: false });
    expect(screen.getByTestId("trigger-capability-banner")).toHaveTextContent(/disabled/i);
  });

  it("offers an affordance toward the Triggers tab", () => {
    renderBanner(cleanup);
    const link = screen.getByRole("link", { name: /edit trigger/i });
    expect(link.getAttribute("href")).toContain("/projects/my-proj/triggers");
  });

  it("surfaces permission mode and model when set", () => {
    renderBanner({
      ...cleanup,
      permissionMode: "acceptEdits",
      model: "claude-haiku-4-5-20251001",
    });
    const banner = screen.getByTestId("trigger-capability-banner");
    expect(banner).toHaveTextContent("acceptEdits");
    expect(banner).toHaveTextContent("claude-haiku-4-5-20251001");
  });
});
