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
const commands: Array<{ slug: string; message: string; sessionId: string | null }> = [];
const cancels: string[] = [];
const queuedSets: Array<{ slug: string; sessionId: string; text: string | null }> = [];
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
    sendCommand: (slug: string, message: string, sessionId: string | null) =>
      commands.push({ slug, message, sessionId }),
    cancel: (jobId: string) => cancels.push(jobId),
    setQueued: (slug: string, sessionId: string, text: string | null) =>
      queuedSets.push({ slug, sessionId, text }),
  },
}));

const getModels = vi.fn();
const chatContext = vi.fn();
const subagentMessages = vi.fn();
const projectCommands = vi.fn();
const scratchCommands = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      getModels: (...a: unknown[]) => getModels(...a),
      chatContext: (...a: unknown[]) => chatContext(...a),
      subagentMessages: (...a: unknown[]) => subagentMessages(...a),
      // Slash-command autocomplete source (issue #103).
      projectCommands: (...a: unknown[]) => projectCommands(...a),
      scratchCommands: (...a: unknown[]) => scratchCommands(...a),
      // The composer's DictationButton probes this on mount; default to
      // "dictation off" so it renders nothing and these tests see the same
      // composer they always have.
      transcriptionStatus: () =>
        Promise.resolve({ available: false, mode: "off" as const, model: "" }),
    },
  };
});

const COMMANDS = [
  { name: "compact", description: "Clear conversation history but keep a summary", argumentHint: "" },
  { name: "clear", description: "Clear conversation history", argumentHint: "" },
  { name: "review", description: "Review a pull request", argumentHint: "<pr>" },
];

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
  commands.length = 0;
  cancels.length = 0;
  queuedSets.length = 0;
  stateCb = null;
  getModels.mockReset().mockResolvedValue(MODELS);
  chatContext.mockReset().mockResolvedValue(null);
  subagentMessages.mockReset().mockResolvedValue([]);
  projectCommands.mockReset().mockResolvedValue(COMMANDS);
  scratchCommands.mockReset().mockResolvedValue(COMMANDS);
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

describe("ChatPane: composer auto-focus (#159)", () => {
  const composer = () => screen.getByPlaceholderText(/Message the keeper agent/i);

  it("focuses the composer on mount for a session-less (New Chat) pane", async () => {
    render(<ChatPane projectSlug="proj" isProjectChat />);
    await waitFor(() => expect(composer()).toHaveFocus());
  });

  it("focuses the composer on mount when autoFocus is set (fork)", async () => {
    render(<ChatPane projectSlug="proj" isProjectChat autoFocus />);
    await waitFor(() => expect(composer()).toHaveFocus());
  });

  it("does NOT focus the composer when opening an existing chat", async () => {
    const loadHistory = vi.fn().mockResolvedValue([]);
    render(
      <ChatPane projectSlug="proj" initialSessionId="sess-1" loadHistory={loadHistory} isProjectChat />,
    );
    await waitFor(() => expect(loadHistory).toHaveBeenCalledWith("sess-1"));
    expect(composer()).not.toHaveFocus();
  });
});

