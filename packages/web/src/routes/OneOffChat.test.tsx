import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { OneOffChat } from "./OneOffChat";
import { makeChat, makeProject } from "../test/factories";
import type { ChatPaneProps } from "../components/ChatPane";

// Mock ChatPane so the OneOffChat shell (list + promote wiring) is tested in
// isolation; we capture its props and expose an "establish session" trigger.
let chatPaneProps: ChatPaneProps | null = null;
vi.mock("../components/ChatPane", () => ({
  ChatPane: (props: ChatPaneProps) => {
    chatPaneProps = props;
    return <div data-testid="chat-pane">slug:{props.projectSlug} sess:{props.initialSessionId ?? "none"}</div>;
  },
}));

const listScratchChats = vi.fn();
const deleteScratchChat = vi.fn();
const promoteChat = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      listScratchChats: (...a: unknown[]) => listScratchChats(...a),
      deleteScratchChat: (...a: unknown[]) => deleteScratchChat(...a),
      promoteChat: (...a: unknown[]) => promoteChat(...a),
    },
  };
});

const upsert = vi.fn();
vi.mock("../lib/projects-context", () => ({
  useProjects: () => ({ projects: [], loading: false, error: null, refresh: vi.fn(), upsert, remove: vi.fn() }),
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/chat" element={<OneOffChat />} />
        <Route path="/chat/:sessionId" element={<OneOffChat />} />
        <Route path="/projects/:slug/*" element={<div>PROJECT PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  chatPaneProps = null;
  listScratchChats.mockReset().mockResolvedValue([]);
  deleteScratchChat.mockReset().mockResolvedValue(undefined);
  promoteChat.mockReset();
  upsert.mockReset();
});

describe("OneOffChat: recent list", () => {
  it("renders the header + empty recent state and mounts the scratch ChatPane", async () => {
    renderAt("/chat");
    expect(screen.getByRole("heading", { name: /One-off chat/i })).toBeInTheDocument();
    expect(await screen.findByText(/No one-off chats yet/i)).toBeInTheDocument();
    expect(screen.getByTestId("chat-pane")).toHaveTextContent("slug:scratch");
  });

  it("lists recent scratch chats", async () => {
    listScratchChats.mockResolvedValue([
      makeChat({ sessionId: "s1", name: "First scratch" }),
      makeChat({ sessionId: "s2", name: "Second scratch" }),
    ]);
    renderAt("/chat");
    expect(await screen.findByText("First scratch")).toBeInTheDocument();
    expect(screen.getByText("Second scratch")).toBeInTheDocument();
  });

  it("deletes a scratch chat from the list", async () => {
    listScratchChats.mockResolvedValue([makeChat({ sessionId: "s1", name: "Doomed" })]);
    renderAt("/chat");
    await screen.findByText("Doomed");
    fireEvent.click(screen.getByRole("button", { name: /Delete chat Doomed/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Delete chat$/i }));
    await waitFor(() => expect(deleteScratchChat).toHaveBeenCalledWith("s1"));
    await waitFor(() => expect(screen.queryByText("Doomed")).not.toBeInTheDocument());
  });
});

describe("OneOffChat: promote wiring", () => {
  it("shows the Promote button only when a session is open", async () => {
    const { unmount } = renderAt("/chat");
    expect(screen.queryByRole("button", { name: /Promote to project/i })).not.toBeInTheDocument();
    unmount();
    renderAt("/chat/sess-9");
    expect(screen.getByRole("button", { name: /Promote to project/i })).toBeInTheDocument();
  });

  it("opens the promote modal and routes into the new project on success", async () => {
    listScratchChats.mockResolvedValue([makeChat({ sessionId: "sess-9", name: "Heater chat" })]);
    promoteChat.mockResolvedValue({ project: makeProject({ slug: "promoted" }), promoted: true });
    renderAt("/chat/sess-9");

    fireEvent.click(screen.getByRole("button", { name: /Promote to project/i }));
    // Modal opens with the chat's name prefilled.
    expect(await screen.findByDisplayValue("Heater chat")).toBeInTheDocument();

    // Two "Promote to project" controls now exist (header button + modal submit);
    // click the modal's submit (type=submit inside the form).
    const form = screen.getByText(/Promote to project/i, { selector: "h2" }).closest("form")!;
    fireEvent.click(within(form).getByRole("button", { name: /Promote to project/i }));
    // It promotes, upserts the project, and lands on the project page.
    await waitFor(() => expect(promoteChat).toHaveBeenCalledWith("sess-9", expect.objectContaining({ name: "Heater chat" })));
    await waitFor(() => expect(upsert).toHaveBeenCalled());
    expect(await screen.findByText("PROJECT PAGE")).toBeInTheDocument();
  });
});

describe("OneOffChat: session establishment", () => {
  it("passes scratch slug + sessionId through to the ChatPane on a resumed chat", () => {
    renderAt("/chat/abc-123");
    expect(chatPaneProps?.projectSlug).toBe("scratch");
    expect(chatPaneProps?.initialSessionId).toBe("abc-123");
  });
});
