/**
 * Voice-dictation transcription — turns a recorded audio blob into text.
 *
 * Two backends, selected by {@link TranscriptionConfig.mode} (see config.ts):
 *
 *   - `remote` — POST the audio to an OpenAI-compatible `/audio/transcriptions`
 *     endpoint (the same contract HushPod's remote whisper uses, so both can
 *     point at one shared server, e.g. a laptop with a GPU). Uses global
 *     `fetch` + `FormData`, so it is trivially stubbable in tests.
 *   - `local` — run whisper.cpp on this box via nodejs-whisper. The heavy,
 *     optional dependency (`./whisper-local.js`) is imported lazily so the
 *     server boots — and remote mode works — even when whisper.cpp / ffmpeg
 *     aren't installed.
 *
 * The composer's mic button is gated on {@link Transcriber.available}; a
 * misconfigured or `off` instance simply advertises no dictation.
 */
import type { TranscriptionConfig, WhisperMode } from "./config.js";

/** A recorded audio blob to transcribe (as uploaded by the browser). */
export interface TranscriptionInput {
  audio: Buffer;
  /** Original filename incl. extension, e.g. `dictation.webm`. */
  filename: string;
  /** MIME type, e.g. `audio/webm`. */
  mimeType: string;
}

export interface TranscriptionResult {
  /** The transcribed text (trimmed). */
  text: string;
  /** Which backend produced it. */
  mode: Exclude<WhisperMode, "off">;
  /** The whisper model used. */
  model: string;
  /** Wall-clock transcription time. */
  durationMs: number;
}

/** Thrown on any transcription failure; carries an HTTP-ish status hint. */
export class TranscriptionError extends Error {
  constructor(
    message: string,
    /** Suggested HTTP status for the route to surface (default 502). */
    readonly status = 502,
  ) {
    super(message);
    this.name = "TranscriptionError";
  }
}

export interface Transcriber {
  /** Whether dictation is usable (mode !== off and required config present). */
  readonly available: boolean;
  readonly mode: WhisperMode;
  readonly model: string;
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}

/** Runs whisper.cpp locally. Injected so the local path is testable/mockable. */
export type LocalRunner = (input: TranscriptionInput, cfg: TranscriptionConfig) => Promise<string>;

export interface TranscriberDeps {
  /** Override `globalThis.fetch` (tests). */
  fetchImpl?: typeof fetch;
  /** Override the local whisper.cpp runner (tests). Defaults to a lazy import. */
  localRunner?: LocalRunner;
}

/**
 * Build a {@link Transcriber} from resolved config. Pure — constructs no I/O
 * until `transcribe()` is called, so it's safe to make one at startup regardless
 * of mode.
 */
export function makeTranscriber(cfg: TranscriptionConfig, deps: TranscriberDeps = {}): Transcriber {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  // `remote` requires an endpoint; without one it degrades to unavailable rather
  // than 500-ing at request time.
  const available = cfg.mode === "local" || (cfg.mode === "remote" && !!cfg.endpoint);

  async function transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    if (!available) {
      throw new TranscriptionError("transcription is not configured on this instance", 503);
    }
    if (input.audio.length === 0) {
      throw new TranscriptionError("empty audio upload", 400);
    }
    const started = hrNow();
    const text =
      cfg.mode === "remote"
        ? await transcribeRemote(input, cfg, fetchImpl)
        : await runLocal(input, cfg, deps.localRunner);
    return {
      text: text.trim(),
      mode: cfg.mode as Exclude<WhisperMode, "off">,
      model: cfg.model,
      durationMs: Math.round(hrNow() - started),
    };
  }

  return { available, mode: cfg.mode, model: cfg.model, transcribe };
}

/** Lazy-import the local runner so nodejs-whisper stays an optional dependency. */
async function runLocal(
  input: TranscriptionInput,
  cfg: TranscriptionConfig,
  injected?: LocalRunner,
): Promise<string> {
  const runner: LocalRunner =
    injected ?? ((await import("./whisper-local.js")).transcribeLocal as LocalRunner);
  return runner(input, cfg);
}

/**
 * OpenAI-compatible transcription: `POST {endpoint}/audio/transcriptions` with a
 * multipart `file` + `model`. This is the same wire format as OpenAI's Whisper
 * API and whisper-server / faster-whisper-server / speaches, so any of them (or
 * HushPod's remote whisper) works unchanged.
 */
async function transcribeRemote(
  input: TranscriptionInput,
  cfg: TranscriptionConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  const url = joinUrl(cfg.endpoint!, "audio/transcriptions");
  const form = new FormData();
  form.append("file", new Blob([input.audio], { type: input.mimeType }), input.filename);
  form.append("model", cfg.model);
  form.append("response_format", "json");
  if (cfg.language) form.append("language", cfg.language);

  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new TranscriptionError(`whisper server unreachable at ${url}: ${reason}`, 502);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TranscriptionError(
      `whisper server returned ${res.status}${body ? `: ${truncate(body, 200)}` : ""}`,
      502,
    );
  }

  // OpenAI's default `json` response is `{ text }`; `verbose_json` adds more.
  // Be defensive: accept a raw string body too (some servers return text/plain).
  const raw = await res.text();
  const text = extractText(raw);
  if (text === null) {
    throw new TranscriptionError("whisper server returned no transcript text", 502);
  }
  return text;
}

/** Pull the transcript out of an OpenAI-ish response body (JSON `{text}` or raw). */
export function extractText(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const data = JSON.parse(trimmed) as { text?: unknown };
      if (typeof data.text === "string") return data.text;
      return null;
    } catch {
      // Not JSON after all — fall through and treat as raw text.
    }
  }
  return trimmed;
}

/** Join a base URL and path with exactly one slash between them. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// `Date.now()` is fine in the server runtime; kept behind a helper so the
// duration math reads clearly and can be stubbed if ever needed.
function hrNow(): number {
  return Date.now();
}
