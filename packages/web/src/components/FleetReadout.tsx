import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { formatElapsed, relativeTime } from "../lib/format";
import { useProjects } from "../lib/projects-context";
import { chatClient } from "../lib/ws";
import { useAttentionChats } from "../routes/ProjectView/useAttentionChats";
import { ROOT_KEY, viewBase } from "../routes/ProjectView/urls";
import { cx } from "./ui/cx";

/**
 * The fleet readout — direction `instrument`'s signature element.
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
 * ## Where the data comes from (no new polling)
 *
 * - `chatClient.onActiveInfos()` is genuinely fleet-wide, not per-subscription:
 *   the server writes `chat:active` to every connected socket and replays the
 *   whole running snapshot on connect. Subscribing is also what OPENS the
 *   socket, so this works on a first paint with no chat pane mounted.
 * - `useAttentionChats(ROOT_KEY)` is the same hook Home uses; on the root mount
 *   its subtree is the whole fleet. It already debounces on the running set,
 *   takes a second settling sample, and backstop-polls — so mounting it here
 *   costs one more consumer, not a new sync strategy.
 * - Elapsed comes from `chatClient.turnStartedAt()`, fed by the hub's own turn
 *   start time. That is the part that survives a reload: coming back to the tab
 *   and being told every turn started "0:00 ago" would be worse than useless.
 */

/**
 * How many channels get their own strip before the rest collapse into `+N`,
 * by viewport. Responsive in JS rather than by hiding the extra strips in CSS,
 * because the `+N` has to stay TRUE: a `lg:hidden` on the third channel would
 * leave a phone showing one channel and no overflow marker at all, silently
 * hiding three running turns. docs/DESIGN.md: a bounded view says what it
 * dropped. The counts on the left are always exact, whatever fits.
 */
const CHANNEL_BREAKPOINTS = [
  { query: "(min-width: 1280px)", channels: 3 },
  { query: "(min-width: 900px)", channels: 2 },
] as const;
const MIN_CHANNELS = 1;

function useMaxChannels(): number {
  const [max, setMax] = useState(MIN_CHANNELS);
  useEffect(() => {
    const lists = CHANNEL_BREAKPOINTS.map((b) => window.matchMedia(b.query));
    const apply = () => {
      const hit = CHANNEL_BREAKPOINTS.findIndex((_, i) => lists[i].matches);
      setMax(hit === -1 ? MIN_CHANNELS : CHANNEL_BREAKPOINTS[hit].channels);
    };
    apply();
    for (const l of lists) l.addEventListener("change", apply);
    return () => {
      for (const l of lists) l.removeEventListener("change", apply);
    };
  }, []);
  return max;
}

/** Segments in a context meter. Discrete on purpose — a gauge, not a progress bar. */
const METER_SEGMENTS = 6;

/** Context fill at which the meter changes hue. Below `WARN` it is just the accent. */
const METER_WARN = 0.75;
const METER_DANGER = 0.9;

/**
 * A one-second tick, live only while something is actually running. An idle
 * fleet has no clocks to advance, so it does no work and schedules no timer —
 * this component is on screen on every route, so it has to cost nothing at rest.
 *
 * Exported because Home's running rows tick on the same second (see
 * `formatElapsed`): two surfaces showing one turn should not drift apart by
 * half a second because they each own a timer that started at a different time.
 */
export function useSecondsTick(live: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [live]);
}

/** The fleet's live running map (sessionId -> projectSlug), fleet-wide. */
function useRunningSessions(): ReadonlyMap<string, string> {
  const [running, setRunning] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => chatClient.onActiveInfos((infos) => setRunning(new Map(infos))), []);
  return running;
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
    fill < METER_WARN
      ? "bg-accent-solid"
      : fill < METER_DANGER
        ? "bg-warn-solid"
        : "bg-danger-solid";
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

/**
 * One running turn, as a mixing-desk channel strip: project, clock, gauge.
 * The whole strip is the hit target (>=24px tall) and navigates to that chat.
 */
