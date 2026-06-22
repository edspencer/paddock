import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatPane } from "./ChatPane";
import type { ChatHandlers } from "../lib/ws";
import type { HistoryMessage } from "../lib/types";

// --- a thin fake chat socket --------------------------------------------------
// We capture the handlers ChatPane subscribes with so a test can drive streamed
// events (onResponse/onComplete/onError) and assert the rendered transcript. The
// fake records sends/cancels for assertion.
interface FakeSub {
  projectSlug: string;
  sessionId: string | null;
  handlers: ChatHandlers;
  setSessionId: (id: string | null) => void;
}
let subs: FakeSub[] = [];
const sends: Array<{ slug: string; message: string; sessionId: string | null; opts?: unknown }> = [];
const cancels: string[] = [];
let stateCb: ((s: string) => void) | null = null;

vi.mock("../lib/ws", () => ({
  chatClient: {
    state: "open",
    onState: (cb: (s: string) => void) => {
      stateCb = cb;
      cb("open");
      return () => {
        stateCb = null;
      };
    },
    subscribe: (projectSlug: string, sessionId: string | null, handlers: ChatHandlers) => {
      const sub: FakeSub = {
        projectSlug,
        sessionId,
        handlers,
        setSessionId(id) {
          this.sessionId = id;
        },
      };
      subs.push(sub);
      return { setSessionId: (id: string | null) => sub.setSessionId(id), unsubscribe: () => {} };
    },
    send: (slug: string, message: string, sessionId: string | null, opts?: unknown) =>
      sends.push({ slug, message, sessionId, opts }),
    cancel: (jobId: string) => cancels.push(jobId),
  },
}));

const getModels = vi.fn();
const chatContext = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      getModels: (...a: unknown[]) => getModels(...a),
      chatContext: (...a: unknown[]) => chatContext(...a),
    },
  };
});

const MODELS = {
  models: [
    { id: "claude-opus-4-8", label: "Opus 4.8", contextLimit: 1_000_000 },
    { id: "claude-sonnet-4", label: "Sonnet 4", contextLimit: 200_000 },
  ],
  keeperDefault: "claude-opus-4-8",
  sweeperDefault: "claude-sonnet-4",
};

const sub = () => subs[subs.length - 1];

beforeEach(() => {
  subs = [];
  sends.length = 0;
  cancels.length = 0;
  stateCb = null;
  getModels.mockReset().mockResolvedValue(MODELS);
  chatContext.mockReset().mockResolvedValue(null);
  localStorage.clear();
});

describe("ChatPane: empty + send", () => {
  it("shows the empty hint and disables Send until there's a draft", async () => {
    render(<ChatPane projectSlug="proj" emptyHint="nothing here yet" />);
    expect(await screen.findByText("nothing here yet")).toBeInTheDocument();
    const send = screen.getByRole("button", { name: /^Send$/ });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "hi");
    expect(send).toBeEnabled();
  });

  it("sends the draft, renders the user bubble, and streams the assistant reply", async () => {
    render(<ChatPane projectSlug="proj" projectModel="claude-opus-4-8" isProjectChat />);
    await screen.findByRole("button", { name: /^Send$/ });

    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "ping");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));

    // The user bubble shows; the composer cleared; a send went out.
    expect(screen.getByText("ping")).toBeInTheDocument();
    expect(sends).toHaveLength(1);
    expect(sends[0].message).toBe("ping");

    // While streaming the Send button flips to Stop.
    expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument();

    // Drive a streamed response + completion through the captured handlers.
    act(() => {
      sub().handlers.onResponse?.("Acknowledged: ", { sessionId: "sess-1", jobId: "job-1" });
      sub().handlers.onResponse?.("ping", { sessionId: "sess-1", jobId: "job-1" });
    });
    expect(screen.getByText("Acknowledged: ping")).toBeInTheDocument();

    act(() => {
      sub().handlers.onComplete?.({ sessionId: "sess-1", jobId: "job-1", success: true });
    });
    // Streaming ended → Send is back.
    await waitFor(() => expect(screen.getByRole("button", { name: /^Send$/ })).toBeInTheDocument());
  });

  it("Enter sends, Shift+Enter does not", async () => {
    render(<ChatPane projectSlug="proj" />);
    const box = screen.getByPlaceholderText(/Message the keeper agent/i);
    await userEvent.type(box, "line one");
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(sends).toHaveLength(0);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(sends).toHaveLength(1);
    expect(sends[0].message).toBe("line one");
  });

  it("calls onSessionEstablished when a brand-new chat first gets a session id", async () => {
    const onEstablished = vi.fn();
    render(<ChatPane projectSlug="proj" onSessionEstablished={onEstablished} />);
    await screen.findByRole("button", { name: /^Send$/ });
    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "go");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    act(() => {
      sub().handlers.onComplete?.({ sessionId: "new-sess", jobId: "j", success: true });
    });
    await waitFor(() => expect(onEstablished).toHaveBeenCalledWith("new-sess"));
  });

  it("calls onTurnComplete after every completed turn (pull model)", async () => {
    const onTurnComplete = vi.fn();
    render(<ChatPane projectSlug="proj" onTurnComplete={onTurnComplete} />);
    await screen.findByRole("button", { name: /^Send$/ });
    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "go");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    act(() => sub().handlers.onComplete?.({ sessionId: "s", jobId: "j", success: true }));
    await waitFor(() => expect(onTurnComplete).toHaveBeenCalled());
  });
});

