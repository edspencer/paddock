import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { formatElapsed, relativeTime } from "../lib/format";
import { useProjects } from "../lib/projects-context";
import { useMediaQuery } from "../lib/useMediaQuery";
import type { AttentionChat } from "../lib/types";
import { chatClient } from "../lib/ws";
import { ROOT_KEY, viewBase } from "../routes/ProjectView/urls";
import { cx } from "./ui/cx";

/**
 * The fleet readout — a strip across the top of every route (#784).
 *
 * Paddock is a control surface for a herd of running agents, and until this
 * existed the app could not answer the operator's first question from any screen
 * but Home: *what is the fleet doing right now?* A sidebar badge said "2
 * in-flight"; it did not say for how long, in which project, or whether either
 * one was about to run out of context.
 *
 * So this is a rack meter, not a status bar. It reports five things and nothing
 * else, in the order an operator asks for them:
 *
 *   1. is anything running, and how much      the RUNNING count
 *   2. for how long                           each channel's elapsed clock
 *   3. does anything want me                  the UNREAD count
 *   4. which project                          each channel's label
 *   5. is anything about to degrade           each channel's context meter
 *
 * (2) and (5) are the two that did not exist anywhere in the UI before. A turn
 * that has been going forty minutes and a turn that started eight seconds ago
 * looked identical, and context pressure was visible only inside the chat it
 * belonged to — by which point you had already opened it.
 *
 * ## The one rule
 *
 * **The only thing that moves in here is the elapsed clocks, because that is
 * data.** No pulsing lamp, no sweeping bar, no shimmer. docs/DESIGN.md says
 * frequency decides whether to animate at all, and a persistent readout is on
 * screen 100% of the time — anything decorative in it is decorative forever.
 * The counters advancing IS the running indicator; a second animation on top of
 * them would be saying the same thing twice, louder.
 *
 * ## Where the data comes from — and what it costs when nothing is running
 *
 * An earlier draft of this mounted the whole of Home's attention feed here,
 * which put a fleet-wide `GET /chats/attention` on the first paint of every
 * route and a 30-second poll behind it forever. That is the wrong shape for a
 * component whose honest answer, most of the time, is "nothing is happening":
 * it spent the most on the state that has the least to say. **Idle, this
 * component now issues no request and schedules no timer at all.**
 *
 * Everything it shows at rest is already in the app:
 *
 * - `chatClient.onActiveInfos()` is genuinely fleet-wide, not per-subscription:
 *   the server writes `chat:active` to every connected socket and replays the
 *   whole running snapshot on connect. Subscribing is also what OPENS the
 *   socket, so this works on a first paint with no chat pane mounted. It is the
 *   AUTHORITY for what is running — the channels below are derived from it, not
 *   from a fetched list, so a channel appears the instant a turn starts and
 *   survives a failed request.
 * - Elapsed comes from `chatClient.turnStartedAt()`, fed by the hub's own turn
 *   start time on those same frames. That is the part that survives a reload:
 *   coming back to the tab and being told every turn started "0:00 ago" would be
 *   worse than useless.
 * - `unreadCount` is passed in from the sidebar's badge computation, which
 *   already folds the projects payload's `chatTurns` against the read-state with
 *   no fetch of its own. Two numbers for one fact would eventually disagree.
 *
 * The one thing none of that carries is per-chat DETAIL — a chat's name and its
 * context fill. That needs `GET /api/root/chats/attention`, and it is fetched
 * ONLY while something is running (see {@link useRunningDetail}). A turn that
 * never starts costs nothing.
 */

/** Segments in a context meter. Discrete on purpose — a gauge, not a progress bar. */
const METER_SEGMENTS = 6;

/** Context fill at which the meter changes hue. Below `WARN` it is just the accent. */
const METER_WARN = 0.75;
const METER_DANGER = 0.9;

/**
 * How often the per-chat detail is re-read WHILE a turn is running.
 *
 * The gauge is the only thing that goes stale: a turn's context fill grows as it
 * works, and a forty-minute turn that reported its opening fill for forty
 * minutes would be a gauge in the decorative sense. Everything else on the strip
 * is already live over the socket.
 *
 * This is the one poll left, and it is gated three ways — only while at least
 * one turn is running, only while the tab is visible, and stopped the moment the
 * fleet goes quiet. Slow, because context moves in message-sized steps, not
 * continuously.
 */
const DETAIL_REFRESH_MS = 30_000;

/**
 * How long to wait after the running set moves before fetching detail. A single
 * turn boundary fires two transitions in quick succession (this chat stopped,
 * that one started) and a burst of scheduled wake-ups can fire a dozen —
 * coalescing them into one request keeps a busy fleet from stampeding the
 * server. The channels themselves are already on screen by then; this only fills
 * in their names and gauges.
 */
