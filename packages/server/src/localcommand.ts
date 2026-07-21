/**
 * Local (client/TUI) slash-command output recovery — issue #158.
 *
 * The client-local display commands `/context` and `/usage` (and friends) render
 * their output into a transcript entry that @herdctl/core's parser DROPS: a
 * `type:"system"`, `subtype:"local_command"` line whose `content` is a
 * `<local-command-stdout>…</local-command-stdout>` block (e.g. `/context`'s usage
 * table). core keeps only `user`/`assistant` entries (`jsonl-parser.js`), and the
 * live path is no better — the same output arrives as a `model:"<synthetic>"`
 * assistant message that @herdctl/chat's translator treats as a placeholder and
 * skips. So the output silently vanishes in BOTH paths, leaving only the
 * `<command-name>` echo chip (already handled, #106) — the "renders as an empty /
 * user bubble with no result" bug in #158.
 *
 * This pass mirrors the established raw-transcript recovery (`tooldetails.ts`,
 * `subagents.ts`): it streams the raw JSONL, recovers each dropped `local_command`
 * entry, and RE-INJECTS it as a plain `role:"user"` message carrying the original
 * `<local-command-stdout>…` string, positioned right after the `<command-name>`
 * echo it belongs to (matched by `parentUuid`). The web renderer already detects
 * that block (`localCommandStdout`, ChatPane `commandOutput`) and shows it as a
 * clean, labeled command-output block — so a reloaded chat renders the output
 * consistently with the live surfacing (`ws.ts`), instead of dropping it. mtime
 * cached; a transcript with no local commands is an early no-op.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { projectChatsDir } from "./transcripts.js";
import {
  SAFE_SEGMENT,
  statMtimeMs,
  mtimeCacheGet,
  mtimeCacheSet,
  type MtimeCache,
  type EnrichedMessage,
} from "./subagents.js";

/** One recovered `local_command` stdout entry, anchored to its command echo. */
interface LocalCommandOutput {
  /** The originating `<command-name>` echo's uuid (this entry's `parentUuid`). */
  parentUuid?: string;
  /** This entry's own uuid — a stable, reload-consistent key for the web. */
  uuid?: string;
  /** ISO timestamp copied from the source line (falls back to the anchor's). */
  timestamp?: string;
  /** The raw `<local-command-stdout>…</local-command-stdout>` content. */
  content: string;
}

const outputsCache: MtimeCache<LocalCommandOutput[]> = new Map();

/** Recover the dropped `local_command` stdout entries (file order) from a session. */
export async function readLocalCommandOutputs(
  projectDir: string,
  sessionId: string,
): Promise<LocalCommandOutput[]> {
  if (!SAFE_SEGMENT.test(sessionId)) return [];
  return readFromFile(path.join(projectChatsDir(projectDir), `${sessionId}.jsonl`));
}

async function readFromFile(file: string): Promise<LocalCommandOutput[]> {
  const mtimeMs = await statMtimeMs(file);
  if (mtimeMs !== undefined) {
    const cached = mtimeCacheGet(outputsCache, file, mtimeMs);
    if (cached.hit) return cached.value;
  }
  const value = await readFromFileUncached(file);
  if (mtimeMs !== undefined) mtimeCacheSet(outputsCache, file, mtimeMs, value);
  return value;
}

async function readFromFileUncached(file: string): Promise<LocalCommandOutput[]> {
  const out: LocalCommandOutput[] = [];
  const stream = createReadStream(file, { encoding: "utf8" });
  stream.on("error", () => undefined);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: {
        type?: string;
        subtype?: string;
        content?: unknown;
        parentUuid?: unknown;
        uuid?: unknown;
        timestamp?: unknown;
      };
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (parsed.type !== "system" || parsed.subtype !== "local_command") continue;
      // The output block. Recent CC nests it in a `<local-command-stdout>` wrapper;
      // keep the wrapper so the SAME web detector (`localCommandStdout`) that guards
      // a user-entry form handles the recovered form identically.
      //
      // Only recover a block with non-empty inner text: mirror the web detector
      // (`localCommandStdout`) and the live path (`extractLocalCommandOutput`), both
      // of which drop empty blocks — otherwise an empty `<local-command-stdout></…>`
      // (a display-only command that produced nothing) would be re-injected only to
      // fall through to a raw-XML user bubble on reload, the exact bug #158 fixes.
      const content = typeof parsed.content === "string" ? parsed.content : undefined;
      const inner = content
        ? /^\s*<local-command-stdout>([\s\S]*)<\/local-command-stdout>\s*$/.exec(content)?.[1]?.trim()
        : undefined;
      if (!content || !inner) continue;
      out.push({
        parentUuid: typeof parsed.parentUuid === "string" ? parsed.parentUuid : undefined,
        uuid: typeof parsed.uuid === "string" ? parsed.uuid : undefined,
        timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
        content,
      });
    }
  } catch {
    return [];
  } finally {
    rl.close();
    stream.destroy();
  }
  return out;
}

/**
 * Re-inject recovered `local_command` stdout as `role:"user"` messages (issue
 * #158), each placed right after the `<command-name>` echo it belongs to (matched
 * by `parentUuid` → the echo message's `uuid`). An output whose anchor isn't in the
 * parsed messages (e.g. it was trimmed by a `limit`) is dropped rather than
 * mis-positioned. A transcript with no local commands passes through untouched.
 */
export async function enrichWithLocalCommands(
  projectDir: string,
  sessionId: string,
  messages: EnrichedMessage[],
): Promise<EnrichedMessage[]> {
  const outputs = await readLocalCommandOutputs(projectDir, sessionId);
  if (outputs.length === 0) return messages;

  // Group recovered outputs by the uuid of the command echo they follow.
  const byAnchor = new Map<string, LocalCommandOutput[]>();
  for (const o of outputs) {
    if (!o.parentUuid) continue;
    const arr = byAnchor.get(o.parentUuid);
    if (arr) arr.push(o);
    else byAnchor.set(o.parentUuid, [o]);
  }
  if (byAnchor.size === 0) return messages;

  const result: EnrichedMessage[] = [];
  for (const m of messages) {
    result.push(m);
    const anchored = m.uuid ? byAnchor.get(m.uuid) : undefined;
    if (!anchored) continue;
    for (const o of anchored) {
      result.push({
        role: "user",
        content: o.content,
        timestamp: o.timestamp ?? m.timestamp,
        uuid: o.uuid,
      });
    }
  }
  return result;
}