describe("ChatPane: cancel + errors", () => {
  it("Stop cancels the in-flight job by id", async () => {
    render(<ChatPane projectSlug="proj" />);
    await screen.findByRole("button", { name: /^Send$/ });
    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "go");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    // The job id arrives on the first streamed event.
    act(() => sub().handlers.onResponse?.("…", { sessionId: "s", jobId: "job-42" }));
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    expect(cancels).toEqual(["job-42"]);
  });

  it("renders a streamed error and re-enables Send", async () => {
    render(<ChatPane projectSlug="proj" />);
    await screen.findByRole("button", { name: /^Send$/ });
    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "go");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    act(() => sub().handlers.onError?.("the keeper exploded"));
    expect(await screen.findByText("the keeper exploded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Send$/ })).toBeInTheDocument();
  });

  it("surfaces a failed completion's error message", async () => {
    render(<ChatPane projectSlug="proj" />);
    await screen.findByRole("button", { name: /^Send$/ });
    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "go");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    act(() =>
      sub().handlers.onComplete?.({ sessionId: "s", jobId: "j", success: false, error: "turn failed" }),
    );
    expect(await screen.findByText("turn failed")).toBeInTheDocument();
  });
});

describe("ChatPane: history hydration", () => {
  const history: HistoryMessage[] = [
    { role: "user", content: "earlier question", timestamp: "2026-06-21T10:00:00Z" },
    { role: "assistant", content: "earlier answer", timestamp: "2026-06-21T10:00:01Z" },
    {
      role: "tool",
      content: "",
      timestamp: "2026-06-21T10:00:02Z",
      toolCall: { toolName: "Read", output: "file body", isError: false },
    },
  ];

  it("hydrates a resumed session's transcript via loadHistory", async () => {
    const loadHistory = vi.fn().mockResolvedValue(history);
    render(<ChatPane projectSlug="proj" initialSessionId="sess-1" loadHistory={loadHistory} />);
    await waitFor(() => expect(screen.getByText("earlier question")).toBeInTheDocument());
    expect(screen.getByText("earlier answer")).toBeInTheDocument();
    expect(loadHistory).toHaveBeenCalledWith("sess-1");
    // The tool turn renders its name.
    expect(screen.getByText("Read")).toBeInTheDocument();
  });

  it("shows an error when history fails to load", async () => {
    const loadHistory = vi.fn().mockRejectedValue(new Error("gone"));
    render(<ChatPane projectSlug="proj" initialSessionId="sess-1" loadHistory={loadHistory} />);
    expect(await screen.findByText(/Could not load this chat's history/i)).toBeInTheDocument();
  });
});

describe("ChatPane: model picker", () => {
  it("defaults the picker to the project's model and sends it", async () => {
    render(<ChatPane projectSlug="proj" projectModel="claude-sonnet-4" isProjectChat />);
    const select = (await screen.findByTitle(/Model for this chat/i)) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("claude-sonnet-4"));

    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "x");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    expect((sends[0].opts as { model?: string }).model).toBe("claude-sonnet-4");
  });

  it("a picked model is sent and persisted per chat", async () => {
    render(<ChatPane projectSlug="proj" projectModel="claude-opus-4-8" isProjectChat />);
    const select = (await screen.findByTitle(/Model for this chat/i)) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("claude-opus-4-8"));
    fireEvent.change(select, { target: { value: "claude-sonnet-4" } });

    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "x");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    expect((sends[0].opts as { model?: string }).model).toBe("claude-sonnet-4");
    // Persisted under the new-chat key (no session id yet).
    expect(localStorage.getItem("paddock:chatModel:new:proj")).toBe("claude-sonnet-4");
  });

  it("scratch chats default to the keeperDefault", async () => {
    render(<ChatPane projectSlug="scratch" />);
    const select = (await screen.findByTitle(/Model for this chat/i)) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("claude-opus-4-8"));
  });
});

