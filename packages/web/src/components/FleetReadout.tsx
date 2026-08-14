import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { formatElapsed, relativeTime } from "../lib/format";
import { useMediaQuery } from "../lib/useMediaQuery";
import { useProjects } from "../lib/projects-context";
import type { AttentionChat } from "../lib/types";
import { chatClient } from "../lib/ws";
import { ROOT_KEY, viewBase } from "../routes/ProjectView/urls";
import { cx } from "./ui/cx";

/**
 * The fleet readout (#784) — a strip above every route saying what the herd is
 * doing right now.
 *
 * Paddock is a control surface for a herd of running agents, and until this
 * existed the app could not answer the operator's first question from any screen
 * but Home: *what is running, and for how long?* The sidebar's badge said "2
 * in-flight"; it did not say for how long, in which project, or whether either
 * one was about to run out of context. Two of the five things reported here did
 * not exist anywhere in the UI before: a turn's ELAPSED time (a forty-minute
 * turn and an eight-second one looked identical) and its CONTEXT pressure
 * (visible only inside the chat it belonged to — by which point you had opened
 * it anyway).
 *
 * ## The one rule
 *
 * **The only thing that moves in here is the elapsed clocks, because that is
 * data.** No pulsing lamp, no sweeping bar, no shimmer. `docs/DESIGN.md` says
 * frequency decides whether to animate at all, and a persistent readout is on
 * screen 100% of the time — anything decorative in it is decorative forever.
 * The counters advancing IS the running indicator; a second animation on top of
 * them would say the same thing twice, louder.
 *
 * ## Where the data comes from — and what it deliberately does NOT cost
 *
 * This component renders on every route, so its cost at rest has to be zero.
 * Everything except two fields is already in the client:
 *
 * - **Which turns are running, in which project, since when** — `onActiveInfos`
 *   plus `turnStartedAt`, both fed by the existing `chat:active` frames. The
 *   server broadcasts those to every socket and replays the whole running
 *   snapshot on connect, so this works on a first paint with no chat pane
 *   mounted, and survives a reload mid-turn. No fetch.
 * - **The counts** — handed down from `AppShell`, which already derives
 *   fleet-wide unread and in-flight for the sidebar badges out of the projects
 *   payload it has anyway. Sharing that derivation is not just a saved request:
 *   an independent one would let this strip disagree with the badges two inches
 *   to its left.
 * - **Project names, and the fleet's last sign of life** — the projects context,
 *   already loaded for the sidebar.
 *
 * That leaves the chat's NAME and its CONTEXT FILL, which only
 * `GET /api/root/chats/attention` knows. So that is the one request, and
 * {@link useRunningDetails} makes it only while a turn is actually in flight —
 * an idle fleet issues no requests and arms no timers. An earlier draft mounted
 * Home's `useAttentionChats` here instead, which put a fleet-wide fetch and a
 * permanent 30-second poll on every route in the app whether anything was
 * running or not.
 */

/**
 * How many channels get their own strip before the rest collapse into `+N`.
 * Resolved in JS rather than by hiding the extra strips in CSS, because the
 * `+N` has to stay TRUE: a `lg:hidden` on the third channel would leave a phone
 * showing one channel and no overflow marker at all, silently hiding three
 * running turns. `docs/DESIGN.md`: a bounded view says what it dropped. The
 * counts on the left are always exact, whatever fits.
 */
const WIDE_QUERY = "(min-width: 1280px)";
const MID_QUERY = "(min-width: 900px)";
const MIN_CHANNELS = 1;

/**
 * Through {@link useMediaQuery} rather than `window.matchMedia` directly. That
 * hook already resolves the query defensively — absent `matchMedia`, a partial
 * test mock that returns nothing, a throw — and this component mounts inside
 * the SHELL on every route, so an unguarded `.matches` is not a broken strip but
 * a white screen for the whole app. A hand-rolled version took all 36 AppShell
 * tests down before this was switched over. Unresolvable ⇒ the narrow layout,
 * which is the honest fallback because `+N` still reports whatever it dropped.
 */
function useMaxChannels(): number {
  const wide = useMediaQuery(WIDE_QUERY);
  const mid = useMediaQuery(MID_QUERY);
  return wide ? 3 : mid ? 2 : MIN_CHANNELS;
}

/** Segments in a context meter. Discrete on purpose — a gauge, not a progress bar. */
const METER_SEGMENTS = 6;

/** Context fill at which the meter changes hue. Below `WARN` it is just the accent. */
const METER_WARN = 0.75;
const METER_DANGER = 0.9;

