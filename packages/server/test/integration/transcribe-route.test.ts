/**
 * Covers the voice-dictation HTTP surface (routes.ts):
 *   - default (dictation off): GET /api/transcription → available:false,
 *     POST /api/transcribe → 503
 *   - configured remote: GET reports available:true, and POST forwards a
 *     multipart upload to the (stubbed) whisper server and returns its text.
 *
 * The remote block stubs globalThis.fetch BEFORE buildApp so the transcriber —
 * which captures globalThis.fetch at construction — talks to the stub, not a
 * real network.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";

let app: TestApp | null = null;
const savedEndpoint = process.env.PADDOCK_WHISPER_ENDPOINT;
const savedMode = process.env.PADDOCK_WHISPER_MODE;

afterEach(async () => {
  await app?.teardown();
  app = null;
  vi.restoreAllMocks();
  restore("PADDOCK_WHISPER_ENDPOINT", savedEndpoint);
  restore("PADDOCK_WHISPER_MODE", savedMode);
});

function restore(key: string, val: string | undefined) {
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

/** Build a single-file multipart/form-data body for app.inject. */
function multipart(field: string, filename: string, contentType: string, data: Buffer) {
  const boundary = "----paddockTestBoundary1234";
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([head, data, tail]),
  };
}

describe("transcription route — dictation off (default)", () => {
  it("reports unavailable and rejects transcription with 503", async () => {
    delete process.env.PADDOCK_WHISPER_ENDPOINT;
    delete process.env.PADDOCK_WHISPER_MODE;
    app = await startTestApp();

    const status = await app.app.inject({ method: "GET", url: "/api/transcription" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ available: false, mode: "off" });

    const body = multipart("file", "dictation.webm", "audio/webm", Buffer.from("x"));
    const res = await app.app.inject({ method: "POST", url: "/api/transcribe", ...body });
    expect(res.statusCode).toBe(503);
  });
});

describe("transcription route — remote configured", () => {
  it("reports available and returns the whisper server's transcript", async () => {
    process.env.PADDOCK_WHISPER_ENDPOINT = "http://fake-whisper.test/v1";
    process.env.PADDOCK_WHISPER_MODE = "remote";

    const realFetch = globalThis.fetch;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url: unknown, init?: unknown) => {
        if (String(url).includes("/audio/transcriptions")) {
          return new Response(JSON.stringify({ text: "hello from whisper" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return realFetch(url as Parameters<typeof fetch>[0], init as RequestInit);
      });

    app = await startTestApp();

    const status = await app.app.inject({ method: "GET", url: "/api/transcription" });
    expect(status.json()).toMatchObject({ available: true, mode: "remote" });

    const body = multipart("file", "dictation.webm", "audio/webm", Buffer.from("some-audio"));
    const res = await app.app.inject({ method: "POST", url: "/api/transcribe", ...body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ text: "hello from whisper", mode: "remote" });

    // The upload was forwarded to the configured endpoint.
    const called = fetchSpy.mock.calls.some(([u]) =>
      String(u).startsWith("http://fake-whisper.test/v1/audio/transcriptions"),
    );
    expect(called).toBe(true);
  });
});