describe("ChatPane: context meter", () => {
  it("shows a placeholder before any usage, then the meter after a completed turn", async () => {
    render(<ChatPane projectSlug="proj" />);
    expect(await screen.findByText("context: —")).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "x");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    act(() =>
      sub().handlers.onComplete?.({
        sessionId: "s",
        jobId: "j",
        success: true,
        usage: {
          inputTokens: 100_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextTokens: 100_000,
          contextLimit: 1_000_000,
        },
      }),
    );
    // 100k / 1000k (10%)
    expect(await screen.findByText(/100k \/ 1000k \(10%\)/)).toBeInTheDocument();
  });

  it("seeds the meter from the transcript on opening a resumed chat", async () => {
    chatContext.mockResolvedValue({ contextTokens: 850_000, contextLimit: 1_000_000 });
    const loadHistory = vi.fn().mockResolvedValue([]);
    render(<ChatPane projectSlug="proj" initialSessionId="sess-1" loadHistory={loadHistory} />);
    // 850k/1000k = 85% → amber warning text present.
    expect(await screen.findByText(/850k \/ 1000k \(85%\)/)).toBeInTheDocument();
  });
});

describe("ChatPane: preload toggle (issue #1)", () => {
  it("shows the preload checkbox only for a NEW project chat", async () => {
    const { rerender } = render(
      <ChatPane projectSlug="proj" isProjectChat preloadAvailable />,
    );
    expect(await screen.findByText(/Preload project context/i)).toBeInTheDocument();

    // Not shown for a resumed chat.
    rerender(<ChatPane projectSlug="proj" isProjectChat preloadAvailable initialSessionId="s1" loadHistory={vi.fn().mockResolvedValue([])} />);
    await waitFor(() =>
      expect(screen.queryByText(/Preload project context/i)).not.toBeInTheDocument(),
    );
  });

  it("disables the checkbox when no overview is available", async () => {
    render(<ChatPane projectSlug="proj" isProjectChat preloadAvailable={false} />);
    const cb = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(cb).toBeDisabled();
  });

  it("sends preloadContext on the first turn of a new project chat when available + checked", async () => {
    render(<ChatPane projectSlug="proj" isProjectChat preloadAvailable />);
    await screen.findByRole("checkbox");
    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "first");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    expect((sends[0].opts as { preloadContext?: boolean }).preloadContext).toBe(true);
  });

  it("does NOT preload for a scratch (non-project) chat", async () => {
    render(<ChatPane projectSlug="scratch" />);
    await screen.findByRole("button", { name: /^Send$/ });
    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "first");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    expect((sends[0].opts as { preloadContext?: boolean }).preloadContext).toBeFalsy();
  });
});

describe("ChatPane: message boundaries", () => {
  it("splits the streamed text into separate assistant bubbles on a boundary", async () => {
    render(<ChatPane projectSlug="proj" />);
    await screen.findByRole("button", { name: /^Send$/ });
    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "go");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    act(() => {
      sub().handlers.onResponse?.("first message", { sessionId: "s", jobId: "j" });
      sub().handlers.onMessageBoundary?.({ sessionId: "s", jobId: "j" });
      sub().handlers.onResponse?.("second message", { sessionId: "s", jobId: "j" });
    });
    expect(screen.getByText("first message")).toBeInTheDocument();
    expect(screen.getByText("second message")).toBeInTheDocument();
  });
});
