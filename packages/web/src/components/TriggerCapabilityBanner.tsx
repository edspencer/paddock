import { Link } from "react-router-dom";
import type { ChatTriggerInfo } from "../lib/types";
import { BoltIcon, ClockIcon } from "./icons";

/** The human firing-condition line for a trigger, by type. */
function whenLine(trigger: ChatTriggerInfo): string {
  if (trigger.type === "event") return `the ${trigger.event} event`;
  if (trigger.type === "webhook") return `a webhook (${trigger.path ?? "reserved"})`;
  const expr = trigger.cron ?? trigger.interval ?? "";
  return `a ${trigger.cron !== undefined ? "cron" : "interval"} schedule (${expr})`;
}

/**
 * A read-only capability banner that floats at the top of a TRIGGER chat's message
 * history (Epic T / T4 — the unified banner for every trigger-created chat).
 * It makes three things legible the instant you open a chat a trigger created:
 *
 *  1. **This is a trigger agent** — not a normal keeper chat — and WHAT fires it: a
 *     schedule (cron/interval), a lifecycle event, or a webhook (reserved).
 *  2. **Its granted capabilities** — the exact tools the trigger's turns may use, read
 *     from the SAME registered `trigger-<slug>-<name>` agent config herdctl enforces
 *     (`ChatTriggerInfo` is a projection of that config), so the banner is *truthful by
 *     construction*: it can't claim a capability the agent doesn't actually have.
 *  3. **An affordance toward editing the trigger** — a link to the project's Triggers
 *     tab where it's managed.
 *
 * It is deliberately READ-ONLY — it never grants or escalates permissions. The exact
 * tool list is behind a disclosure so the banner stays compact but the full grant is
 * one click away. This matters because a human continuation of a trigger chat inherits
 * the trigger's (often minimal) scope — the banner is why that's not a surprise.
 */
export function TriggerCapabilityBanner({
  trigger,
  projectSlug,
}: {
  trigger: ChatTriggerInfo;
  projectSlug: string;
}) {
  const tools = trigger.allowedTools ?? [];
  const noneDeclared = tools.length === 0;
  // A SCHEDULE trigger with no tools runs on the keeper agent, so it really does
  // get Claude's full toolset (design §2.3 — the one asymmetry). An EVENT trigger
  // with none gets its own agent with `allowed_tools: []` — which herdctl never
  // emits, so it is a DECLARATION of intent, not an enforced sandbox (#647). #319
  // tracks making a grant enforceable at all.
  const grantSummary = noneDeclared
    ? trigger.type === "schedule"
      ? "runs as Claude (full tools)"
      : "no tools declared"
    : `${tools.length} tool${tools.length === 1 ? "" : "s"} granted`;
  const Icon = trigger.type === "schedule" ? ClockIcon : BoltIcon;

  return (
    <div
      data-testid="trigger-capability-banner"
      className="sticky top-0 z-10 mb-4 rounded-xl border border-info-edge bg-info-soft/95 px-3 py-2.5 text-info shadow-sm backdrop-blur"
    >
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-info-solid/15 text-info"
        >
          <Icon width={15} height={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
            <span className="font-semibold">Trigger agent</span>
            <span
              data-trigger-type={trigger.type}
              className="rounded bg-info-solid/15 px-1.5 py-px text-2xs font-medium eyebrow text-info"
            >
              {trigger.type}
            </span>
            <span className="font-mono text-sm text-info">
              {trigger.name}
            </span>
            {!trigger.enabled && (
              <span
                title="This trigger is currently disabled — it won't fire again until re-enabled. This chat is one of its past runs."
                className="rounded bg-info-solid/15 px-1.5 py-px text-2xs font-medium eyebrow text-info"
              >
                disabled
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-info">
            Fired by <span className="font-medium">{whenLine(trigger)}</span> · {grantSummary}. A
            reply you type here runs at this trigger's capability, not Claude's.
          </p>

          {/* Clickable for the EXACT tool list + the rest of the enforced config. */}
          <details className="group mt-1.5 text-xs">
            <summary className="inline-flex cursor-pointer select-none items-center gap-1 text-info hover:underline">
              <span className="transition group-open:rotate-90" aria-hidden>
                ▸
              </span>
              Capabilities
            </summary>
            <div className="mt-2 space-y-2 border-l-2 border-info-edge pl-3">
              <div>
                <div className="mb-1 font-medium">Allowed tools</div>
                {noneDeclared ? (
                  <p className="text-info">
                    {trigger.type === "schedule"
                      ? "None declared — this schedule runs as Claude with its full toolset."
                      : "None declared. An empty list is not a restriction: no allow-list is passed to the runtime, so this agent falls back to Claude's default tools. Its prompt and max turns are the real bounds."}
                  </p>
                ) : (
                  <ul className="flex flex-wrap gap-1" data-testid="trigger-allowed-tools">
                    {tools.map((t) => (
                      <li
                        key={t}
                        className="rounded bg-info-solid/10 px-1.5 py-px font-mono text-2xs text-info"
                      >
                        {t}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-info">
                {trigger.permissionMode && (
                  <>
                    <dt className="font-medium">Permission mode</dt>
                    <dd className="font-mono text-2xs">{trigger.permissionMode}</dd>
                  </>
                )}
                {trigger.model && (
                  <>
                    <dt className="font-medium">Model</dt>
                    <dd className="font-mono text-2xs">{trigger.model}</dd>
                  </>
                )}
                <dt className="font-medium">Max turns</dt>
                <dd className="font-mono text-2xs">{trigger.maxTurns}</dd>
                <dt className="font-medium">Agent</dt>
                <dd className="truncate font-mono text-2xs">{trigger.agentName}</dd>
              </dl>

              <Link
                to={`/projects/${encodeURIComponent(projectSlug)}/triggers`}
                className="inline-flex items-center gap-1 font-medium text-info hover:underline"
                title="Manage this project's triggers"
              >
                Edit trigger →
              </Link>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
