/**
 * The inbound composer-upload HTTP surface (routes.ts, issue #328):
 *   - happy path: multi-file multipart → saved refs (id/kind/size), bytes
 *     readable back via /api/chat-files/:id;
 *   - server-authoritative validation: disabled (403), too-large (413),
 *     disallowed type (415), too-many (413), unknown project (404).
 *
 * Config is driven by PADDOCK_ATTACHMENTS_* env set BEFORE startTestApp (it lands
 * in cfg.attachments, the instance default the endpoint resolves against).
 */
import { describe, it, expect, afterEach } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";

let app: TestApp | null = null;
const SAVED = {
  enabled: process.env.PADDOCK_ATTACHMENTS_ENABLED,
  size: process.env.PADDOCK_ATTACHMENTS_MAX_FILE_SIZE_MB,
  count: process.env.PADDOCK_ATTACHMENTS_MAX_FILES_PER_MESSAGE,
  types: process.env.PADDOCK_ATTACHMENTS_ALLOWED_TYPES,
};

afterEach(async () => {
  await app?.teardown();
  app = null;
  restore("PADDOCK_ATTACHMENTS_ENABLED", SAVED.enabled);
  restore("PADDOCK_ATTACHMENTS_MAX_FILE_SIZE_MB", SAVED.size);
  restore("PADDOCK_ATTACHMENTS_MAX_FILES_PER_MESSAGE", SAVED.count);
  restore("PADDOCK_ATTACHMENTS_ALLOWED_TYPES", SAVED.types);
});

function restore(key: string, val: string | undefined) {
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

/** Build a multi-file multipart/form-data body for app.inject. */
function multipart(
  files: Array<{ field?: string; filename: string; contentType: string; data: Buffer }>,
) {
  const boundary = "----paddockAttBoundary328";
  const chunks: Buffer[] = [];
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${f.field ?? "files"}"; filename="${f.filename}"\r\n` +
          `Content-Type: ${f.contentType}\r\n\r\n`,
      ),
      f.data,
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(chunks),
  };
}

async function makeProject(t: TestApp, name = "Att Proj"): Promise<string> {
  const res = await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } });
  return res.json().project.slug as string;
}

const uploadUrl = (slug: string, sid = "new") =>
  `/api/projects/${slug}/chats/${sid}/upload`;

describe("attachment upload — happy path (default allow-all)", () => {
  it("saves multiple files and serves their bytes back by id", async () => {
    app = await startTestApp();
    const slug = await makeProject(app);
    const body = multipart([
      { filename: "shot.png", contentType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      { filename: "data.csv", contentType: "text/csv", data: Buffer.from("a,b\n1,2\n") },
    ]);
    const res = await app.app.inject({ method: "POST", url: uploadUrl(slug), ...body });
    expect(res.statusCode).toBe(200);
    const { files } = res.json() as {
      files: Array<{ id: string; filename: string; kind: string; size: number }>;
    };
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ filename: "shot.png", kind: "image" });
    expect(files[1]).toMatchObject({ filename: "data.csv", kind: "text" });
    expect(files[0].size).toBe(4);

    // The stored bytes are servable (drives the transcript re-render).
    const bytes = await app.app.inject({ method: "GET", url: `/api/chat-files/${files[0].id}` });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.headers["content-type"]).toContain("image/png");
  });

  it("rejects a request with no files (400)", async () => {
    app = await startTestApp();
    const slug = await makeProject(app);
    const res = await app.app.inject({
      method: "POST",
      url: uploadUrl(slug),
      ...multipart([]),
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s for an unknown project", async () => {
    app = await startTestApp();
    const body = multipart([
      { filename: "x.png", contentType: "image/png", data: Buffer.from("x") },
    ]);
    const res = await app.app.inject({ method: "POST", url: uploadUrl("ghost"), ...body });
    expect(res.statusCode).toBe(404);
  });
});

describe("attachment upload — server-authoritative validation", () => {
  it("403s when attachments are disabled", async () => {
    process.env.PADDOCK_ATTACHMENTS_ENABLED = "false";
    app = await startTestApp();
    const slug = await makeProject(app);
    const body = multipart([
      { filename: "x.png", contentType: "image/png", data: Buffer.from("x") },
    ]);
    const res = await app.app.inject({ method: "POST", url: uploadUrl(slug), ...body });
    expect(res.statusCode).toBe(403);
  });

  it("413s a file over the configured size cap", async () => {
    process.env.PADDOCK_ATTACHMENTS_MAX_FILE_SIZE_MB = "1";
    app = await startTestApp();
    const slug = await makeProject(app);
    const big = Buffer.alloc(2 * 1024 * 1024, 0x61); // 2 MB > 1 MB cap
    const body = multipart([{ filename: "big.bin", contentType: "application/octet-stream", data: big }]);
    const res = await app.app.inject({ method: "POST", url: uploadUrl(slug), ...body });
    expect(res.statusCode).toBe(413);
  });

  it("415s a disallowed file type (allow-list of images only)", async () => {
    process.env.PADDOCK_ATTACHMENTS_ALLOWED_TYPES = "image/*";
    app = await startTestApp();
    const slug = await makeProject(app);
    const body = multipart([
      { filename: "notes.txt", contentType: "text/plain", data: Buffer.from("hi") },
    ]);
    const res = await app.app.inject({ method: "POST", url: uploadUrl(slug), ...body });
    expect(res.statusCode).toBe(415);
  });

  it("allows an empty-MIME extension match under a mixed allow-list", async () => {
    // A .md file arrives with a generic/empty MIME; the extension entry saves it.
    process.env.PADDOCK_ATTACHMENTS_ALLOWED_TYPES = "image/*,.md";
    app = await startTestApp();
    const slug = await makeProject(app);
    const body = multipart([
      { filename: "readme.md", contentType: "application/octet-stream", data: Buffer.from("# hi") },
    ]);
    const res = await app.app.inject({ method: "POST", url: uploadUrl(slug), ...body });
    expect(res.statusCode).toBe(200);
    expect(res.json().files[0]).toMatchObject({ kind: "markdown" });
  });

  it("413s when more than the per-message file count is posted", async () => {
    process.env.PADDOCK_ATTACHMENTS_MAX_FILES_PER_MESSAGE = "2";
    app = await startTestApp();
    const slug = await makeProject(app);
    const body = multipart([
      { filename: "a.png", contentType: "image/png", data: Buffer.from("a") },
      { filename: "b.png", contentType: "image/png", data: Buffer.from("b") },
      { filename: "c.png", contentType: "image/png", data: Buffer.from("c") },
    ]);
    const res = await app.app.inject({ method: "POST", url: uploadUrl(slug), ...body });
    expect(res.statusCode).toBe(413);
  });
});
