import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { FleetReadout } from "./FleetReadout";
import { makeProject } from "../test/factories";
import type { AttentionChat, Project } from "../lib/types";

/**
 * The fleet readout (#784) — the strip above every route.
 *
 * Two things make this worth testing rather than eyeballing, and they are the
 * two things the original could not demonstrate:
 *
 *  1. **What it costs when nothing is running.** The first version of this
 *     mounted Home's whole attention feed, which put a fleet-wide request on the
 *     first paint of every route and a 30-second poll behind it forever. The
 *     component now issues NO request and schedules NO timer while the fleet is
 *     idle, and that is asserted directly — with the clock wound forward past
 *     several poll intervals, because "no fetch yet" and "no fetch ever" look
 *     identical at t=0.
 *  2. **What it does when something IS running.** Nothing in the preview or test
 *     corpus ever had a live turn, so the readout could only be judged in its
 *     idle state. Here the running set is driven directly through the WS
 *     client's subscriber, which is the same seam the server's on-connect
 *     snapshot arrives through.
 *
 * The load-bearing design property under both: the channels are derived from the
 * SOCKET, and merely enriched by the fetch. A test that stubs the fetch away
 * entirely must still see the fleet.
 */

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

const attentionChats = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: { ...actual.api, attentionChats: (...a: unknown[]) => attentionChats(...a) },
  };
});

// The WS client, driven by hand. `onActiveInfos` is the fleet-wide running map
// the server replays in full on connect; `turnStartedAt` is the per-session turn
// start it learns from the same frames.
let activeInfos = new Map<string, string>();
let startedAt = new Map<string, number>();
const activeCbs = new Set<(m: ReadonlyMap<string, string>) => void>();
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

/** Push a new fleet-wide running map to every subscriber, as the socket would. */
function setRunning(entries: [string, string][]) {
  activeInfos = new Map(entries);
  act(() => {
    for (const cb of activeCbs) cb(new Map(activeInfos));
  });
}

/** One row of `GET /api/root/chats/attention`'s `running` list. */
function attentionRow(over: Partial<AttentionChat> & { sessionId: string }): AttentionChat {
  return {
    sessionId: over.sessionId,
    name: "a chat",
    projectSlug: "a",
    projectName: "Alpha",
    archived: false,
    starred: false,
    updatedAt: new Date().toISOString(),
    ...over,
  } as AttentionChat;
}

/** Let the debounce fire and its promise settle. */
async function settleFetch() {
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
}

function renderReadout(unreadCount = 0) {
  return render(
    <MemoryRouter>
      <FleetReadout unreadCount={unreadCount} />
    </MemoryRouter>,
  );
}

const readout = () => screen.getByTestId("fleet-readout");