describe("ChatPane: slash-command autocomplete (#103)", () => {
  const composer = () => screen.getByPlaceholderText(/Message the keeper agent/i);
  const menu = () => screen.queryByRole("menu", { name: /slash commands/i });

  it("fetches project commands for a project chat, scratch commands otherwise", async () => {
    const { unmount } = render(<ChatPane projectSlug="proj" isProjectChat />);
    await waitFor(() => expect(projectCommands).toHaveBeenCalledWith("proj"));
    expect(scratchCommands).not.toHaveBeenCalled();
    unmount();
    render(<ChatPane projectSlug="scratch" />);
    await waitFor(() => expect(scratchCommands).toHaveBeenCalled());
  });

  it("opens the menu on a leading slash and filters as the query narrows", async () => {
    render(<ChatPane projectSlug="proj" isProjectChat />);
    await waitFor(() => expect(projectCommands).toHaveBeenCalled());
    expect(menu()).toBeNull();

    await userEvent.type(composer(), "/");
    await waitFor(() => expect(menu()).toBeInTheDocument());
    // All three commands are offered for a bare slash.
    expect(screen.getByRole("menuitem", { name: /\/compact/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /\/review/ })).toBeInTheDocument();

    // Narrowing to "/cl" leaves only /clear (substring match on the name).
    await userEvent.type(composer(), "cl");
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: /\/clear/ })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: /\/review/ })).toBeNull();
    });
  });

  it("does not open for a slash mid-text or once an argument is typed", async () => {
    render(<ChatPane projectSlug="proj" isProjectChat />);
    await waitFor(() => expect(projectCommands).toHaveBeenCalled());

    // Slash not at the start → no menu.
    await userEvent.type(composer(), "hello /compact");
    expect(menu()).toBeNull();

    await userEvent.clear(composer());
    // A trailing space (moved on to arguments) closes the menu.
    await userEvent.type(composer(), "/compact ");
    expect(menu()).toBeNull();
  });

  it("Enter accepts the highlighted command instead of sending", async () => {
    render(<ChatPane projectSlug="proj" isProjectChat />);
    await waitFor(() => expect(projectCommands).toHaveBeenCalled());

    await userEvent.type(composer(), "/");
    await waitFor(() => expect(menu()).toBeInTheDocument());
    // ArrowDown moves off the first row (/compact) to /clear, then Enter accepts.
    fireEvent.keyDown(composer(), { key: "ArrowDown" });
    fireEvent.keyDown(composer(), { key: "Enter" });

    // Nothing was sent; the composer holds "/clear " (trailing space) and the
    // menu closed because the query now contains whitespace.
    expect(sends).toHaveLength(0);
    expect(commands).toHaveLength(0);
    expect(composer()).toHaveValue("/clear ");
    await waitFor(() => expect(menu()).toBeNull());
  });

  it("Escape dismisses the menu without clearing the draft; Enter then sends the command", async () => {
    render(<ChatPane projectSlug="proj" isProjectChat />);
    await waitFor(() => expect(projectCommands).toHaveBeenCalled());

    await userEvent.type(composer(), "/compact");
    await waitFor(() => expect(menu()).toBeInTheDocument());
    fireEvent.keyDown(composer(), { key: "Escape" });
    await waitFor(() => expect(menu()).toBeNull());
    expect(composer()).toHaveValue("/compact");

    // With the menu dismissed, Enter falls through to send — a leading-slash
    // message routes to the command path (chatClient.sendCommand), not send.
    fireEvent.keyDown(composer(), { key: "Enter" });
    expect(sends).toHaveLength(0);
    expect(commands).toHaveLength(1);
    expect(commands[0].message).toBe("/compact");
  });

  it("clicking a row accepts it", async () => {
    render(<ChatPane projectSlug="proj" isProjectChat />);
    await waitFor(() => expect(projectCommands).toHaveBeenCalled());

    await userEvent.type(composer(), "/rev");
    const row = await screen.findByRole("menuitem", { name: /\/review/ });
    // onMouseDown drives selection (it preventDefaults to keep focus).
    fireEvent.mouseDown(row);
    expect(composer()).toHaveValue("/review ");
    expect(sends).toHaveLength(0);
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

  it("Stop in the pre-arm window defers the cancel, then fires it when the jobId arrives (#196)", async () => {
    render(<ChatPane projectSlug="proj" />);
    await screen.findByRole("button", { name: /^Send$/ });
    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "go");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    // Pre-arm window: the turn is streaming (Stop shows) but no frame has carried
    // a jobId yet. Clicking Stop must NOT silently no-op...
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    expect(cancels).toEqual([]);
    // ...it defers, and fires the instant the jobId lands (here via chat:active).
    act(() => sub().handlers.onActive?.({ running: true, jobId: "job-late" }));
    expect(cancels).toEqual(["job-late"]);
  });

  it("Stop in a 2nd turn's pre-arm window cancels the new job, not the previous turn's stale id (#196)", async () => {
    render(<ChatPane projectSlug="proj" />);
    await screen.findByRole("button", { name: /^Send$/ });
    // Turn 1: send, arm job-1, complete.
    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "one");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    act(() => sub().handlers.onResponse?.("…", { sessionId: "s", jobId: "job-1" }));
    act(() => sub().handlers.onComplete?.({ sessionId: "s", jobId: "job-1", success: true }));
    await screen.findByRole("button", { name: /^Send$/ });
    // Turn 2: send, then Stop before any frame carries the new jobId. The stale
    // job-1 must NOT be cancelled; the deferred cancel resolves to job-2.
    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "two");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    expect(cancels).toEqual([]);
    act(() => sub().handlers.onResponse?.("…", { sessionId: "s", jobId: "job-2" }));
    expect(cancels).toEqual(["job-2"]);
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

  // Issue #106: CC-injected `role:"user"` transcript artifacts — the `/compact`
  // echo and the post-compaction continuation summary — must NOT render as the
  // user's own chat bubbles (they made a compacted chat look corrupted).
  it("renders compaction artifacts as markers, not raw user bubbles (#106)", async () => {
    const compactHistory: HistoryMessage[] = [
      { role: "user", content: "do the thing", timestamp: "2026-06-21T10:00:00Z" },
      {
        role: "user",
        content:
          "<command-name>/compact</command-name>\n            " +
          "<command-message>compact</command-message>\n            <command-args></command-args>",
        timestamp: "2026-06-21T10:00:01Z",
      },
      {
        role: "user",
        content:
          "This session is being continued from a previous conversation that ran out " +
          "of context. The summary below covers the earlier portion of the conversation." +
          "\n\nSummary:\n1. Primary Request and Intent: SEKRET-SUMMARY-BODY",
        timestamp: "2026-06-21T10:00:02Z",
      },
    ];
    const loadHistory = vi.fn().mockResolvedValue(compactHistory);
    render(<ChatPane projectSlug="proj" initialSessionId="sess-c" loadHistory={loadHistory} />);

    // The genuine user message still renders.
    await waitFor(() => expect(screen.getByText("do the thing")).toBeInTheDocument());
    // The command echo renders as a "/compact" chip, not raw <command-name> XML.
    expect(screen.getByText("/compact")).toBeInTheDocument();
    expect(screen.queryByText(/command-name/)).not.toBeInTheDocument();
    // The continuation summary renders as a "conversation compacted" boundary,
    // with its machine-generated body tucked inside a <details> disclosure (still
    // in the DOM, but as a labelled boundary — not the user's own accent bubble).
    const boundary = screen.getByText(/conversation compacted/i);
    expect(boundary).toBeInTheDocument();
    expect(boundary.closest("details")).not.toBeNull();
    const summaryBody = screen.getByText(/SEKRET-SUMMARY-BODY/);
    expect(summaryBody.closest("details")).not.toBeNull();
  });

  // Issue #37: a Task/Agent tool call renders as a sub-agent block (type +
  // description) and lazy-loads its nested steps on first expand.
  it("renders a sub-agent block and lazy-loads its nested steps on expand", async () => {
    const withSubagent: HistoryMessage[] = [
      {
        role: "tool",
        content: "final sub-agent answer",
        timestamp: "2026-06-21T10:00:03Z",
        toolCall: {
          toolName: "Agent",
          output: "final sub-agent answer",
          isError: false,
          subagentType: "Explore",
          description: "map the features",
          toolUseId: "toolu_A",
          hasSubagent: true,
        },
      },
    ];
    subagentMessages.mockResolvedValue([
      {
        role: "tool",
        content: "grep output",
        timestamp: "2026-06-21T10:00:04Z",
        toolCall: { toolName: "Grep", output: "grep output", isError: false },
      },
    ]);
    const loadHistory = vi.fn().mockResolvedValue(withSubagent);
    render(<ChatPane projectSlug="proj" initialSessionId="sess-2" loadHistory={loadHistory} />);

    // Header shows the sub-agent type + description, not raw "Agent".
    const header = await screen.findByRole("button", { name: /Explore.*sub-agent.*map the features/i });
    expect(header).toBeInTheDocument();
    // Nested steps are NOT fetched until expanded.
    expect(subagentMessages).not.toHaveBeenCalled();

    await userEvent.click(header);
    await waitFor(() => expect(subagentMessages).toHaveBeenCalledWith("proj", "sess-2", "toolu_A"));
    // The nested step (a Grep tool block) renders inline.
    expect(await screen.findByText("Grep")).toBeInTheDocument();
  });

  // Issue #166: a sub-agent block shows its estimated cost next to the duration.
  it("renders the sub-agent's estimated cost next to the duration", async () => {
    const withCost: HistoryMessage[] = [
      {
        role: "tool",
        content: "final sub-agent answer",
        timestamp: "2026-06-21T10:00:03Z",
        toolCall: {
          toolName: "Agent",
          output: "final sub-agent answer",
          isError: false,
          subagentType: "Explore",
          description: "map the features",
          toolUseId: "toolu_A",
          hasSubagent: true,
          subagentDurationMs: 5_500,
          subagentCostUsd: 0.0234,
        },
      },
    ];
    const loadHistory = vi.fn().mockResolvedValue(withCost);
    render(<ChatPane projectSlug="proj" initialSessionId="sess-3" loadHistory={loadHistory} />);

    // Both the duration (12.5s) and the ~$0.02 cost render in the header row.
    expect(await screen.findByText("5.5s")).toBeInTheDocument();
    expect(screen.getByText("~$0.02")).toBeInTheDocument();
  });

  it("renders no cost string when the sub-agent has no priced cost", async () => {
    const noCost: HistoryMessage[] = [
      {
        role: "tool",
        content: "final sub-agent answer",
        timestamp: "2026-06-21T10:00:03Z",
        toolCall: {
          toolName: "Agent",
          output: "final sub-agent answer",
          isError: false,
          subagentType: "Explore",
          description: "map the features",
          toolUseId: "toolu_A",
          hasSubagent: true,
          subagentDurationMs: 5_500,
          subagentCostUsd: null,
        },
      },
    ];
    const loadHistory = vi.fn().mockResolvedValue(noCost);
    render(<ChatPane projectSlug="proj" initialSessionId="sess-4" loadHistory={loadHistory} />);

    expect(await screen.findByText("5.5s")).toBeInTheDocument();
    expect(screen.queryByText(/^~\$/)).not.toBeInTheDocument();
  });
});

