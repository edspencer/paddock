import { describe, it, expect, vi } from "vitest";
import {
  makeTranscriber,
  TranscriptionError,
  extractText,
  joinUrl,
  type TranscriptionInput,
} from "../../src/transcribe.js";
import type { TranscriptionConfig } from "../../src/config.js";

function cfg(over: Partial<TranscriptionConfig> = {}): TranscriptionConfig {
  return {
    mode: "remote",
    model: "base",
    endpoint: "http://whisper.local:8385/v1",
    maxUploadBytes: 25 * 1024 * 1024,
    ...over,
  };
}

const input: TranscriptionInput = {
  audio: Buffer.from("fake-audio-bytes"),
  filename: "dictation.webm",
  mimeType: "audio/webm",
};

/** A fetch stub returning a JSON body with the given status. */
function jsonFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

describe("joinUrl", () => {
  it("joins with exactly one slash regardless of trailing/leading slashes", () => {
    expect(joinUrl("http://h/v1", "audio/transcriptions")).toBe("http://h/v1/audio/transcriptions");
    expect(joinUrl("http://h/v1/", "/audio/transcriptions")).toBe(
      "http://h/v1/audio/transcriptions",
    );
  });
});

describe("extractText", () => {
  it("pulls text out of an OpenAI-style JSON body", () => {
    expect(extractText('{"text":"hello world"}')).toBe("hello world");
  });
  it("accepts a raw text/plain body", () => {
    expect(extractText("just words")).toBe("just words");
  });
  it("returns null for empty or text-less JSON", () => {
    expect(extractText("")).toBeNull();
    expect(extractText('{"other":1}')).toBeNull();
  });
});

describe("makeTranscriber availability", () => {
  it("is unavailable when mode is off", () => {
    const t = makeTranscriber(cfg({ mode: "off", endpoint: undefined }));
    expect(t.available).toBe(false);
  });
  it("is unavailable in remote mode without an endpoint", () => {
    const t = makeTranscriber(cfg({ mode: "remote", endpoint: undefined }));
    expect(t.available).toBe(false);
  });
  it("is available in remote mode with an endpoint", () => {
    expect(makeTranscriber(cfg()).available).toBe(true);
  });
  it("is available in local mode without an endpoint", () => {
    expect(makeTranscriber(cfg({ mode: "local", endpoint: undefined })).available).toBe(true);
  });
  it("throws 503 when transcribing while unavailable", async () => {
    const t = makeTranscriber(cfg({ mode: "off", endpoint: undefined }));
    await expect(t.transcribe(input)).rejects.toMatchObject({ status: 503 });
  });
  it("rejects an empty upload with 400", async () => {
    const t = makeTranscriber(cfg(), { fetchImpl: jsonFetch({ text: "x" }) });
    await expect(t.transcribe({ ...input, audio: Buffer.alloc(0) })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("remote transcription", () => {
  it("POSTs multipart to {endpoint}/audio/transcriptions and returns the text", async () => {
    const fetchImpl = jsonFetch({ text: "  the quick brown fox  " });
    const t = makeTranscriber(cfg({ language: "en" }), { fetchImpl });
    const result = await t.transcribe(input);

    expect(result.text).toBe("the quick brown fox"); // trimmed
    expect(result.mode).toBe("remote");
    expect(result.model).toBe("base");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://whisper.local:8385/v1/audio/transcriptions");
    expect((init as RequestInit).method).toBe("POST");
    const form = (init as RequestInit).body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("base");
    expect(form.get("language")).toBe("en");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("sends a bearer token when an apiKey is configured", async () => {
    const fetchImpl = jsonFetch({ text: "hi" });
    const t = makeTranscriber(cfg({ apiKey: "sk-secret" }), { fetchImpl });
    await t.transcribe(input);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-secret");
  });

  it("maps a non-2xx whisper response to a 502 TranscriptionError", async () => {
    const t = makeTranscriber(cfg(), { fetchImpl: jsonFetch({ error: "boom" }, 500) });
    await expect(t.transcribe(input)).rejects.toBeInstanceOf(TranscriptionError);
    await expect(t.transcribe(input)).rejects.toMatchObject({ status: 502 });
  });

  it("maps an unreachable server to a 502 TranscriptionError", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const t = makeTranscriber(cfg(), { fetchImpl });
    await expect(t.transcribe(input)).rejects.toMatchObject({ status: 502 });
  });

  it("errors when the server returns no transcript text", async () => {
    const t = makeTranscriber(cfg(), { fetchImpl: jsonFetch({ notext: true }) });
    await expect(t.transcribe(input)).rejects.toMatchObject({ status: 502 });
  });
});

describe("local transcription", () => {
  it("delegates to the injected local runner", async () => {
    const localRunner = vi.fn(async () => "  local words ");
    const t = makeTranscriber(cfg({ mode: "local", endpoint: undefined }), { localRunner });
    const result = await t.transcribe(input);
    expect(result.text).toBe("local words");
    expect(result.mode).toBe("local");
    expect(localRunner).toHaveBeenCalledOnce();
    expect(localRunner.mock.calls[0][0]).toMatchObject({ filename: "dictation.webm" });
  });
});