/**
 * How long after the running set moves before asking for the new turns' details.
 * A single turn boundary fires two transitions in quick succession (this one
 * stopped, that one started) and a burst of wake-ups can fire a dozen, so they
 * coalesce into one request.
 */
const DETAIL_DEBOUNCE_MS = 250;

/**
 * How often to re-ask while turns are running. This is a REFRESH, not a poll for
 * liveness: start and stop arrive over the socket, and the only thing that goes
 * stale between them is the context fill, which grows as the turn does. Runs
 * only while something is running and the tab is visible, so an idle instance
 * schedules nothing at all.
 */
const DETAIL_REFRESH_MS = 30_000;

/** A one-second tick, live only while something is actually running. */
function useSecondsTick(live: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [live]);
}

/** The fleet's live running map (sessionId -> projectSlug), fleet-wide, no fetch. */
function useRunningSessions(): ReadonlyMap<string, string> {
  const [running, setRunning] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => chatClient.onActiveInfos((infos) => setRunning(new Map(infos))), []);
  return running;
}

/**
 * Chat name + context fill for the running turns, keyed by session id.
 *
 * The gate is the point. `runningKey` is a stable digest of the running session
 * ids, so this effect re-runs when the fleet's composition changes and at no
 * other time; when it is empty there is no fetch, no interval and no retained
 * rows. The strip still renders the instant a turn starts — the project name and
 * the clock come off the socket — and simply gains its label and gauge when this
 * lands, rather than waiting on a request to show anything at all.
 */
function useRunningDetails(runningKey: string): ReadonlyMap<string, AttentionChat> {
  const [details, setDetails] = useState<ReadonlyMap<string, AttentionChat>>(new Map());
  // Guards an out-of-order response: two fetches in flight, the older landing
  // last, would overwrite fresh rows with stale ones.
  const seqRef = useRef(0);

  useEffect(() => {
    if (!runningKey) {
      seqRef.current++; // abandon anything in flight from the last running turn
      setDetails(new Map());
      return;
    }
    let cancelled = false;
    const load = async () => {
      const seq = ++seqRef.current;
      try {
        const res = await api.attentionChats(ROOT_KEY);
        if (cancelled || seq !== seqRef.current) return;
        setDetails(new Map(res.running.map((c) => [c.sessionId, c])));
      } catch {
        // Leave the last-known rows up. A failed refresh must not blank a strip
        // whose clocks the socket is still driving correctly.
      }
    };

    const debounce = setTimeout(() => void load(), DETAIL_DEBOUNCE_MS);
    const refresh = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, DETAIL_REFRESH_MS);
    return () => {
      cancelled = true;
      clearTimeout(debounce);
      clearInterval(refresh);
    };
  }, [runningKey]);

  return details;
}

/**
 * A discrete context gauge — a row of lit segments, not a smooth progress bar.
 *
 * Renders NOTHING when the chat has no usage data yet. An instrument that shows
 * an empty gauge is claiming a measurement it does not have: six unlit segments
 * look like "0% context used", which is the opposite of "we have not measured
 * this chat". Absent is the honest state, and it also keeps the channel narrow
 * on the chats that have never completed a turn.
 *
 * A MEASURED zero therefore lights nothing (#819). An unconditional
 * `Math.max(1, …)` floor used to render 0% as 1/6 lit while the title beside it
 * read "Context 0% full". But the floor cannot simply be dropped: with six
 * segments, `Math.round` sends every fill below 1/12 (8.3%) to zero, so a chat
 * at 3% would draw the same empty gauge as a measured zero — the same conflation
 * in the other direction. Both claims have to be kept distinct, so the floor is
 * retained strictly above zero.
 */
function Meter({ fill }: { fill: number }) {
  const filled =
    fill <= 0 ? 0 : Math.max(1, Math.min(METER_SEGMENTS, Math.round(fill * METER_SEGMENTS)));
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
  chatName: string | null;
  sessionId: string;
  startedAt: number | null;
  fill: number | null;
}) {
  const time = startedAt == null ? "—:—" : formatElapsed(Date.now() - startedAt);
  const label = chatName ?? "Running turn";
  return (
    <Link
      data-testid="fleet-channel"
      to={`${viewBase(projectSlug)}/chat/${encodeURIComponent(sessionId)}`}
      title={`${label} — ${projectName}`}
      aria-label={`${label} in ${projectName}, running${startedAt == null ? "" : ` for ${time}`}`}
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
      data-testid={`fleet-${unit}`}
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
      {/* The NUMBER carries its own hook. The link's own text is the count and
          the unit run together ("0running"), so an exact-text assertion on the
          link is a trap — it reads fine and breaks the moment the label moves. */}
      <span
        data-testid={`fleet-${unit}-value`}
        className="font-mono tabular text-2xs font-semibold text-fg"
      >
        {value}
      </span>
      <span className="text-3xs font-semibold uppercase tracking-[0.14em] text-fg-subtle">
        {unit}
      </span>
    </Link>
  );
}

