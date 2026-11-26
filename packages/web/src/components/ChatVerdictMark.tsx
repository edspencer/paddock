import type { ChatVerdict } from "../lib/types";
import { Tooltip } from "./Tooltip";
import { ArrowRightIcon, CheckIcon } from "./icons";

/** The tooltip / accessible description for a verdict. */
export function verdictLabel(v: ChatVerdict): string {
  const head = v.verdict === "finished" ? "Looks finished" : "Could continue";
  return v.reason ? `${head} — ${v.reason}` : head;
}

/**
 * The post-turn judge's read of a chat, as one small quiet glyph: a check for
 * "looks finished", an arrow for "could continue". Renders nothing when the chat
 * has no verdict, or while it is running — a running chat has moved past the
 * turn the verdict judged.
 */
export function ChatVerdictMark({
  verdict,
  running,
  size = 11,
}: {
  verdict?: ChatVerdict;
  running: boolean;
  size?: number;
}) {
  if (!verdict || running) return null;
  const finished = verdict.verdict === "finished";
  const label = verdictLabel(verdict);
  return (
    <Tooltip content={label} className="shrink-0">
      <span
        data-verdict={verdict.verdict}
        role="img"
        aria-label={label}
        className="shrink-0 text-fg-subtle"
      >
        {finished ? (
          <CheckIcon width={size} height={size} />
        ) : (
          <ArrowRightIcon width={size} height={size} />
        )}
      </span>
    </Tooltip>
  );
}