const DETAIL_DEBOUNCE_MS = 250;

/**
 * How many channels get their own strip before the rest collapse into `+N`, by
 * viewport. Responsive in JS rather than by hiding the extra strips in CSS,
 * because the `+N` has to stay TRUE: a `lg:hidden` on the third channel would
 * leave a phone showing one channel and no overflow marker at all, silently
 * hiding three running turns. docs/DESIGN.md: a bounded view says what it
 * dropped. The counts on the left are always exact, whatever fits.
 */
const WIDE = "(min-width: 1280px)";
const MEDIUM = "(min-width: 900px)";

function useMaxChannels(): number {
  // `useMediaQuery`, not a hand-rolled `window.matchMedia`: it is the app's
  // existing primitive and it is defensive about environments where matchMedia
  // is missing or partially mocked (jsdom), where a raw call throws.
  const wide = useMediaQuery(WIDE);
  const medium = useMediaQuery(MEDIUM);
  return wide ? 3 : medium ? 2 : 1;
}

/**
 * A one-second tick, live only while something is actually running. An idle
 * fleet has no clocks to advance, so it does no work and schedules no timer —
 * this component is on screen on every route, so it has to cost nothing at rest.
 */
function useSecondsTick(live: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [live]);
}

/** The fleet's live running map (sessionId -> workspace key), fleet-wide. */
function useRunningSessions(): ReadonlyMap<string, string> {
  const [running, setRunning] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => chatClient.onActiveInfos((infos) => setRunning(new Map(infos))), []);
  return running;
}

/**
 * Per-chat detail for the running set — name and context fill — keyed by session
 * id. **Fetches only while something is running.**
 *
 * This is the whole of the readout's network cost, and the gating is the point.
 * The hook is handed the running set as its trigger rather than watching one
 * itself, for the same reason `useAttentionChats` takes one: there must be ONE
 * fleet-wide running set on the client, not a copy per consumer.
 *
 * Note what it does NOT do, deliberately:
 *
 * - It does not decide what is running. That comes from the socket, and the
 *   caller renders a channel with or without an entry here. A slow, failed, or
 *   racing request therefore degrades to a channel with a project and a clock
 *   and no name — never to a fleet that looks idle.
 * - It has no backstop poll for the idle case. There is nothing to be stale
 *   ABOUT when nothing is running: the caller shows counts that are already
 *   live over the socket, and this map is cleared to empty.
 */
