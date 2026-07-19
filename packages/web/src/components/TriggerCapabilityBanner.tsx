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
 * history (Epic T / T4 — the unified successor to the Epic G `HookCapabilityBanner`).
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
  const toolLess = tools.length === 0;
  // A tool-less SCHEDULE trigger runs as the keeper (full tools); a tool-less EVENT
  // trigger is a deliberately tool-less curator (design §2.3 — the one asymmetry).
  const grantSummary = toolLess
    ? trigger.type === "schedule"
      ? "runs as the keeper (full tools)"
      : "no tools — reasoning only"
    : `${tools.length} tool${tools.length === 1 ? "" : "s"} granted`;
  const Icon = trigger.type === "schedule" ? ClockIcon : BoltIcon;

  return (
    <div
      data-testid="trigger-capability-banner"
      className="sticky top-0 z-10 mb-4 rounded-xl border border-sky-300/70 bg-sky-50/95 px-3 py-2.5 text-sky-900 shadow-sm backdrop-blur dark:border-sky-500/40 dark:bg-sky-950/85 dark:text-sky-100"
    >
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-sky-500/15 text-sky-600 dark:text-sky-300"
        >
          <Icon width={15} height={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
            <span className="font-semibold">Trigger agent</span>
            <span
              data-trigger-type={trigger.type}
              className="rounded bg-sky-500/15 px-1.5 py-px text-[11px] font-medium uppercase tracking-wide text-sky-700 dark:text-sky-300"
            >
              {trigger.type}
            </span>
            <span className="font-mono text-[13px] text-sky-700 dark:text-sky-300">
              {trigger.name}
            </span>
            {!trigger.enabled && (
              <span
                title="This trigger is currently disabled — it won't fire again until re-enabled. This chat is one of its past runs."
                className="rounded bg-sky-500/15 px-1.5 py-px text-[11px] font-medium uppercase tracking-wide text-sky-700 dark:text-sky-300"
              >
                disabled
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-sky-800/90 dark:text-sky-200/80">
            Fired by <span className="font-medium">{whenLine(trigger)}</span> · {grantSummary}. A
            reply you type here runs at this trigger's capability, not the keeper's.
          </p>

          {/* Clickable for the EXACT tool list + the rest of the enforced config. */}
          <details className="group mt-1.5 text-xs">
            <summary className="inline-flex cursor-pointer select-none items-center gap-1 text-sky-700 hover:underline dark:text-sky-300">
              <span className="transition group-open:rotate-90" aria-hidden>
                ▸
              </span>
              Capabilities
            </summary>
            <div className="mt-2 space-y-2 border-l-2 border-sky-300/60 pl-3 dark:border-sky-500/30">
              <div>
                <div className="mb-1 font-medium">Allowed tools</div>
                {toolLess ? (
                  <p className="text-sky-800/80 dark:text-sky-200/70">
                    {trigger.type === "schedule"
                      ? "None declared — this schedule runs as the keeper with its full toolset."
                      : "None — this trigger can only read its prompt and respond (no file, shell, or MCP access)."}
                  </p>
                ) : (
                  <ul className="flex flex-wrap gap-1" data-testid="trigger-allowed-tools">
                    {tools.map((t) => (
                      <li
                        key={t}
                        className="rounded bg-sky-500/10 px-1.5 py-px font-mono text-[11px] text-sky-800 dark:bg-sky-400/10 dark:text-sky-200"
                      >
                        {t}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-sky-800/90 dark:text-sky-200/80">
                {trigger.permissionMode && (
                  <>
                    <dt className="font-medium">Permission mode</dt>
                    <dd className="font-mono text-[11px]">{trigger.permissionMode}</dd>
                  </>
                )}
                {trigger.model && (
                  <>
                    <dt className="font-medium">Model</dt>
                    <dd className="font-mono text-[11px]">{trigger.model}</dd>
                  </>
                )}
                <dt className="font-medium">Max turns</dt>
                <dd className="font-mono text-[11px]">{trigger.maxTurns}</dd>
                <dt className="font-medium">Agent</dt>
                <dd className="truncate font-mono text-[11px]">{trigger.agentName}</dd>
              </dl>

              <Link
                to={`/projects/${encodeURIComponent(projectSlug)}/triggers`}
                className="inline-flex items-center gap-1 font-medium text-sky-700 hover:underline dark:text-sky-300"
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