/**
 * @param unread Fleet-wide unread count, from the shell's own badge derivation.
 *   Passed in rather than fetched so this strip and the sidebar badges are one
 *   number computed once — see the note at the top of this file.
 */
export function FleetReadout({ unread }: { unread: number }) {
  const { projects, rootWorkspace } = useProjects();
  const running = useRunningSessions();

  // A stable digest of WHICH turns are running. The map identity changes on
  // every `chat:active` frame — including the mid-turn one that resolves a
  // jobId — and keying the fetch on that would re-request several times per
  // turn for a fleet whose composition never changed.
  const runningKey = useMemo(() => [...running.keys()].sort().join(","), [running]);
  const details = useRunningDetails(runningKey);

  useSecondsTick(running.size > 0);
  const maxChannels = useMaxChannels();

  // slug -> display name, for the channel labels. The root workspace is a real
  // place a turn can run, and its key is `""` — a falsy guard here would drop
  // every root chat from the strip without a trace.
  const projectNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.slug, p.name);
    if (rootWorkspace) m.set(rootWorkspace.slug, rootWorkspace.name);
    return m;
  }, [projects, rootWorkspace]);

  // The clock is the point of ordering: the longest-running turn is the one most
  // likely to be wedged, so it is the one that keeps its channel when the strip
  // has to collapse. Built from the SOCKET's running map, not from the fetched
  // rows — a turn that started a moment ago appears immediately, with whatever
  // detail has arrived so far.
  const channels = useMemo(() => {
    return [...running.entries()]
      .map(([sessionId, projectSlug]) => {
        const detail = details.get(sessionId);
        return {
          sessionId,
          projectSlug,
          projectName: projectNames.get(projectSlug) ?? detail?.projectName ?? projectSlug,
          chatName: detail?.name ?? null,
          startedAt: chatClient.turnStartedAt(sessionId),
          fill:
            detail?.contextTokens != null && detail.contextLimit
              ? Math.min(1, detail.contextTokens / detail.contextLimit)
              : null,
        };
      })
      // Unknown start times sort last: we cannot claim they are the oldest.
      .sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));
  }, [running, details, projectNames]);

  const shown = channels.slice(0, maxChannels);
  const hidden = channels.length - shown.length;

  // The fleet's last sign of life, for when nothing is running. Every workspace
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
      ? `Fleet idle. ${unread} unread.`
      : `${running.size} running. ${unread} unread.`;

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

        The strip keeps its height when the fleet is idle rather than collapsing
        to the counts. A readout that disappears cannot be told from a readout
        that broke, and a row that appears the instant a turn starts would shove
        every route down by 36px at the least welcome moment.
      */}
      <Stat
        value={running.size}
        unit="running"
        to="/"
        tone={running.size > 0 ? "live" : "rest"}
        title={running.size > 0 ? "Turns in flight across every project" : "Nothing running"}
      />
      <Stat
        value={unread}
        unit="unread"
        to="/"
        tone={unread > 0 ? "attention" : "rest"}
        title="Chats holding a reply you have not read"
      />

      <span className="h-4 w-px shrink-0 bg-edge-subtle" aria-hidden="true" />

      {/* The channels. `min-w-0` + `overflow-hidden` so a long project name
          truncates inside its channel rather than pushing the strip wide. */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {shown.map((c) => (
          <Channel
            key={c.sessionId}
            projectSlug={c.projectSlug}
            projectName={c.projectName}
            chatName={c.chatName}
            sessionId={c.sessionId}
            startedAt={c.startedAt}
            fill={c.fill}
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
            genuinely empty instance — offers the one thing there is to do.
            `/chat`, not `/` (#865). It pointed at Home, and on the empty instance
            this line is written for, Home WAS the Discover takeover — a screen
            with no button on it. The one affordance promising something to do
            delivered the user back to the screen that had nothing. Home is fixed
            now too, but a link that says "start a chat" should start a chat. */}
        {channels.length === 0 &&
          (lastTurnAt ? (
            <span className="truncate text-2xs text-fg-subtle">
              Idle · last turn {relativeTime(lastTurnAt)}
            </span>
          ) : (
            <Link
              to="/chat"
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
