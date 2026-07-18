import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { HookCapabilityBanner } from "./HookCapabilityBanner";
import type { ChatHookInfo } from "../lib/types";

/**
 * The read-only capability banner atop a hook chat (Epic G / G3, GG-6). It must be
 * truthful-from-config: it states the hook's trigger event and the EXACT tools its
 * agent was granted, and offers an affordance toward editing the hook. It never
 * grants or escalates anything (that's the deferred G7).
 */
function renderBanner(hook: ChatHookInfo, slug = "my-proj") {
  return render(
    <MemoryRouter>
      <HookCapabilityBanner hook={hook} projectSlug={slug} />
    </MemoryRouter>,
  );
}

const cleanup: ChatHookInfo = {
  name: "cleanup",
  event: "onArchive",
  agentName: "hook-my-proj-cleanup",
  enabled: true,
  allowedTools: ["Bash", "Read"],
  maxTurns: 12,
};

describe("HookCapabilityBanner (GG-6)", () => {
  it("identifies it as a hook agent, naming the hook and its trigger event", () => {
    renderBanner(cleanup);
    const banner = screen.getByTestId("hook-capability-banner");
    expect(banner).toHaveTextContent("Event-hook agent");
    expect(banner).toHaveTextContent("cleanup");
    expect(banner).toHaveTextContent("onArchive");
  });

  it("lists the exact granted tools (truthful from config)", () => {
    renderBanner(cleanup);
    const tools = screen.getByTestId("hook-allowed-tools");
    expect(tools).toHaveTextContent("Bash");
    expect(tools).toHaveTextContent("Read");
  });

  it("describes a tool-less hook as reasoning-only rather than listing tools", () => {
    renderBanner({ ...cleanup, allowedTools: [] });
    expect(screen.queryByTestId("hook-allowed-tools")).toBeNull();
    const banner = screen.getByTestId("hook-capability-banner");
    expect(banner).toHaveTextContent(/no tools|reasoning only|can only read/i);
  });

  it("flags a disabled hook", () => {
    renderBanner({ ...cleanup, enabled: false });
    expect(screen.getByTestId("hook-capability-banner")).toHaveTextContent(/disabled/i);
  });

  it("offers an affordance toward editing the hook", () => {
    renderBanner(cleanup);
    const link = screen.getByRole("link", { name: /edit hook/i });
    expect(link.getAttribute("href")).toContain("/projects/my-proj");
  });

  it("surfaces denied tools, permission mode and model when set", () => {
    renderBanner({
      ...cleanup,
      deniedTools: ["WebFetch"],
      permissionMode: "acceptEdits",
      model: "claude-haiku-4-5-20251001",
    });
    const banner = screen.getByTestId("hook-capability-banner");
    expect(banner).toHaveTextContent("WebFetch");
    expect(banner).toHaveTextContent("acceptEdits");
    expect(banner).toHaveTextContent("claude-haiku-4-5-20251001");
  });
});