// Issue #36: a brand-new chat should announce its session id the moment it
// learns it (mid-stream), so the sidebar can show a pending entry immediately.
describe("ChatPane: onSessionStarted (issue #36)", () => {
  it("fires as soon as a new chat learns its session id, before completion — once", async () => {
    const onStarted = vi.fn();
    render(<ChatPane projectSlug="proj" onSessionStarted={onStarted} />);
    await screen.findByRole("button", { name: /^Send$/ });
    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "go");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));

    act(() => sub().handlers.onResponse?.("streaming…", { sessionId: "sess-9", jobId: "j" }));
    expect(onStarted).toHaveBeenCalledWith("sess-9");

    // Further frames + completion must not fire it again.
    act(() => {
      sub().handlers.onResponse?.(" more", { sessionId: "sess-9", jobId: "j" });
      sub().handlers.onComplete?.({ sessionId: "sess-9", jobId: "j", success: true });
    });
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("does not fire for a resumed (existing) chat", async () => {
    const onStarted = vi.fn();
    const loadHistory = vi.fn().mockResolvedValue([]);
    render(
      <ChatPane projectSlug="proj" initialSessionId="sess-existing" onSessionStarted={onStarted} loadHistory={loadHistory} />,
    );
    await screen.findByRole("button", { name: /^Send$/ });
    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "go");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    act(() => {
      sub().handlers.onResponse?.("reply", { sessionId: "sess-existing", jobId: "j" });
      sub().handlers.onComplete?.({ sessionId: "sess-existing", jobId: "j", success: true });
    });
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("keeps the picked model when the new chat's id is mirrored into the URL mid-stream", async () => {
    const { rerender } = render(
      <ChatPane projectSlug="proj" projectModel="claude-opus-4-8" isProjectChat onSessionStarted={vi.fn()} />,
    );
    const select = (await screen.findByTitle(/Model for this chat/i)) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("claude-opus-4-8"));
    fireEvent.change(select, { target: { value: "claude-sonnet-4" } });

    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "go");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));

    // First streamed frame carries the new session id → onSessionStarted fires
    // and the parent mirrors that id into initialSessionId mid-stream (no
    // remount). The picker must NOT reset to the Opus default.
    act(() => sub().handlers.onResponse?.("hi", { sessionId: "sess-new", jobId: "j" }));
    rerender(
      <ChatPane
        projectSlug="proj"
        projectModel="claude-opus-4-8"
        isProjectChat
        initialSessionId="sess-new"
        onSessionStarted={vi.fn()}
        loadHistory={vi.fn().mockResolvedValue([])}
      />,
    );
    const after = (await screen.findByTitle(/Model for this chat/i)) as HTMLSelectElement;
    await waitFor(() => expect(after.value).toBe("claude-sonnet-4"));
  });
});

