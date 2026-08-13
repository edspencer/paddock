/**
 * The fleet readout (#784) — the strip above every route.
 *
 * Two things are worth testing here and the rest is decoration:
 *
 *   1. **What it costs at rest.** It renders on every route, so an idle fleet
 *      must issue no requests at all. That was the design review's objection to
 *      the original, which mounted Home's attention hook and polled forever.
 *   2. **That the socket alone is enough to draw a channel.** Project, clock and
 *      ordering come from `chat:active`; only the chat's name and its context
 *      fill need the one gated request. A strip that waited on a fetch would be
 *      blank for the first quarter-second of every turn.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { FleetReadout } from "./FleetReadout";
import { makeProject } from "../test/factories";
import type { AttentionChat, Project } from "../lib/types";

let mockProjects: Project[] = [];
let mockRoot: Project | null = null;
vi.mock("../lib/projects-context", () => ({
  useProjects: () => ({
    projects: mockProjects,
    rootWorkspace: mockRoot,
    loading: false,
    error: null,
    refresh: vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn(),
  }),
}));

/** The running map the mocked client hands out, plus the turn-start answers. */
let activeInfos = new Map<string, string>();
let startedAt = new Map<string, number>();
const activeCbs = new Set<(m: ReadonlyMap<string, string>) => void>();
function setRunning(entries: [string, string][]) {
  activeInfos = new Map(entries);
  act(() => {
    for (const cb of activeCbs) cb(new Map(activeInfos));
  });
}
vi.mock("../lib/ws", () => ({
  chatClient: {
    onActiveInfos: (cb: (m: ReadonlyMap<string, string>) => void) => {
      activeCbs.add(cb);
      cb(new Map(activeInfos));
      return () => activeCbs.delete(cb);
    },
    turnStartedAt: (id: string) => startedAt.get(id) ?? null,
  },
}));

const attentionChats = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: { ...actual.api, attentionChats: (...a: unknown[]) => attentionChats(...a) },
  };
});

function row(over: Partial<AttentionChat> & { sessionId: string }): AttentionChat {
  return {
    name: `chat ${over.sessionId}`,
    projectSlug: "a",
    projectName: "Alpha",
    updatedAt: "2026-08-01T00:00:00.000Z",
    archived: false,
    starred: false,
    ...over,
  } as AttentionChat;
}