beforeEach(() => {
  vi.useFakeTimers();
  mockProjects = [makeProject({ slug: "a", name: "Alpha" })];
  mockRoot = makeProject({ slug: "", name: "Instance Root" });
  activeInfos = new Map();
  startedAt = new Map();
  activeCbs.clear();
  attentionChats.mockReset();
  attentionChats.mockResolvedValue({ running: [], unread: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FleetReadout: what it costs at rest", () => {
  it("issues NO request and keeps issuing none while the fleet is idle", async () => {
    renderReadout();
    await settleFetch();
    expect(attentionChats).not.toHaveBeenCalled();

    // Several poll intervals of an idle instance. This is the assertion the
    // original could not pass: a 30s backstop timer would show up here as a
    // fistful of fleet-wide requests on a screen with nothing to report.
    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(attentionChats).not.toHaveBeenCalled();
  });

  it("still reports the counts it was given, with no network at all", () => {
    renderReadout(3);
    expect(within(readout()).getByTitle(/Nothing running/i)).toHaveTextContent("0");
    expect(within(readout()).getByTitle(/reply you have not read/i)).toHaveTextContent("3");
    expect(attentionChats).not.toHaveBeenCalled();
  });

  it("says when the fleet last did anything rather than showing a void", () => {
    mockProjects = [
      makeProject({
        slug: "a",
        name: "Alpha",
        chatTurns: [{ sessionId: "s1", lastTurnCompletedAt: new Date(Date.now() - 60_000).toISOString() }],
      }),
    ];
    renderReadout();
    expect(within(readout()).getByText(/Idle · last turn/i)).toBeInTheDocument();
  });

  it("offers the one thing there is to do on an instance that has never run a turn", () => {
    mockProjects = [];
    mockRoot = makeProject({ slug: "", name: "Instance Root" });
    renderReadout();
    expect(within(readout()).getByRole("link", { name: /start a chat/i })).toBeInTheDocument();
  });
});

describe("FleetReadout: a running fleet", () => {
  it("renders a channel from the SOCKET alone, before any detail arrives", () => {
    // The fetch is stubbed to a promise that never settles: whatever the server
    // says, a turn that the hub reports as live must be on screen. A readout
    // that went blank when a request was slow would be lying about the fleet at
    // exactly the moment it matters.
    attentionChats.mockReturnValue(new Promise(() => {}));
    startedAt = new Map([["s1", Date.now() - 63_000]]);
    renderReadout();
    setRunning([["s1", "a"]]);

    const channel = within(readout()).getByRole("link", { name: /running for 1:03/i });
    expect(channel).toHaveTextContent("Alpha");
    expect(channel).toHaveTextContent("1:03");
    expect(within(readout()).getByTitle(/Turns in flight/i)).toHaveTextContent("1");
  });

  it("advances the clock once a second while a turn runs", async () => {
    startedAt = new Map([["s1", Date.now() - 8_000]]);
    renderReadout();
    setRunning([["s1", "a"]]);
    expect(within(readout()).getByText("0:08")).toBeInTheDocument();
    // An ASYNC act: two seconds is also past the detail debounce, so the fetch
    // it kicks off has to be allowed to settle inside the same window.
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(within(readout()).getByText("0:10")).toBeInTheDocument();
  });

  it("fetches detail once a turn is running, and names the chat from it", async () => {
    attentionChats.mockResolvedValue({
      running: [attentionRow({ sessionId: "s1", name: "deploy the thing" })],
      unread: [],
    });
    startedAt = new Map([["s1", Date.now()]]);
    renderReadout();
    setRunning([["s1", "a"]]);
    await settleFetch();

    expect(attentionChats).toHaveBeenCalledWith("");
    expect(within(readout()).getByRole("link", { name: /deploy the thing/i })).toBeInTheDocument();
  });

  it("draws the context gauge from the running row's usage", async () => {
    attentionChats.mockResolvedValue({
      running: [attentionRow({ sessionId: "s1", contextTokens: 40_000, contextLimit: 100_000 })],
      unread: [],
    });
    startedAt = new Map([["s1", Date.now()]]);
    renderReadout();
    setRunning([["s1", "a"]]);
    await settleFetch();

    // The gauge is the whole reason the server resolves usage for running rows;
    // without that it renders nothing at all, which is the honest state for a
    // chat that has never been measured — and indistinguishable from a bug.
    expect(within(readout()).getByTitle("Context 40% full")).toBeInTheDocument();
  });

  it("stops fetching the moment the fleet goes quiet", async () => {
    startedAt = new Map([["s1", Date.now()]]);
    renderReadout();
    setRunning([["s1", "a"]]);
    await settleFetch();
    const whileRunning = attentionChats.mock.calls.length;
    expect(whileRunning).toBeGreaterThan(0);

    setRunning([]);
    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(attentionChats).toHaveBeenCalledTimes(whileRunning);
    expect(within(readout()).getByTitle(/Nothing running/i)).toHaveTextContent("0");
  });

  it("orders by the clock and says how many it dropped", () => {
    const now = Date.now();
    startedAt = new Map([
      ["young", now - 5_000],
      ["oldest", now - 600_000],
      ["middle", now - 60_000],
    ]);
    renderReadout();
    setRunning([
      ["young", "a"],
      ["oldest", "a"],
      ["middle", "a"],
    ]);

    // jsdom has no matchMedia, so the readout takes its narrowest layout: one
    // channel. The longest-running turn is the one that keeps its channel — it
    // is the one most likely to be wedged — and the rest are COUNTED, never
    // silently dropped.
    expect(within(readout()).getByText("10:00")).toBeInTheDocument();
    expect(within(readout()).queryByText("0:05")).not.toBeInTheDocument();
    expect(within(readout()).getByTitle(/2 more running/i)).toHaveTextContent("+2");
    // The count on the left stays exact whatever fits.
    expect(within(readout()).getByTitle(/Turns in flight/i)).toHaveTextContent("3");
  });

  it("shows a turn of unknown age honestly, and sorts it last", () => {
    // No `startedAt` for `mystery`: an older server, or a frame that predates
    // this client. It is still running and still navigable — it just cannot
    // claim an age, and must not be treated as the oldest.
    startedAt = new Map([["known", Date.now() - 30_000]]);
    renderReadout();
    setRunning([
      ["mystery", "a"],
      ["known", "a"],
    ]);
    expect(within(readout()).getByText("0:30")).toBeInTheDocument();
    expect(within(readout()).getByTitle(/1 more running/i)).toBeInTheDocument();

    // Alone, it renders the placeholder rather than a zeroed clock.
    setRunning([["mystery", "a"]]);
    expect(within(readout()).getByText("—:—")).toBeInTheDocument();
  });

  it("labels a ROOT-workspace turn, whose workspace key is the empty string", () => {
    // `""` is a real key and a falsy one. A `slug || fallback` anywhere on this
    // path renders a channel with a blank label.
    startedAt = new Map([["r1", Date.now()]]);
    renderReadout();
    setRunning([["r1", ""]]);
    expect(within(readout()).getByRole("link", { name: /Instance Root/i })).toBeInTheDocument();
  });

  it("survives a failed detail fetch without losing the fleet", async () => {
    attentionChats.mockRejectedValue(new Error("offline"));
    startedAt = new Map([["s1", Date.now() - 12_000]]);
    renderReadout();
    setRunning([["s1", "a"]]);
    await settleFetch();

    // Degraded to project + clock, not to an empty strip and not to an error
    // banner across the top of every route.
    expect(within(readout()).getByText("0:12")).toBeInTheDocument();
    expect(within(readout()).getByTitle(/Turns in flight/i)).toHaveTextContent("1");
  });
});
