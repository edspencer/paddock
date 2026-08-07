import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ProvenanceBadge } from "./ProvenanceBadge";

/**
 * The chat-list provenance badge (#267): scheduled and spawned chats — the
 * "ran without me" cases — get a small icon badge; human-origin chats (and
 * chats with no recorded marker) render nothing so the list stays quiet.
 */
describe("ProvenanceBadge (#267)", () => {
  it("renders nothing for human origin (the default)", () => {
    const { container } = render(
      <ProvenanceBadge provenance={{ origin: "human", depth: 0 }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when there is no provenance marker", () => {
    const { container } = render(<ProvenanceBadge />);
    expect(container.firstChild).toBeNull();
  });

  it("badges a scheduled chat", () => {
    const { container } = render(
      <ProvenanceBadge provenance={{ origin: "scheduled", depth: 0 }} />,
    );
    const badge = container.querySelector("[data-provenance='scheduled']");
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("aria-label")).toBe("Scheduled chat");
    expect(badge?.getAttribute("title")).toMatch(/schedule/i);
    // Carries an icon, not a text label.
    expect(badge?.querySelector("svg")).not.toBeNull();
  });

  it("badges a spawned chat", () => {
    const { container } = render(
      <ProvenanceBadge provenance={{ origin: "spawned", depth: 1 }} />,
    );
    const badge = container.querySelector("[data-provenance='spawned']");
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("aria-label")).toBe("Spawned chat");
    expect(badge?.getAttribute("title")).toMatch(/another chat/i);
    expect(badge?.querySelector("svg")).not.toBeNull();
  });

  it("notes the spawn depth in the tooltip when nested deeper than one hop", () => {
    const { container } = render(
      <ProvenanceBadge provenance={{ origin: "spawned", depth: 3 }} />,
    );
    const badge = container.querySelector("[data-provenance='spawned']");
    expect(badge?.getAttribute("title")).toMatch(/3 levels deep/);
  });

  it("badges a hook chat (Epic G / G3)", () => {
    const { container } = render(
      <ProvenanceBadge provenance={{ origin: "hook", depth: 0 }} />,
    );
    const badge = container.querySelector("[data-provenance='hook']");
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("aria-label")).toBe("Hook chat");
    expect(badge?.getAttribute("title")).toMatch(/hook/i);
    expect(badge?.querySelector("svg")).not.toBeNull();
  });

  it("names the hook in the tooltip when provided", () => {
    const { container } = render(
      <ProvenanceBadge provenance={{ origin: "hook", depth: 0 }} hookName="cleanup" />,
    );
    const badge = container.querySelector("[data-provenance='hook']");
    expect(badge?.getAttribute("title")).toMatch(/cleanup/);
  });

  // #588. The one badge that isn't a "ran without me" case — the human ran it,
  // just in a terminal. Without it, adopted history is indistinguishable from a
  // chat started in paddock, which is the whole reason it exists.
  it("badges a chat adopted from the CLI", () => {
    const { container } = render(
      <ProvenanceBadge provenance={{ origin: "adopted", depth: 0 }} />,
    );
    const badge = container.querySelector("[data-provenance='adopted']");
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("aria-label")).toBe("Adopted chat");
    expect(badge?.getAttribute("title")).toMatch(/Claude Code CLI/i);
    expect(badge?.querySelector("svg")).not.toBeNull();
  });

  // The guard on line 1 of the component is a `!==` chain, not an exhaustive
  // switch — so a new origin silently renders NOTHING rather than failing to
  // compile. This is the assertion that would have caught that.
  it("badges an adopted chat nested under a parent, unlike a spawned one", () => {
    // (The sidebar suppresses `spawned` on a nested row because the indent
    // already says it; `adopted` has no such structural tell, so it must survive
    // wherever the row lands.)
    const { container } = render(
      <ProvenanceBadge provenance={{ origin: "adopted", depth: 2 }} />,
    );
    expect(container.querySelector("[data-provenance='adopted']")).not.toBeNull();
  });
});