function renderReadout(unread = 0) {
  return render(
    <MemoryRouter>
      <FleetReadout unread={unread} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockProjects = [makeProject({ slug: "a", name: "Alpha" }), makeProject({ slug: "b", name: "Beta" })];
  mockRoot = null;
  activeInfos = new Map();
  startedAt = new Map();
  activeCbs.clear();
  attentionChats.mockReset();
  attentionChats.mockResolvedValue({ running: [], unread: [] });
  vi.useRealTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("FleetReadout: what it costs at rest", () => {
  it("issues NO request while the fleet is idle", async () => {
    vi.useFakeTimers();
    renderReadout();
    // Well past the debounce AND the refresh interval. The point of the gate is
    // that neither timer is even armed, so advancing time proves it rather than
    // just failing to catch it.
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(attentionChats).not.toHaveBeenCalled();
  });

  it("stops asking again as soon as the last turn ends", async () => {
    renderReadout();
    setRunning([["s1", "a"]]);
    await waitFor(() => expect(attentionChats).toHaveBeenCalled());
    const afterRunning = attentionChats.mock.calls.length;

    setRunning([]);
    // Nothing further, and the strip drops back to its idle line rather than
    // leaving the last turn's channel on screen.
    await waitFor(() => expect(screen.queryByText(/Alpha/)).not.toBeInTheDocument());
    expect(attentionChats.mock.calls.length).toBe(afterRunning);
  });

  it("asks ONCE for a fleet whose composition has not changed", async () => {
    // `chat:active` fires again mid-turn when the jobId resolves, so the map's
    // identity changes without the running SET changing. Keying the fetch on the
    // map rather than on its ids would re-request several times per turn.
    renderReadout();
    setRunning([["s1", "a"]]);
    await waitFor(() => expect(attentionChats).toHaveBeenCalledTimes(1));
    setRunning([["s1", "a"]]);
    setRunning([["s1", "a"]]);
    await new Promise((r) => setTimeout(r, 400));
    expect(attentionChats).toHaveBeenCalledTimes(1);
  });
});

describe("FleetReadout: the counts", () => {
  it("reports the running count from the socket and the unread count from its prop", () => {
    renderReadout(3);
    expect(screen.getByTestId("fleet-running")).toHaveTextContent("0");
    expect(screen.getByTestId("fleet-unread")).toHaveTextContent("3");

    setRunning([
      ["s1", "a"],
      ["s2", "b"],
    ]);
    expect(screen.getByTestId("fleet-running")).toHaveTextContent("2");
  });

  it("announces the counts, and only the counts, to a screen reader", () => {
    // A live region that re-read every ticking clock once a second would be
    // unusable, so the clocks are deliberately not in it.
    renderReadout(1);
    expect(screen.getByRole("status")).toHaveTextContent("Fleet idle. 1 unread.");
    setRunning([["s1", "a"]]);
    expect(screen.getByRole("status")).toHaveTextContent("1 running. 1 unread.");
  });
});

describe("FleetReadout: channels", () => {
  it("draws a channel from the SOCKET alone, before any detail has landed", () => {
    // Never resolves — so anything on screen here came from `chat:active`.
    attentionChats.mockReturnValue(new Promise(() => {}));
    startedAt.set("s1", Date.now() - 65_000);
    renderReadout();
    setRunning([["s1", "a"]]);

    const channel = screen.getByTestId("fleet-channel");
    expect(channel).toHaveTextContent("Alpha");
    expect(channel).toHaveTextContent("1:05");
    expect(channel).toHaveAttribute("href", "/projects/a/chat/s1");
  });

  it("renders a placeholder — not a zeroed clock — for a turn with no known start", () => {
    // The client returns null for a turn it was never told the start of. An
    // invented `Date.now()` would restart the clock on every page load and look
    // exactly like a fresh turn, which is the bug `startedAt` exists to fix.
    renderReadout();
    setRunning([["s1", "a"]]);
    expect(screen.getByTestId("fleet-channel")).toHaveTextContent("—:—");
  });

  it("puts the LONGEST-running turn first, and sorts unknown starts last", () => {
    // The longest-running turn is the one most likely to be wedged, so it is the
    // one that keeps its channel when the strip collapses.
    startedAt.set("newer", Date.now() - 5_000);
    startedAt.set("older", Date.now() - 600_000);
    mockProjects = [
      makeProject({ slug: "a", name: "Alpha" }),
      makeProject({ slug: "b", name: "Beta" }),
      makeProject({ slug: "c", name: "Gamma" }),
    ];
    renderReadout();
    setRunning([
      ["unknown", "c"],
      ["newer", "a"],
      ["older", "b"],
    ]);

    // jsdom matches no width query, so one channel shows and the rest collapse.
    const shown = screen.getAllByTestId("fleet-channel");
    expect(shown).toHaveLength(1);
    expect(shown[0]).toHaveTextContent("Beta");
    expect(screen.getByTitle(/2 more running/)).toHaveTextContent("+2");
  });

  it("keeps the +N honest rather than hiding the overflow in CSS", () => {
    renderReadout();
    setRunning([
      ["s1", "a"],
      ["s2", "b"],
    ]);
    // One drawn, one accounted for — never one drawn and one silently dropped.
    expect(screen.getAllByTestId("fleet-channel")).toHaveLength(1);
    expect(screen.getByTitle(/1 more running/)).toHaveTextContent("+1");
    expect(screen.getByTestId("fleet-running")).toHaveTextContent("2");
  });

  it("gains the context gauge when the detail request lands", async () => {
    attentionChats.mockResolvedValue({
      running: [row({ sessionId: "s1", contextTokens: 100_000, contextLimit: 200_000 })],
      unread: [],
    });
    renderReadout();
    setRunning([["s1", "a"]]);
    await waitFor(() => expect(screen.getByTitle("Context 50% full")).toBeInTheDocument());
  });

  it("draws NO gauge for a chat with no usage — absent beats a zeroed meter", async () => {
    // Six unlit segments read as "0% context used", which is the opposite of
    // "we have not measured this chat".
    attentionChats.mockResolvedValue({ running: [row({ sessionId: "s1" })], unread: [] });
    renderReadout();
    setRunning([["s1", "a"]]);
    await waitFor(() => expect(attentionChats).toHaveBeenCalled());
    expect(screen.queryByTitle(/Context .* full/)).not.toBeInTheDocument();
  });

  it("lights NO segment for a MEASURED zero, but still one for a tiny non-zero fill (#819)", async () => {
    // `contextTokens: 0` with a real limit is a MEASURED zero, distinct from the
    // `null` the test above covers: the gauge is drawn, and must be empty. It is
    // also not the same claim as "a little used". Assert on the SEGMENTS, not on
    // the title — the title was already honest and would not have caught either
    // direction of the bug.
    attentionChats.mockResolvedValue({
      running: [row({ sessionId: "s1", contextTokens: 0, contextLimit: 200_000 })],
      unread: [],
    });
    const { unmount } = renderReadout();
    setRunning([["s1", "a"]]);
    const gauge = await screen.findByTitle("Context 0% full");
    const lit = within(gauge)
      .getAllByRole("generic", { hidden: true })
      .filter((s) => /bg-(accent|warn|danger)-solid/.test(s.className));
    expect(lit).toHaveLength(0);
    unmount();

    // Barely-started still reads as started: the floor applies above zero.
    attentionChats.mockResolvedValue({
      running: [row({ sessionId: "s2", contextTokens: 1, contextLimit: 200_000 })],
      unread: [],
    });
    renderReadout();
    setRunning([["s2", "a"]]);
    const tiny = await screen.findByTitle("Context 0% full");
    const tinyLit = within(tiny)
      .getAllByRole("generic", { hidden: true })
      .filter((s) => /bg-(accent|warn|danger)-solid/.test(s.className));
    expect(tinyLit).toHaveLength(1);
  });

  it("still lights a segment for a small non-zero fill", async () => {
    // 1/6 = 16.7%, so 20% is the first fill that rounds up on its own, without
    // the floor. Keeps the natural threshold pinned alongside the floored case.
    attentionChats.mockResolvedValue({
      running: [row({ sessionId: "s1", contextTokens: 40_000, contextLimit: 200_000 })],
      unread: [],
    });
    renderReadout();
    setRunning([["s1", "a"]]);
    const meter = await screen.findByTitle("Context 20% full");
    const litSmall = Array.from(meter.children).filter((s) => !s.className.includes("bg-edge"));
    expect(litSmall).toHaveLength(1);
  });

  it("keeps a channel for a turn in the ROOT workspace, whose key is the empty string", async () => {
    // `""` is a real workspace key. A falsy guard anywhere on this path would
    // drop every root chat from the strip with no trace.
    mockRoot = makeProject({ slug: "", name: "Instance" });
    renderReadout();
    setRunning([["s1", ""]]);
    const channel = screen.getByTestId("fleet-channel");
    expect(channel).toHaveTextContent("Instance");
    expect(channel).toHaveAttribute("href", "/chat/s1");
  });
});

describe("FleetReadout: the idle state", () => {
  it("says when the fleet last did something rather than showing a void", () => {
    mockProjects = [
      makeProject({
        slug: "a",
        name: "Alpha",
        chatTurns: [
          { sessionId: "s1", lastTurnCompletedAt: new Date(Date.now() - 3_600_000).toISOString() },
        ] as Project["chatTurns"],
      }),
    ];
    renderReadout();
    expect(screen.getByText(/Idle · last turn/)).toBeInTheDocument();
  });

  it("offers the one thing there is to do on an instance that has never run a turn", () => {
    mockProjects = [makeProject({ slug: "a", name: "Alpha" })];
    renderReadout();
    expect(screen.getByRole("link", { name: /start a chat/i })).toBeInTheDocument();
  });
});
