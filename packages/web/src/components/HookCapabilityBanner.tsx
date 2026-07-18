import { Link } from "react-router-dom";
import type { ChatHookInfo } from "../lib/types";
import { BoltIcon } from "./icons";

/**
 * A read-only capability banner that floats at the top of a HOOK chat's message
 * history (Epic G / G3, GG-6). It makes three things legible the instant you open a
 * chat an event hook created:
 *
 *  1. **This is a hook agent** — not a normal keeper chat — and which lifecycle
 *     event triggered it (v1: `onArchive`).
 *  2. **Its granted capabilities** — the exact tools the hook's turns may use, read
 *     from the SAME registered `hook-<slug>-<name>` agent config herdctl enforces
 *     (`ChatHookInfo` is a projection of that config), so the banner is *truthful by
 *     construction*: it can't claim a capability the agent doesn't actually have.
 *  3. **An affordance toward editing the hook** — a link to where the hook is
 *     managed. (The dedicated Hooks tab is G4 and not yet merged; this points at the
 *     project's Settings as a placeholder until it lands.)
 *
 * It is deliberately READ-ONLY — it never grants or escalates permissions (live
 * per-chat escalation is the deferred G7). The exact tool list is behind a
 * disclosure so the banner stays compact but the full grant is one click away. This
 * matters because a human continuation of a hook chat inherits the hook's (often
 * minimal) scope — the banner is why that's not a surprise.
 */
export function HookCapabilityBanner({
  hook,
  projectSlug,
}: {
  hook: ChatHookInfo;
  projectSlug: string;
}) {
  const tools = hook.allowedTools ?? [];
  const toolLess = tools.length === 0;
  // A compact human summary for the always-visible header line.
  const grantSummary = toolLess
    ? "No tools — reasoning only"
    : `${tools.length} tool${tools.length === 1 ? "" : "s"} granted`;

  return (
    <div
      data-testid="hook-capability-banner"
      className="sticky top-0 z-10 mb-4 rounded-xl border border-sky-300/70 bg-sky-50/95 px-3 py-2.5 text-sky-900 shadow-sm backdrop-blur dark:border-sky-500/40 dark:bg-sky-950/85 dark:text-sky-100"
    >
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-sky-500/15 text-sky-600 dark:text-sky-300"
        >
          <BoltIcon width={15} height={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
            <span className="font-semibold">Event-hook agent</span>
            <span className="font-mono text-[13px] text-sky-700 dark:text-sky-300">
              {hook.name}
            </span>
            {!hook.enabled && (
              <span
                title="This hook is currently disabled — it won't fire again until re-enabled. This chat is one of its past runs."
                className="rounded bg-sky-500/15 px-1.5 py-px text-[11px] font-medium uppercase tracking-wide text-sky-700 dark:text-sky-300"
              >
                disabled
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-sky-800/90 dark:text-sky-200/80">
            Triggered by the{" "}
            <span className="font-medium">{hook.event}</span> event · {grantSummary}. A
            reply you type here runs at this hook's capability, not the keeper's.
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
                    None — this hook can only read its prompt and respond (no file,
                    shell, or MCP access).
                  </p>
                ) : (
                  <ul className="flex flex-wrap gap-1" data-testid="hook-allowed-tools">
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

              {hook.deniedTools && hook.deniedTools.length > 0 && (
                <div>
                  <div className="mb-1 font-medium">Denied tools</div>
                  <ul className="flex flex-wrap gap-1">
                    {hook.deniedTools.map((t) => (
                      <li
                        key={t}
                        className="rounded bg-rose-500/10 px-1.5 py-px font-mono text-[11px] text-rose-700 dark:text-rose-300"
                      >
                        {t}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-sky-800/90 dark:text-sky-200/80">
                {hook.permissionMode && (
                  <>
                    <dt className="font-medium">Permission mode</dt>
                    <dd className="font-mono text-[11px]">{hook.permissionMode}</dd>
                  </>
                )}
                {hook.model && (
                  <>
                    <dt className="font-medium">Model</dt>
                    <dd className="font-mono text-[11px]">{hook.model}</dd>
                  </>
                )}
                <dt className="font-medium">Max turns</dt>
                <dd className="font-mono text-[11px]">{hook.maxTurns}</dd>
                <dt className="font-medium">Agent</dt>
                <dd className="truncate font-mono text-[11px]">{hook.agentName}</dd>
              </dl>

              {/* Edit affordance. The dedicated Hooks tab is G4 (not yet merged); this
                  points at Settings as a placeholder destination for now. */}
              <Link
                to={`/projects/${encodeURIComponent(projectSlug)}/settings`}
                className="inline-flex items-center gap-1 font-medium text-sky-700 hover:underline dark:text-sky-300"
                title="Manage this project's hooks (dedicated Hooks tab coming soon)"
              >
                Edit hook →
              </Link>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