function Channel({
  projectSlug,
  projectName,
  chatName,
  sessionId,
  startedAt,
  fill,
}: {
  projectSlug: string;
  projectName: string;
  chatName: string;
  sessionId: string;
  startedAt: number | null;
  fill: number | null;
}) {
  const time = startedAt == null ? "—:—" : formatElapsed(Date.now() - startedAt);
  return (
    <Link
      to={`${viewBase(projectSlug)}/chat/${encodeURIComponent(sessionId)}`}
      title={`${chatName} — ${projectName}`}
      aria-label={`${chatName} in ${projectName}, running${startedAt == null ? "" : ` for ${time}`}`}
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

export function FleetReadout() {
  // Only for the idle line's "last turn" time — the project COUNT was in here
  // and came out again: the sidebar lists every project two inches to the left.
  const { projects } = useProjects();
  const running = useRunningSessions();
  // Root mount ⇒ the whole fleet. Same hook, same debounce/settle/backstop as
  // Home's feed; the running map is only its change signal, exactly as there.
  const runningIds = useMemo(() => new Set(running.keys()), [running]);
  const { running: runningChats, unread } = useAttentionChats(ROOT_KEY, runningIds);

  useSecondsTick(running.size > 0);
  const maxChannels = useMaxChannels();

  // The clock is the point of ordering: the longest-running turn is the one most
  // likely to be wedged, so it is the one that keeps its channel when the strip
  // has to collapse. `startedAt` is read once per render into a stable shape so
  // the sort and the render agree.
  const channels = useMemo(() => {
    return runningChats
      .map((c) => ({
        chat: c,
        startedAt: chatClient.turnStartedAt(c.sessionId),
        fill:
          c.contextTokens != null && c.contextLimit
            ? Math.min(1, c.contextTokens / c.contextLimit)
            : null,
      }))
      // Unknown start times sort last: we cannot claim they are the oldest.
      .sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));
  }, [runningChats]);

  const shown = channels.slice(0, maxChannels);
  const hidden = channels.length - shown.length;

  // The fleet's last sign of life, for when nothing is running. Every project
  // payload already carries its chats' completed-turn times, so this is free.
  const lastTurnAt = useMemo(() => {
    let newest = "";
    for (const p of projects) {
      for (const t of p.chatTurns ?? []) {
        if (t.lastTurnCompletedAt > newest) newest = t.lastTurnCompletedAt;
      }
    }
    return newest;
  }, [projects]);

  // Announce only the counts, and only when they change — a live region that
  // re-read every ticking clock once a second would be unusable.
  const summary =
    running.size === 0
      ? `Fleet idle. ${unread.length} unread.`
      : `${running.size} running. ${unread.length} unread.`;

  return (
    <div
      data-testid="fleet-readout"
      className="flex h-9 shrink-0 items-center gap-2 border-b border-edge-subtle bg-surface-sunken px-2 sm:px-3"
    >
      {/*
        A "FLEET" label sat here and came off. It was the only element in this
        strip that carried no data — the counts next to it already say RUNNING
        and UNREAD, so it was naming something self-evident, and on a narrow
        viewport it was spending ~50px that a channel could use. Everything left
        in here is a number or the thing that makes a number legible.
      */}
      <Stat
        value={running.size}
        unit="running"
        to="/"
        tone={running.size > 0 ? "live" : "rest"}
        title={running.size > 0 ? "Turns in flight across every project" : "Nothing running"}
      />
      <Stat
        value={unread.length}
        unit="unread"
        to="/"
        tone={unread.length > 0 ? "attention" : "rest"}
        title="Chats holding a reply you have not read"
      />

      <span className="h-4 w-px shrink-0 bg-edge-subtle" aria-hidden="true" />

      {/* The channels. `min-w-0` + `overflow-hidden` so a long project name
          truncates inside its channel rather than pushing the strip wide. */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {shown.map(({ chat, startedAt, fill }) => (
          <Channel
            key={`${chat.projectSlug}:${chat.sessionId}`}
            projectSlug={chat.projectSlug}
            projectName={chat.projectName}
            chatName={chat.name}
            sessionId={chat.sessionId}
            startedAt={startedAt}
            fill={fill}
          />
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
