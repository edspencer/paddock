import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PaddockManageBody, PaddockManageProjectContext } from "./PaddockManageBlock";
import type { PaddockManage } from "../lib/mcpTools";

function renderBody(data: PaddockManage, project = "paddock") {
  return render(
    <MemoryRouter>
      <PaddockManageProjectContext.Provider value={project}>
        <PaddockManageBody data={data} />
      </PaddockManageProjectContext.Provider>
    </MemoryRouter>,
  );
}

describe("PaddockManageBody", () => {
  it("links a create_chat result to the new chat and shows its name", () => {
    renderBody({
      tool: "create_chat",
      project: "herdctl",
      sessionId: "new-9",
      name: "Investigate reaper teardown",
      prompt: "Look into the session reaper and why bg tasks die",
    });
    const link = screen.getByRole("link", { name: /open chat/i });
    expect(link).toHaveAttribute("href", "/projects/herdctl/chat/new-9");
    expect(screen.getByText("Investigate reaper teardown")).toBeInTheDocument();
    expect(screen.getByText(/in herdctl/)).toBeInTheDocument();
    // With a name set, the kickoff prompt is shown as its own block.
    expect(screen.getByText(/Look into the session reaper/)).toBeInTheDocument();
  });

  it("shows the actual sent message for send_message", () => {
    renderBody({
      tool: "send_message",
      project: "coderabbit",
      sessionId: "s-7",
      prompt: "Can you rerun the review with the latest diff?",
    });
    expect(
      screen.getByText("Can you rerun the review with the latest diff?"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open chat/i })).toHaveAttribute(
      "href",
      "/projects/coderabbit/chat/s-7",
    );
  });

  it("shows a fan-out list of linked forks, each with its prompt", () => {
    renderBody({
      tool: "fork_chat_batch",
      count: 2,
      source: "src-1",
      forks: [
        { sessionId: "f1", prompt: "poem about the sea" },
        { sessionId: "f2", prompt: "poem about the desert" },
      ],
    });
    expect(screen.getByText("poem about the sea")).toBeInTheDocument();
    expect(screen.getByText("poem about the desert")).toBeInTheDocument();
    // Forks inherit the source chat's project from context.
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", "/projects/paddock/chat/f1");
  });

  it("renders a chat list with a running indicator and per-row links", () => {
    renderBody({
      tool: "list_chats",
      count: 2,
      project: "paddock",
      chats: [
        { project: "paddock", sessionId: "a1", name: "Alpha", running: true },
        { project: "warren", sessionId: "b2", name: "Bravo", running: false },
      ],
    });
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    const links = screen.getAllByRole("link");
    expect(links[0]).toHaveAttribute("href", "/projects/paddock/chat/a1");
    expect(links[1]).toHaveAttribute("href", "/projects/warren/chat/b2");
  });

  it("renders read_chat messages with roles and an open-chat link", () => {
    renderBody({
      tool: "read_chat",
      project: "paddock",
      sessionId: "s1",
      total: 10,
      returned: 2,
      messages: [
        { role: "user", text: "what changed?" },
        { role: "assistant", text: "three files" },
      ],
    });
    expect(screen.getByText("what changed?")).toBeInTheDocument();
    expect(screen.getByText("three files")).toBeInTheDocument();
    expect(screen.getByText(/2 of 10 messages/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open chat/i })).toHaveAttribute(
      "href",
      "/projects/paddock/chat/s1",
    );
  });

  it("renders project chips for list_projects", () => {
    renderBody({
      tool: "list_projects",
      count: 2,
      projects: [
        { slug: "paddock", name: "Paddock", area: "dev", status: "active" },
        { slug: "herdctl", name: "herdctl", status: "active" },
      ],
    });
    expect(screen.getByText("Paddock")).toBeInTheDocument();
    expect(screen.getByText("herdctl")).toBeInTheDocument();
  });
});
