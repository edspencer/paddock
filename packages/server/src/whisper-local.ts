/**
 * Local whisper.cpp transcription — the `local` backend for {@link makeTranscriber}.
 *
 * This module is imported LAZILY (see transcribe.ts) so its heavy, optional
 * dependencies — `nodejs-whisper` (which builds/bundles whisper.cpp) and a
 * system `ffmpeg` — are only required on instances that actually set
 * `PADDOCK_WHISPER_MODE=local`. Remote-mode and dictation-off instances never
 * touch it.
 *
 * Flow: the browser records WebM/Opus, which whisper.cpp can't read directly, so
 * we first transcode to the 16 kHz mono PCM WAV whisper.cpp wants (via ffmpeg),
 * then run whisper.cpp over it and return the cleaned transcript.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TranscriptionConfig } from "./config.js";
import type { TranscriptionInput } from "./transcribe.js";
import { TranscriptionError } from "./transcribe.js";

/**
 * Transcribe an audio blob with whisper.cpp running on this box. Returns the raw
 * transcript text (the caller trims it).
 */
export async function transcribeLocal(
  input: TranscriptionInput,
  cfg: TranscriptionConfig,
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paddock-whisper-"));
  const srcPath = path.join(dir, safeName(input.filename));
  const wavPath = path.join(dir, "audio.wav");
  try {
    await writeFile(srcPath, input.audio);
    await toWav(srcPath, wavPath);
    return await runWhisper(wavPath, cfg);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Transcode any input ffmpeg understands to 16 kHz mono PCM WAV. */
async function toWav(src: string, dest: string): Promise<void> {
  await run(
    "ffmpeg",
    ["-nostdin", "-y", "-i", src, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", dest],
    "ffmpeg (audio transcode)",
  );
}

/**
 * Run whisper.cpp via nodejs-whisper and return the transcript. nodejs-whisper
 * writes a sibling `<wav>.txt`; we read that and strip whisper's `[hh:mm:ss.mmm
 * --> …]` line prefixes so the composer gets clean prose.
 */
async function runWhisper(wavPath: string, cfg: TranscriptionConfig): Promise<string> {
  let nodewhisper: NodeWhisper;
  try {
    // Optional dependency — only present on instances configured for local
    // whisper. Resolved dynamically so remote/off instances never need it.
    // @ts-ignore — module may be absent at build time (declared optional).
    ({ nodewhisper } = (await import("nodejs-whisper")) as unknown as {
      nodewhisper: NodeWhisper;
    });
  } catch {
    throw new TranscriptionError(
      "local whisper is not installed on this instance (missing nodejs-whisper). " +
        "Install it, or set PADDOCK_WHISPER_MODE=remote.",
      503,
    );
  }

  const modelName = cfg.model || "base";
  try {
    await nodewhisper(wavPath, {
      modelName,
      autoDownloadModelName: modelName,
      removeWavFileAfterTranscription: false,
      // Only the plain-text output; we read the `.txt` and strip timestamps
      // ourselves. (Avoid `splitOnWord`, which nodejs-whisper renders as a bare
      // `-sow true`, making whisper-cli treat `true` as a stray input file.)
      whisperOptions: {
        outputInText: true,
        outputInVtt: false,
        outputInSrt: false,
        outputInCsv: false,
        translateToEnglish: false,
      },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new TranscriptionError(`whisper.cpp failed: ${truncate(reason, 300)}`, 502);
  }

  const txt = await readFile(`${wavPath}.txt`, "utf-8").catch(() => null);
  if (txt === null) {
    throw new TranscriptionError("whisper.cpp produced no transcript output", 502);
  }
  return stripTimestamps(txt);
}

/** Remove whisper.cpp's `[00:00:00.000 --> 00:00:02.000]` line prefixes. */
export function stripTimestamps(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/^\s*\[[0-9:.]+\s*-->\s*[0-9:.]+\]\s*/, ""))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Spawn a process, rejecting with a clear TranscriptionError on failure. */
function run(cmd: string, args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      const hint =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? ` — is ${cmd} installed and on PATH?`
          : "";
      reject(new TranscriptionError(`${label} could not start: ${err.message}${hint}`, 503));
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new TranscriptionError(`${label} exited ${code}: ${truncate(stderr.trim(), 200)}`, 502),
        );
    });
  });
}

function safeName(name: string): string {
  const base = path.basename(name || "audio").replace(/[^a-zA-Z0-9._-]/g, "_");
  return base || "audio";
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

type NodeWhisper = (
  filePath: string,
  options: {
    modelName: string;
    autoDownloadModelName?: string;
    removeWavFileAfterTranscription?: boolean;
    whisperOptions?: Record<string, unknown>;
  },
) => Promise<unknown>;