// Regression: issue #35 — since only one ChatPane is mounted per project, a
// still-streaming chat's frames can be routed here after the user switches
// away. A pane must apply only frames that belong to its own chat.
describe("ChatPane: session isolation (issue #35)", () => {
  it("an established chat ignores frames carrying a different session id", async () => {
    const loadHistory = vi.fn().mockResolvedValue([]);
    render(<ChatPane projectSlug="proj" initialSessionId="sess-A" loadHistory={loadHistory} />);
    await screen.findByRole("button", { name: /^Send$/ });

    // A straggler from another chat (session B) must not render here.
    act(() => sub().handlers.onResponse?.("leaked from B", { sessionId: "sess-B", jobId: "jb" }));
    expect(screen.queryByText("leaked from B")).not.toBeInTheDocument();

    // Our own session's frame renders normally.
    act(() => sub().handlers.onResponse?.("belongs to A", { sessionId: "sess-A", jobId: "ja" }));
    expect(await screen.findByText("belongs to A")).toBeInTheDocument();
  });

  it("a fresh, unsent chat ignores another chat's leaked text and does not adopt its session", async () => {
    const onEstablished = vi.fn();
    render(<ChatPane projectSlug="proj" onSessionEstablished={onEstablished} />);
    await screen.findByRole("button", { name: /^Send$/ });

    // Chat A is still streaming; its frames get routed to this nascent pane.
    // Without a guard the text leaks in and the leaked chat:complete fires
    // onSessionEstablished — navigating the fresh chat onto A's session.
    act(() => {
      sub().handlers.onResponse?.("A's streamed text", { sessionId: "sess-A", jobId: "ja" });
      sub().handlers.onComplete?.({ sessionId: "sess-A", jobId: "ja", success: true });
    });
    expect(screen.queryByText("A's streamed text")).not.toBeInTheDocument();
    expect(onEstablished).not.toHaveBeenCalled();
  });

  it("a fresh chat accepts its OWN first frames once it has sent", async () => {
    const onEstablished = vi.fn();
    render(<ChatPane projectSlug="proj" onSessionEstablished={onEstablished} />);
    await screen.findByRole("button", { name: /^Send$/ });
    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "hello");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));

    // Once we've sent, the turn's first frames (even before the id is known)
    // are ours and are adopted.
    act(() => {
      sub().handlers.onResponse?.("streaming reply", { sessionId: null, jobId: "j" });
      sub().handlers.onResponse?.(" continued", { sessionId: "sess-new", jobId: "j" });
      sub().handlers.onComplete?.({ sessionId: "sess-new", jobId: "j", success: true });
    });
    expect(await screen.findByText("streaming reply continued")).toBeInTheDocument();
    await waitFor(() => expect(onEstablished).toHaveBeenCalledWith("sess-new"));
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

describe("ChatPane: draft persistence", () => {
  it("restores a persisted draft into the composer on mount", async () => {
    localStorage.setItem("paddock:draft:new:proj", "half-typed thought");
    render(<ChatPane projectSlug="proj" />);
    const box = (await screen.findByPlaceholderText(
      /Message the keeper agent/i,
    )) as HTMLTextAreaElement;
    expect(box.value).toBe("half-typed thought");
    // A restored draft enables Send.
    expect(screen.getByRole("button", { name: /^Send$/ })).toBeEnabled();
  });

  it("keys a resumed chat's draft by its session id", async () => {
    localStorage.setItem("paddock:draft:sess-1", "resume this");
    const loadHistory = vi.fn().mockResolvedValue([]);
    render(<ChatPane projectSlug="proj" initialSessionId="sess-1" loadHistory={loadHistory} />);
    const box = (await screen.findByPlaceholderText(
      /Message the keeper agent/i,
    )) as HTMLTextAreaElement;
    expect(box.value).toBe("resume this");
  });

  it("persists the typed draft to localStorage as the user types", async () => {
    render(<ChatPane projectSlug="proj" />);
    await screen.findByRole("button", { name: /^Send$/ });
    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "keep me");
    await waitFor(() =>
      expect(localStorage.getItem("paddock:draft:new:proj")).toBe("keep me"),
    );
  });

  it("clears the persisted draft on send", async () => {
    localStorage.setItem("paddock:draft:new:proj", "about to send");
    render(<ChatPane projectSlug="proj" />);
    const box = await screen.findByPlaceholderText(/Message the keeper agent/i);
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe("about to send"));
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    expect(sends).toHaveLength(1);
    // The composer emptied and the stored draft was forgotten.
    expect((box as HTMLTextAreaElement).value).toBe("");
    await waitFor(() =>
      expect(localStorage.getItem("paddock:draft:new:proj")).toBeNull(),
    );
  });
});

