import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatPane, type ChatPaneProps } from "./ChatPane";
import type { ChatHandlers } from "../lib/ws";
import type { HistoryMessage } from "../lib/types";
import { makeModelsResponse, historyResult } from "../test/factories";

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

describe("ChatPane: transcript nav", () => {
  const notification = [
    "<task-notification>",
    "<task-id>b1</task-id>",
    "<status>completed</status>",
    "<summary>Background command finished</summary>",
    "</task-notification>",
  ].join("\n");
  const at = (s: number) => `2026-06-21T10:00:${String(s).padStart(2, "0")}Z`;
  // Rows 0, 5 and 7 are the user's own messages; row 2 was injected by another
  // chat and row 4 is a task notification, so neither starts a section.
  const history: HistoryMessage[] = [
    { role: "user", content: "q1", timestamp: at(0) },
    { role: "assistant", content: "a1", timestamp: at(1) },
    { role: "user", content: "relay", timestamp: at(2), sender: { kind: "agent" } },
    { role: "assistant", content: "a2", timestamp: at(3) },
    { role: "user", content: notification, timestamp: at(4) },
    { role: "user", content: "q2", timestamp: at(5) },
    { role: "assistant", content: "a3", timestamp: at(6) },
    { role: "user", content: "q3", timestamp: at(7) },
    { role: "assistant", content: "a4", timestamp: at(8) },
  ];

  // jsdom has no layout. Every row is 300px tall and 16px from the next, the
  // first 24px down; `extra` grows the last one (a streamed chunk). The scroll
  // container is 400px tall with a browser-like clamped scrollTop.
  const ROW = 316;
  const CLIENT = 400;
  let top = 0;
  let extra = 0;
  const isScroller = (el: Element) => el.classList.contains("overscroll-contain");
  const list = () => screen.getByTestId("turn-list");
  const height = () => 24 + list().children.length * ROW - 16 + 24 + extra;
  const max = () => height() - CLIENT;
  const stop = (row: number) => (row === 0 ? 0 : 24 + row * ROW - 12);
  beforeEach(() => {
    top = 0;
    extra = 0;
    const own = (el: Element, k: "scrollHeight" | "clientHeight") =>
      Object.getOwnPropertyDescriptor(Element.prototype, k)!.get!.call(el) as number;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return isScroller(this) ? height() : own(this, "scrollHeight");
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return isScroller(this) ? CLIENT : own(this, "clientHeight");
      },
    });
    const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get(this: HTMLElement) {
        return isScroller(this) ? top : (scrollTop.get!.call(this) as number);
      },
      set(this: HTMLElement, v: number) {
        if (isScroller(this)) top = Math.max(0, Math.min(v, max()));
        else scrollTop.set!.call(this, v);
      },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const parent = this.parentElement;
      const y =
        parent?.dataset.testid === "turn-list"
          ? 24 + Array.prototype.indexOf.call(parent.children, this) * ROW - top
          : 0;
      return { top: y, bottom: y + 300, left: 0, right: 0, width: 0, height: 300 } as DOMRect;
    });
  });
  afterEach(() => {
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
    vi.restoreAllMocks();
  });

  async function open(props: Partial<ChatPaneProps> = {}) {
    const { container } = render(
      <ChatPane
        projectSlug="proj"
        initialSessionId="sess-1"
        loadHistory={vi.fn().mockResolvedValue(historyResult(history))}
        {...props}
      />,
    );
    await screen.findByText("a4");
    expect(list().children).toHaveLength(9);
    return container.querySelector<HTMLElement>(".overscroll-contain")!;
  }
  const button = (name: string) => screen.getByRole("button", { name });
  const click = (name: string) => fireEvent.click(button(name));
  const userScrollTo = (el: HTMLElement, v: number) => {
    el.scrollTop = v;
    fireEvent.scroll(el);
  };
  const enabled = () =>
    ["Previous message", "Next message", "Previous section (your last message)", "Next section"]
      .concat("Jump to latest")
      .filter((n) => !(button(n) as HTMLButtonElement).disabled);

  it("opens at the bottom, where only Up and Back have somewhere to go", async () => {
    const el = await open();
    expect(el.scrollTop).toBe(max());
    expect(enabled()).toEqual(["Previous message", "Previous section (your last message)"]);
  });

  it("Up and Down move one message at a time, and Down to the end re-pins", async () => {
    const el = await open();
    click("Previous message");
    expect(el.scrollTop).toBe(stop(7));
    click("Previous message");
    expect(el.scrollTop).toBe(stop(6));
    click("Next message");
    expect(el.scrollTop).toBe(stop(7));
    // Row 8's start is past the end of the range, so Down lands at the bottom.
    click("Next message");
    expect(el.scrollTop).toBe(max());
    expect(button("Jump to latest")).toBeDisabled();
    expect(button("Next message")).toBeDisabled();
  });

  it("Up from part-way through a message goes to that message's start", async () => {
    const el = await open();
    userScrollTo(el, stop(6) + 120);
    click("Previous message");
    expect(el.scrollTop).toBe(stop(6));
  });

  it("Back and Forward move between the user's own messages, skipping the rest", async () => {
    const el = await open();
    userScrollTo(el, 0);
    expect(button("Previous message")).toBeDisabled();
    expect(button("Previous section (your last message)")).toBeDisabled();
    // Past the injected row 2 and the notification row 4.
    click("Next section");
    expect(el.scrollTop).toBe(stop(5));
    click("Next section");
    expect(el.scrollTop).toBe(stop(7));
    expect(button("Next section")).toBeDisabled();
    click("Previous section (your last message)");
    expect(el.scrollTop).toBe(stop(5));
    // From row 3, in the section row 0 starts (row 2 is injected), Back goes to row 0.
    userScrollTo(el, stop(3));
    click("Previous section (your last message)");
    expect(el.scrollTop).toBe(0);
  });

  it("Up unpins a streaming reader, and End re-pins them", async () => {
    const el = await open();
    await userEvent.type(screen.getByPlaceholderText(/Queue|Message Claude/i), "ping");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    const chunk = () => {
      extra += 300;
      act(() => sub().handlers.onResponse?.("more ", { sessionId: "sess-1", jobId: "j" }));
    };
    chunk();
    expect(el.scrollTop).toBe(max());
    expect(button("Jump to latest")).toBeDisabled();
    click("Previous message");
    const reading = el.scrollTop;
    expect(reading).toBeLessThan(max());
    chunk();
    expect(el.scrollTop).toBe(reading);
    expect(button("Jump to latest")).toBeEnabled();
    click("Jump to latest");
    expect(el.scrollTop).toBe(max());
    expect(button("Jump to latest")).toBeDisabled();
    chunk();
    expect(el.scrollTop).toBe(max());
  });

  it("sits right of the input box on a wide pane, sharing the chat actions' row when narrow", async () => {
    await open({ composerActions: <button type="button">Rename</button> });
    const nav = screen.getByRole("navigation", { name: "Transcript navigation" });
    expect(nav).toHaveClass("ml-auto", "@[57rem]:absolute", "@[57rem]:left-full");
    expect(nav).toHaveClass("@[57rem]:bottom-[15px]", "@[57rem]:grid-cols-[repeat(3,1.5rem)]");
    const actions = screen.getByRole("button", { name: "Rename" }).parentElement!;
    expect(actions).toHaveClass("@[57rem]:right-full");
    expect(actions.parentElement).toBe(nav.parentElement);
    expect(nav.parentElement).toHaveClass("flex", "flex-wrap", "justify-between");
  });

  it("is absent from an empty chat", async () => {
    render(<ChatPane projectSlug="proj" />);
    await screen.findByRole("button", { name: /^Send$/ });
    expect(screen.queryByRole("navigation", { name: "Transcript navigation" })).toBeNull();
  });
});
