import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { HomePane } from "./HomePane";
import { makeProject, makeChat } from "../../test/factories";
import type { AttentionChat } from "../../lib/types";

// The post-turn verdict mark on Home's attention rows. A project's Home makes no
// API calls; the mocks only keep the root-only onboarding imports inert.
vi.mock("../../lib/api", () => ({ api: {} }));
vi.mock("../../lib/projects-context", () => ({
  useProjects: () => ({
    projects: [],
    rootWorkspace: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn(),
  }),
}));
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => vi.fn() };
});

function row(over: Partial<AttentionChat> = {}): AttentionChat {
  return {
    ...makeChat({ sessionId: "s1", name: "A chat" }),
    projectSlug: "p",
    projectName: "Test Project",
    ...over,
  };
}

function renderHome(over: Partial<Parameters<typeof HomePane>[0]> = {}) {
  return render(
    <HomePane
      project={makeProject({ slug: "p" })}
      running={[]}
      unread={[]}
      recent={[]}
      attentionLoading={false}
      attentionError={null}
      changelog=""
      overview=""
      onOpenChat={vi.fn()}
      onNewChat={vi.fn()}
      {...over}
    />,
  );
}

describe("HomePane: post-turn verdict marks", () => {
  const verdict = {
    verdict: "could-continue" as const,
    reason: "Offered to open a PR.",
    turnCompletedAt: "2026-11-05T10:00:00.000Z",
    judgedAt: "2026-11-05T10:00:04.000Z",
  };
  const rowOf = (name: string) =>
    within(screen.getByTestId("home-attention-chats"))
      .getByText(name)
      .closest("button") as HTMLElement;

  it("marks a judged row and leaves an unjudged one quiet", () => {
    renderHome({
      recent: [
        row({ sessionId: "a", name: "Judged", verdict }),
        row({ sessionId: "b", name: "Not judged" }),
      ],
    });
    expect(within(rowOf("Judged")).getByLabelText("Could continue — Offered to open a PR."))
      .toHaveAttribute("data-verdict", "could-continue");
    expect(rowOf("Not judged").querySelector("[data-verdict]")).toBeNull();
  });

  it("shows no mark on a running row, whose verdict is stale", () => {
    renderHome({ running: [row({ sessionId: "r", name: "Busy", verdict })] });
    expect(rowOf("Busy").querySelector("[data-verdict]")).toBeNull();
  });
});