describe("ChatPane: fork", () => {
  it("shows a 'Fork of <parent>' back-link and navigates to the parent on click", async () => {
    const onOpenForkParent = vi.fn();
    render(
      <ChatPane
        projectSlug="proj"
        initialSessionId="child-session"
        forkParent={{ sessionId: "parent-session", name: "bug fixes" }}
        onOpenForkParent={onOpenForkParent}
        loadHistory={vi.fn().mockResolvedValue([])}
      />,
    );
    await screen.findByRole("button", { name: /^Send$/ });
    expect(screen.getByText("Fork of")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "bug fixes" }));
    expect(onOpenForkParent).toHaveBeenCalledWith("parent-session");
  });

  it("auto-focuses the composer when autoFocus is set (e.g. right after forking)", async () => {
    render(
      <ChatPane
        projectSlug="proj"
        initialSessionId="child-session"
        autoFocus
        loadHistory={vi.fn().mockResolvedValue([])}
      />,
    );
    const box = await screen.findByPlaceholderText(/Message the keeper agent/i);
    await waitFor(() => expect(box).toHaveFocus());
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

  // Regression: issue #30 — in a `text → tool → text → tool → text` turn every
  // text bubble kept a stuck streaming caret because sealStreaming only cleared
  // the trailing turn. The caret should sit only on the actively-streaming
  // segment (at most one), and none should remain once the turn completes.
  it("keeps at most one caret across tool-separated text and clears all on complete", async () => {
    const { container } = render(<ChatPane projectSlug="proj" />);
    await screen.findByRole("button", { name: /^Send$/ });
    await userEvent.type(screen.getByPlaceholderText(/Message the keeper agent/i), "go");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));

    const meta = { sessionId: "s", jobId: "j" };
    const tool = (n: number) => ({
      toolName: `Bash-${n}`,
      output: "ok",
      isError: false,
    });

    act(() => {
      sub().handlers.onResponse?.("segment A", meta);
      sub().handlers.onToolCall?.(tool(1), meta);
      sub().handlers.onResponse?.("segment B", meta);
      sub().handlers.onToolCall?.(tool(2), meta);
      sub().handlers.onResponse?.("segment C", meta);
    });

    // All three segments render as separate bubbles...
    expect(screen.getByText("segment A")).toBeInTheDocument();
    expect(screen.getByText("segment B")).toBeInTheDocument();
    expect(screen.getByText("segment C")).toBeInTheDocument();
    // ...but only the actively-streaming last one carries a caret.
    expect(container.querySelectorAll(".streaming-caret")).toHaveLength(1);

    act(() => sub().handlers.onComplete?.({ ...meta, success: true }));

    // Turn done → no carets anywhere.
    expect(container.querySelectorAll(".streaming-caret")).toHaveLength(0);
  });
});