function useRunningDetail(running: ReadonlyMap<string, string>): Map<string, AttentionChat> {
  const [detail, setDetail] = useState<Map<string, AttentionChat>>(new Map());
  // Guards an out-of-order response: two fetches in flight, the older landing
  // last, would overwrite fresh rows with stale ones.
  const seqRef = useRef(0);
  const anyRunning = running.size > 0;

  useEffect(() => {
    if (!anyRunning) {
      // Nothing running ⇒ nothing to describe. Cleared rather than left behind,
      // so a turn starting on the same chat a minute later cannot flash the
      // previous turn's context fill before its own arrives.
      seqRef.current++;
      setDetail(new Map());
      return;
    }

    const load = async () => {
      const seq = ++seqRef.current;
      try {
        // The ROOT mount: its subtree key is `""`, which prefixes every
        // workspace key, so one request covers the whole fleet regardless of
        // which project the user happens to be looking at.
        const res = await api.attentionChats(ROOT_KEY);
        if (seq !== seqRef.current) return;
        setDetail(new Map(res.running.map((c) => [c.sessionId, c])));
      } catch {
        // Swallowed on purpose. The channels are already rendered from the
        // socket; the only thing lost is a name and a gauge, and an error
        // banner across the top of every route for that would be louder than
        // the failure.
      }
    };

    const debounce = setTimeout(() => void load(), DETAIL_DEBOUNCE_MS);
    const tick = () => {
      if (document.visibilityState === "visible") void load();
    };
    const poll = setInterval(tick, DETAIL_REFRESH_MS);
    // Coming back to a tab is exactly when the accumulated staleness matters.
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearTimeout(debounce);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [running, anyRunning]);

  return detail;
}

/**
 * A discrete context gauge — a row of lit segments, not a smooth progress bar.
 *
 * Renders NOTHING when the chat has no usage data yet. An instrument that shows
 * an empty gauge is claiming a measurement it does not have: six unlit segments
 * look like "0% context used", which is the opposite of "we have not measured
 * this chat". Absent is the honest state, and it also keeps the channel narrow
 * on the chats that have never completed a turn.
 */
function Meter({ fill }: { fill: number }) {
  const filled = Math.max(1, Math.min(METER_SEGMENTS, Math.round(fill * METER_SEGMENTS)));
  const hue =
    fill < METER_WARN ? "bg-accent-solid" : fill < METER_DANGER ? "bg-warn-solid" : "bg-danger-solid";
  return (
    <span
      className="flex items-center gap-px"
      title={`Context ${Math.round(fill * 100)}% full`}
      aria-hidden="true"
    >
      {Array.from({ length: METER_SEGMENTS }, (_, i) => (
        <span key={i} className={cx("h-2.5 w-[3px] rounded-[1px]", i < filled ? hue : "bg-edge")} />
      ))}
    </span>
  );
}

/** One running turn, ready to render. Assembled in {@link FleetReadout}. */
interface ChannelData {
  sessionId: string;
  projectSlug: string;
  projectName: string;
  /** The chat's own name — absent until the detail fetch lands (or if it fails). */
  chatName: string | null;
  /** Epoch-ms the turn began, or null if this client was never told. */
  startedAt: number | null;
  /** Context fill 0..1, or null when the chat has no usage data yet. */
  fill: number | null;
}

/**
 * One running turn, as a mixing-desk channel strip: project, clock, gauge.
 * The whole strip is the hit target (>=24px tall) and navigates to that chat.
 */
function Channel({ sessionId, projectSlug, projectName, chatName, startedAt, fill }: ChannelData) {
  const time = startedAt == null ? "—:—" : formatElapsed(Date.now() - startedAt);
  // VISIBLY the project, not the chat. At this width one name fits, and across a
  // fleet the project is the one that identifies the work — chat names are often
  // the first line someone typed. The chat's own name is still carried, in the
  // tooltip and the accessible name, where it costs no space.
  //
  // It falls back to the project when the detail fetch has not landed. Never a
  // placeholder like "Loading…": the channel is already telling the truth about
  // a real running turn, and a spinner would imply it might not be.
  const described = chatName ?? projectName;
  return (
    <Link
      to={`${viewBase(projectSlug)}/chat/${encodeURIComponent(sessionId)}`}
      title={chatName ? `${chatName} — ${projectName}` : projectName}
      aria-label={`${described} in ${projectName}, running${startedAt == null ? "" : ` for ${time}`}`}
      className="focus-visible:focus-ring flex h-6 shrink-0 items-center gap-2 rounded-md border border-edge-subtle bg-surface px-2 text-2xs can-hover:hover:border-edge can-hover:hover:bg-surface-hover"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-[1px] bg-accent-solid" aria-hidden="true" />
      <span className="max-w-[14ch] truncate font-medium text-fg">{projectName}</span>
      <span className="font-mono tabular text-fg-muted">{time}</span>
      {fill != null && <Meter fill={fill} />}
    </Link>
  );
}

/** A count with its unit, as one hit target. `tone` carries the only colour. */
function Stat({
  value,
  unit,
  to,
  tone,
  title,
}: {
  value: number;
  unit: string;
  to: string;
  tone: "live" | "attention" | "rest";
  title: string;
}) {
  return (
    <Link
      to={to}
      title={title}
      className="focus-visible:focus-ring flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 can-hover:hover:bg-surface-hover"
    >
      <span
        aria-hidden="true"
        className={cx(
          "h-1.5 w-1.5 shrink-0 rounded-[1px]",
          tone === "live" && "bg-accent-solid",
          tone === "attention" && "bg-warn-solid",
          tone === "rest" && "bg-edge-strong",
        )}
      />
      <span className="font-mono tabular text-2xs font-semibold text-fg">{value}</span>
      <span className="text-3xs font-semibold uppercase tracking-[0.14em] text-fg-subtle">
        {unit}
      </span>
    </Link>
  );
}

export function FleetReadout({ unreadCount }: { unreadCount: number }) {
  // Project names for the channels, and the idle line's "last turn" time. The
  // project COUNT was in here and came out again: the sidebar lists every
  // project two inches to the left.
  const { projects, rootWorkspace } = useProjects();
  const running = useRunningSessions();
  const detail = useRunningDetail(running);

  useSecondsTick(running.size > 0);
  const maxChannels = useMaxChannels();

  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.slug, p.name);
    // The root's key is `""` — a real key, and a falsy one. It has to be set
    // explicitly or every root chat's channel renders an empty label.
    if (rootWorkspace) m.set(ROOT_KEY, rootWorkspace.name);
    return m;
  }, [projects, rootWorkspace]);

  // Channels are derived from the SOCKET's running map — the authority — and
  // merely enriched from the detail fetch. Ordering is by the clock, because the
  // longest-running turn is the one most likely to be wedged, so it is the one
  // that keeps its channel when the strip has to collapse.
  const channels = useMemo(() => {
    const out: ChannelData[] = [];
    for (const [sessionId, projectSlug] of running) {
      const chat = detail.get(sessionId);
      out.push({
        sessionId,
        projectSlug,
        // The detail row's own project name wins when present: it is the
        // server's attribution for that chat, and the projects list can lag a
        // freshly-created project by one refresh.
        projectName: chat?.projectName ?? nameOf.get(projectSlug) ?? projectSlug,
        chatName: chat?.name ?? null,
        startedAt: chatClient.turnStartedAt(sessionId),
        fill:
          chat?.contextTokens != null && chat.contextLimit
            ? Math.min(1, chat.contextTokens / chat.contextLimit)
            : null,
      });
    }
    // Unknown start times sort last: we cannot claim they are the oldest.
    return out.sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));
  }, [running, detail, nameOf]);

  const shown = channels.slice(0, maxChannels);
  const hidden = channels.length - shown.length;

  // The fleet's last sign of life, for when nothing is running. Every project
  // payload already carries its chats' completed-turn times, so this is free.
  const lastTurnAt = useMemo(() => {
    let newest = "";
    for (const p of rootWorkspace ? [...projects, rootWorkspace] : projects) {
      for (const t of p.chatTurns ?? []) {
        if (t.lastTurnCompletedAt > newest) newest = t.lastTurnCompletedAt;
      }
    }
    return newest;
  }, [projects, rootWorkspace]);

  // Announce only the counts, and only when they change — a live region that
  // re-read every ticking clock once a second would be unusable.
  const summary =
    running.size === 0
      ? `Fleet idle. ${unreadCount} unread.`
      : `${running.size} running. ${unreadCount} unread.`;

  return (
    <div
      data-testid="fleet-readout"
      className="flex h-9 shrink-0 items-center gap-2 border-b border-edge-subtle bg-surface-sunken px-2 sm:px-3"
    >
      {/*
        The strip keeps a FIXED height whether or not anything is running, and
        that is a decision rather than an oversight (#784 asks it to be made
        deliberately). Collapsing it away when the fleet goes quiet would save
        36px on a laptop — but this sits above every route, including an open
        chat transcript, and the trigger is a FLEET event: some other agent, in
        some other project, starting a turn. Reflowing the document you are
        reading because something happened elsewhere is a worse cost than the
        pixels, and the alternative (animating the collapse) would break the one
        rule this component has. So the strip stays put and the idle STATE gets
        cheaper instead: no request, no timer, and nothing in it but the counts
        and one line saying when the fleet last did anything.

        A "FLEET" label sat on the left and came off. It was the only element in
        here carrying no data — the counts next to it already say RUNNING and
        UNREAD — and on a narrow viewport it spent ~50px a channel could use.
      */}
      <Stat
        value={running.size}
        unit="running"
        to="/"
        tone={running.size > 0 ? "live" : "rest"}
        title={running.size > 0 ? "Turns in flight across every project" : "Nothing running"}
      />
      <Stat
        value={unreadCount}
        unit="unread"
        to="/"
        tone={unreadCount > 0 ? "attention" : "rest"}
        title="Chats holding a reply you have not read"
      />

      <span className="h-4 w-px shrink-0 bg-edge-subtle" aria-hidden="true" />

      {/* The channels. `min-w-0` + `overflow-hidden` so a long project name
          truncates inside its channel rather than pushing the strip wide. */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {shown.map((c) => (
          <Channel key={c.sessionId} {...c} />
        ))}
        {hidden > 0 && (
          <Link
            to="/"
            className="focus-visible:focus-ring shrink-0 rounded-md px-1.5 py-1 font-mono tabular text-2xs text-fg-muted can-hover:hover:bg-surface-hover can-hover:hover:text-fg"
            title={`${hidden} more running — open Home for the full list`}
          >
            +{hidden}
          </Link>
        )}

        {/* Idle. Not a void: it says when the fleet last did anything, or — on a
            genuinely empty instance — offers the one thing there is to do. */}
        {channels.length === 0 &&
          (lastTurnAt ? (
            <span className="truncate text-2xs text-fg-subtle">
              Idle · last turn {relativeTime(lastTurnAt)}
            </span>
          ) : (
            <Link
              to="/"
              className="focus-visible:focus-ring truncate rounded-md px-1 text-2xs text-accent can-hover:hover:underline"
            >
              No turns yet — start a chat →
            </Link>
          ))}
      </div>

      <span role="status" aria-live="polite" className="sr-only">
        {summary}
      </span>
    </div>
  );
}
