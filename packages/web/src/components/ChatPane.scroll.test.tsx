import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatPane, type ChatPaneProps } from "./ChatPane";
import type { ChatHandlers } from "../lib/ws";
import { makeModelsResponse } from "../test/factories";

// A thin fake chat socket, cut down from ChatPane.test.tsx's: these suites only
// need to drive streamed events through the handlers the pane subscribes with.
let subs: ChatHandlers[] = [];
const sub = () => ({ handlers: subs[subs.length - 1] });

vi.mock("../lib/ws", () => ({
  chatClient: {
    state: "open",
    onBackgroundWork: (_sessionId: string, cb: (tasks: unknown[]) => void) => {
      cb([]);
      return () => {};
    },
    onStopTaskResult: () => () => {},
    stopTask: () => {},
    onState: (cb: (s: string) => void) => {
      cb("open");
      return () => {};
    },
    subscribe: (_slug: string, _sessionId: string | null, handlers: ChatHandlers) => {
      subs.push(handlers);
      return { setSessionId: () => {}, unsubscribe: () => {} };
    },
    send: () => {},
    sendCommand: () => {},
    cancel: () => {},
    setQueued: () => {},
    continueChat: () => {},
  },
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      getModels: () => Promise.resolve(makeModelsResponse()),
      chatContext: () => Promise.resolve(null),
      subagentMessages: () => Promise.resolve([]),
      projectCommands: () => Promise.resolve([]),
      transcriptionStatus: () => Promise.resolve({ available: false, mode: "off", model: "" }),
      transcribe: () => Promise.resolve(""),
      chatFileRawUrl: (id: string) => `/api/chat-files/${id}`,
    },
  };
});

beforeEach(() => {
  subs = [];
  localStorage.clear();
});

describe("ChatPane: transcript auto-scroll follows only a reader at the bottom", () => {
  // jsdom has no layout: give the transcript's scroll container a fake geometry
  // with a browser-like clamped scrollTop, and capture ResizeObservers so a test
  // can report a resize of the elements the pane observes.
  const geo = { height: 1000, client: 400 };
  let top = 0;
  let observers: Array<{ cb: () => void; targets: Element[] }> = [];
  beforeEach(() => {
    geo.height = 1000;
    geo.client = 400;
    top = 0;
    observers = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        entry: { cb: () => void; targets: Element[] };
        constructor(cb: () => void) {
          this.entry = { cb, targets: [] };
          observers.push(this.entry);
        }
        observe(t: Element) {
          this.entry.targets.push(t);
        }
        unobserve() {}
        disconnect() {
          this.entry.targets = [];
        }
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const resized = (el: Element) =>
    act(() => {
      for (const o of observers) if (o.targets.includes(el)) o.cb();
    });

  async function setup(props: Partial<ChatPaneProps> = {}) {
    const { container } = render(<ChatPane projectSlug="proj" {...props} />);
    await screen.findByRole("button", { name: /^Send$/ });
    const el = container.querySelector<HTMLElement>(".overscroll-contain")!;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => geo.height });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => geo.client });
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, Math.min(v, geo.height - geo.client));
      },
    });
    await userEvent.type(screen.getByPlaceholderText(/Message Claude/i), "ping");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    return el;
  }
  // A streamed chunk that makes the transcript `px` taller.
  const chunk = (px: number, text = "more ") => {
    geo.height += px;
    act(() => sub().handlers.onResponse?.(text, { sessionId: "s", jobId: "j" }));
  };
  const userScrollTo = (el: HTMLElement, v: number) => {
    el.scrollTop = v;
    fireEvent.scroll(el);
  };
  const bottom = () => geo.height - geo.client;

  it("follows streamed content while the reader is at the bottom", async () => {
    const el = await setup();
    expect(el.scrollTop).toBe(bottom());
    chunk(300);
    expect(el.scrollTop).toBe(bottom());
  });

  it("stops following after even a small scroll up", async () => {
    // The old rule kept anyone under 80px from the bottom pinned, so during a
    // fast stream each small trackpad tick was snapped straight back.
    const el = await setup();
    chunk(300);
    userScrollTo(el, bottom() - 10);
    const reading = el.scrollTop;
    chunk(300);
    chunk(300);
    expect(el.scrollTop).toBe(reading);
  });

  it("is not unpinned by a scroll event that arrives while content grows", async () => {
    const el = await setup();
    // Content grew (an image loaded, say) and a scroll event fires with
    // scrollTop unmoved: far from the bottom now, but the reader didn't move.
    geo.height += 500;
    fireEvent.scroll(el);
    chunk(100);
    expect(el.scrollTop).toBe(bottom());
  });

  it("follows again once the reader scrolls back down to the bottom", async () => {
    const el = await setup();
    chunk(300);
    userScrollTo(el, 100);
    chunk(300);
    expect(el.scrollTop).toBe(100);
    userScrollTo(el, bottom() - 10);
    chunk(300);
    expect(el.scrollTop).toBe(bottom());
  });

  it("sending a message re-pins a reader who had scrolled up", async () => {
    const el = await setup();
    chunk(300);
    userScrollTo(el, 50);
    act(() => sub().handlers.onComplete?.({ sessionId: "s", jobId: "j", success: true }));
    geo.height += 200;
    await userEvent.type(screen.getByPlaceholderText(/Message Claude/i), "again");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    expect(el.scrollTop).toBe(bottom());
  });

  it("a server-flushed queued message does not move a reader who scrolled up", async () => {
    const el = await setup();
    chunk(300);
    userScrollTo(el, 50);
    act(() => sub().handlers.onComplete?.({ sessionId: "s", jobId: "j", success: true }));
    geo.height += 200;
    act(() => sub().handlers.onQueuedFlushed?.({ text: "the queued one" }));
    expect(screen.getByText("the queued one")).toBeInTheDocument();
    expect(el.scrollTop).toBe(50);
  });

  it("keeps a pinned reader at the bottom when the transcript is resized", async () => {
    // The running-work / queued bars appearing below shrink the transcript;
    // content can also grow outside a `turns` change (an image loading).
    const el = await setup();
    geo.client = 250;
    resized(el);
    expect(el.scrollTop).toBe(bottom());
    geo.height += 400;
    resized(el.firstElementChild!);
    expect(el.scrollTop).toBe(bottom());
  });

  it("leaves an unpinned reader alone when the transcript is resized", async () => {
    const el = await setup();
    chunk(300);
    userScrollTo(el, 120);
    geo.client = 250;
    resized(el);
    geo.height += 400;
    resized(el.firstElementChild!);
    expect(el.scrollTop).toBe(120);
  });
});