// Issue #91: a single message can be queued mid-turn and auto-sends when the
// current turn completes. Mirrors Claude Code's one-slot, append-on-resubmit
// model.
describe("ChatPane: message queue (issue #91)", () => {
  const box = () => screen.getByPlaceholderText(/Message the keeper agent|Queue a message/i);

  // Send a first message and drive the turn into the streaming state.
  async function startTurn() {
    await screen.findByRole("button", { name: /^Send$/ });
    await userEvent.type(box(), "first turn");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    // Anchor the job id so Stop can cancel by id.
    act(() => sub().handlers.onResponse?.("…", { sessionId: "s", jobId: "job-1" }));
    expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument();
  }

  it("queues a message while streaming instead of sending it", async () => {
    render(<ChatPane projectSlug="proj" />);
    await startTurn();

    await userEvent.type(box(), "follow up");
    fireEvent.keyDown(box(), { key: "Enter" });

    // No second send went out — the turn is still in flight.
    expect(sends).toHaveLength(1);
    // The queued toolbar surfaces it, and the composer cleared.
    expect(screen.getByText("queued")).toBeInTheDocument();
    expect(screen.getByText("follow up")).toBeInTheDocument();
    expect((box() as HTMLTextAreaElement).value).toBe("");
  });

  it("auto-sends the queued message when the turn completes", async () => {
    render(<ChatPane projectSlug="proj" />);
    await startTurn();
    await userEvent.type(box(), "the queued one");
    fireEvent.keyDown(box(), { key: "Enter" });

    act(() => sub().handlers.onComplete?.({ sessionId: "s", jobId: "job-1", success: true }));

    // The queued message went out as the next turn and the toolbar cleared.
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1].message).toBe("the queued one");
    expect(screen.queryByText("queued")).not.toBeInTheDocument();
    // And we're streaming again for that follow-up turn.
    expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument();
  });

  it("persists the queued message across a remount and hydrates it back (#197)", async () => {
    const loadHistory = vi.fn().mockResolvedValue([]);
    const { unmount } = render(
      <ChatPane projectSlug="proj" isProjectChat initialSessionId="s1" loadHistory={loadHistory} />,
    );
    await screen.findByRole("button", { name: /^Send$/ });
    // Put a turn in flight, then queue a follow-up.
    await userEvent.type(box(), "first turn");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    act(() => sub().handlers.onResponse?.("…", { sessionId: "s1", jobId: "job-1" }));
    await userEvent.type(box(), "remembered follow-up");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(screen.getByText("queued")).toBeInTheDocument();
    // It's persisted under the session-keyed slot.
    expect(localStorage.getItem("paddock:queued:s1")).toBe("remembered follow-up");

    // Navigating away unmounts the pane — the queued message must NOT be lost.
    unmount();
    render(
      <ChatPane projectSlug="proj" isProjectChat initialSessionId="s1" loadHistory={loadHistory} />,
    );
    // Re-opening the chat restores the queued toolbar + its text.
    expect(await screen.findByText("queued")).toBeInTheDocument();
    expect(screen.getByText("remembered follow-up")).toBeInTheDocument();
  });

  it("clears the persisted queued message once it flushes (#197)", async () => {
    render(
      <ChatPane projectSlug="proj" isProjectChat initialSessionId="s1" loadHistory={vi.fn().mockResolvedValue([])} />,
    );
    await screen.findByRole("button", { name: /^Send$/ });
    await userEvent.type(box(), "first turn");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    act(() => sub().handlers.onResponse?.("…", { sessionId: "s1", jobId: "job-1" }));
    await userEvent.type(box(), "flush me");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(localStorage.getItem("paddock:queued:s1")).toBe("flush me");
    // Turn completes → queue auto-flushes → the persisted slot is forgotten.
    act(() => sub().handlers.onComplete?.({ sessionId: "s1", jobId: "job-1", success: true }));
    await waitFor(() => expect(localStorage.getItem("paddock:queued:s1")).toBeNull());
  });

  it("appends to the queued message on re-submit (single slot)", async () => {
    render(<ChatPane projectSlug="proj" />);
    await startTurn();
    await userEvent.type(box(), "line A");
    fireEvent.keyDown(box(), { key: "Enter" });
    await userEvent.type(box(), "line B");
    fireEvent.keyDown(box(), { key: "Enter" });

    // Still one queued message; toolbar shows the first line only.
    expect(screen.getByText("line A")).toBeInTheDocument();

    act(() => sub().handlers.onComplete?.({ sessionId: "s", jobId: "job-1", success: true }));
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1].message).toBe("line A\nline B");
  });

  it("shows a '+N characters' hint only when the queued message spans more than one line", async () => {
    render(<ChatPane projectSlug="proj" />);
    await startTurn();

    // A single-line queued message has nothing hidden → no counter.
    await userEvent.type(box(), "one liner");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(screen.queryByText(/character/)).not.toBeInTheDocument();

    // Appending a second line hides it behind the first → surface the count.
    await userEvent.type(box(), "second");
    fireEvent.keyDown(box(), { key: "Enter" });
    // "one liner" + "\n" + "second" hides 7 characters (newline + "second").
    expect(screen.getByText("+7 characters")).toBeInTheDocument();
  });

  it("holds the queue when the user hits Stop (does not auto-send)", async () => {
    render(<ChatPane projectSlug="proj" />);
    await startTurn();
    await userEvent.type(box(), "should not fire");
    fireEvent.keyDown(box(), { key: "Enter" });

    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    expect(cancels).toEqual(["job-1"]);
    // The server emits a completion for the cancelled turn — must NOT flush.
    act(() => sub().handlers.onComplete?.({ sessionId: "s", jobId: "job-1", success: true }));

    expect(sends).toHaveLength(1);
    // The message stays queued for the user to send/edit.
    expect(screen.getByText("should not fire")).toBeInTheDocument();
  });

  it("holds the queue when the turn errors (does not auto-send)", async () => {
    render(<ChatPane projectSlug="proj" />);
    await startTurn();
    await userEvent.type(box(), "held on error");
    fireEvent.keyDown(box(), { key: "Enter" });

    act(() => sub().handlers.onError?.("boom"));
    expect(sends).toHaveLength(1);
    expect(screen.getByText("held on error")).toBeInTheDocument();
  });

  it("Clear discards the queued message", async () => {
    render(<ChatPane projectSlug="proj" />);
    await startTurn();
    await userEvent.type(box(), "discard me");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(screen.getByText("discard me")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Remove queued message/i }));
    expect(screen.queryByText("queued")).not.toBeInTheDocument();

    // Completing the turn now sends nothing extra.
    act(() => sub().handlers.onComplete?.({ sessionId: "s", jobId: "job-1", success: true }));
    expect(sends).toHaveLength(1);
  });

  it("Edit pops the message back into the composer and cancels the pending auto-send", async () => {
    render(<ChatPane projectSlug="proj" />);
    await startTurn();
    await userEvent.type(box(), "edit me");
    fireEvent.keyDown(box(), { key: "Enter" });

    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    // Popped back into the textarea; the toolbar cleared.
    await waitFor(() => expect((box() as HTMLTextAreaElement).value).toBe("edit me"));
    expect(screen.queryByText("queued")).not.toBeInTheDocument();

    // The turn finishing mid-edit must NOT fire it in the background.
    act(() => sub().handlers.onComplete?.({ sessionId: "s", jobId: "job-1", success: true }));
    expect(sends).toHaveLength(1);
  });

  it("a queued slash command flushes via the command path", async () => {
    render(<ChatPane projectSlug="proj" initialSessionId="s" loadHistory={vi.fn().mockResolvedValue([])} />);
    await startTurn();
    await userEvent.type(box(), "/compact");
    fireEvent.keyDown(box(), { key: "Enter" });

    act(() => sub().handlers.onComplete?.({ sessionId: "s", jobId: "job-1", success: true }));
    await waitFor(() => expect(commands).toHaveLength(1));
    expect(commands[0].message).toBe("/compact");
  });
});
