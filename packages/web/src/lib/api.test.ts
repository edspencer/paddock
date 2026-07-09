import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api, ApiError } from "./api";
import { makeProject, makeChat } from "../test/factories";

// The api client is a thin typed wrapper over global fetch. We stub fetch per
// test and assert (a) the request it builds — method, URL, body — and (b) how it
// unwraps the response / surfaces errors. No network.

type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: "OK",
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as Response;
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** The (url, init) of the Nth fetch call. */
function call(n = 0): [string, RequestInit | undefined] {
  const [url, init] = fetchMock.mock.calls[n];
  return [url as string, init as RequestInit | undefined];
}

describe("api: reads", () => {
  it("getModels unwraps the models payload", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ models: [{ id: "m", label: "M", contextLimit: 100 }], keeperDefault: "m", sweeperDefault: "m" }),
    );
    const res = await api.getModels();
    expect(call()[0]).toBe("/api/models");
    expect(res.keeperDefault).toBe("m");
    expect(res.models).toHaveLength(1);
  });

  it("listProjects unwraps { projects } to the array", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ projects: [makeProject({ slug: "a" })] }));
    const res = await api.listProjects();
    expect(res).toHaveLength(1);
    expect(res[0].slug).toBe("a");
  });

  it("getProjectDetail hits the encoded slug path", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ project: makeProject(), changelog: "log", chats: [] }),
    );
    await api.getProjectDetail("a/b");
    expect(call()[0]).toBe("/api/projects/a%2Fb");
  });

  it("listProjectFiles + getProjectFile unwrap their payloads", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ files: ["a.md", "b.html"] }));
    expect(await api.listProjectFiles("p")).toEqual(["a.md", "b.html"]);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ name: "a.md", kind: "markdown", content: "# hi" }),
    );
    const f = await api.getProjectFile("p", "a.md");
    expect(call(1)[0]).toBe("/api/projects/p/files/a.md");
    expect(f.kind).toBe("markdown");
  });

  it("chatContext routes scratch sessions to the scratch endpoint", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ usage: { contextTokens: 5, contextLimit: 10 } }));
    await api.chatContext("scratch", "sess-1");
    expect(call()[0]).toBe("/api/chats/sess-1/context");
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(jsonResponse({ usage: null }));
    const usage = await api.chatContext("proj", "sess-1");
    expect(call()[0]).toBe("/api/projects/proj/chats/sess-1/context");
    expect(usage).toBeNull();
  });

  it("chatUsage unwraps the bulk usage map from the project usage endpoint", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ usage: { "sess-1": { contextTokens: 5, contextLimit: 10 } } }),
    );
    const usage = await api.chatUsage("a/b");
    expect(call()[0]).toBe("/api/projects/a%2Fb/chats/usage");
    expect(usage["sess-1"]).toEqual({ contextTokens: 5, contextLimit: 10 });
  });
});

describe("api: writes build the right request", () => {
  it("createProject POSTs the input and unwraps { project }", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ project: makeProject({ slug: "new" }) }));
    const p = await api.createProject({ name: "New" });
    const [url, init] = call();
    expect(url).toBe("/api/projects");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ name: "New" });
    expect(init?.headers).toMatchObject({ "content-type": "application/json" });
    expect(p.slug).toBe("new");
  });

  it("updateProject PATCHes the patch", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ project: makeProject() }));
    await api.updateProject("p", { status: "done" });
    const [url, init] = call();
    expect(url).toBe("/api/projects/p");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({ status: "done" });
  });

  it("deleteProject DELETEs the slug", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await api.deleteProject("p");
    const [url, init] = call();
    expect(url).toBe("/api/projects/p");
    expect(init?.method).toBe("DELETE");
  });

  it("renameProjectChat sends { name }, null to clear", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await api.renameProjectChat("p", "s", null);
    const [url, init] = call();
    expect(url).toBe("/api/projects/p/chats/s");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({ name: null });
  });

  it("archiveProjectChat POSTs { archived } to the archive endpoint", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, archived: true }));
    await api.archiveProjectChat("p", "s", true);
    const [url, init] = call();
    expect(url).toBe("/api/projects/p/chats/s/archive");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ archived: true });
  });

  it("archiveScratchChat POSTs { archived:false } to unarchive a scratch chat", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, archived: false }));
    await api.archiveScratchChat("s9", false);
    const [url, init] = call();
    expect(url).toBe("/api/chats/s9/archive");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ archived: false });
  });

  it("promoteChat POSTs the build payload to the promote endpoint", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ project: makeProject(), promoted: true }));
    const res = await api.promoteChat("sess-9", { name: "X", group: "g" });
    const [url, init] = call();
    expect(url).toBe("/api/chats/sess-9/promote");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ name: "X", group: "g" });
    expect(res.promoted).toBe(true);
  });

  it("pinFile PUTs { file }; unpinFile DELETEs the encoded file", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ project: makeProject({ pinned: ["a.md"] }) }));
    await api.pinFile("p", "a.md");
    expect(call()).toEqual(["/api/projects/p/pins", expect.objectContaining({ method: "PUT" })]);
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(jsonResponse({ project: makeProject() }));
    await api.unpinFile("p", "sub/a.md");
    expect(call()[0]).toBe("/api/projects/p/pins/sub%2Fa.md");
    expect(call()[1]?.method).toBe("DELETE");
  });
});

describe("api: git", () => {
  it("gitInfo + gitStatus read JSON; gitDiff reads raw text", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ repo: true, configured: false, github: { configured: false, connected: false } }));
    expect((await api.gitInfo()).repo).toBe(true);

    fetchMock.mockResolvedValueOnce(jsonResponse({ repo: true, files: [], clean: true }));
    expect((await api.gitStatus("p")).clean).toBe(true);

    fetchMock.mockResolvedValueOnce(jsonResponse("@@ -1 +1 @@\n+new"));
    const diff = await api.gitDiff("p", "a.md");
    expect(call(2)[0]).toBe("/api/projects/p/git/diff?file=a.md");
    expect(diff).toContain("+new");
  });

  it("gitCommit POSTs the message; gitPush POSTs", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ committed: true, hash: "abc1234" }));
    const res = await api.gitCommit("p", "msg");
    expect(JSON.parse(call()[1]?.body as string)).toEqual({ message: "msg" });
    expect(res.hash).toBe("abc1234");
    fetchMock.mockResolvedValueOnce(jsonResponse({ pushed: true }));
    expect((await api.gitPush()).pushed).toBe(true);
    expect(call(1)[0]).toBe("/api/git/push");
  });

  it("githubConnect/Poll/Disconnect hit the device-flow endpoints", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ userCode: "AB-CD", verificationUri: "https://gh/device", deviceCode: "dev", interval: 5, expiresIn: 900 }),
    );
    expect((await api.githubConnect()).userCode).toBe("AB-CD");
    expect(call()).toEqual(["/api/git/github/connect", expect.objectContaining({ method: "POST" })]);

    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "pending" }));
    await api.githubPoll("dev");
    expect(JSON.parse(call(1)[1]?.body as string)).toEqual({ deviceCode: "dev" });

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await api.githubDisconnect();
    expect(call(2)[0]).toBe("/api/git/github/disconnect");
  });
});

describe("api: error handling", () => {
  it("throws ApiError with the server error message on a JSON error body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Unknown model: foo" }, { ok: false, status: 400 }));
    await expect(api.updateProject("p", { model: "foo" })).rejects.toMatchObject({
      name: "ApiError",
      message: "Unknown model: foo",
      status: 400,
    });
  });

  it("falls back to statusText when the error body isn't JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);
    await expect(api.listProjects()).rejects.toMatchObject({ message: "Internal Server Error", status: 500 });
  });

  it("reqText surfaces a JSON { error } parsed out of a text body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      text: async () => JSON.stringify({ error: "diff failed" }),
    } as unknown as Response);
    await expect(api.gitDiff("p")).rejects.toMatchObject({ message: "diff failed", status: 409 });
  });

  it("ApiError is an Error subclass carrying the status", () => {
    const e = new ApiError("boom", 503);
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(503);
  });

  it("listScratchChats unwraps and surfaces the chat list", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ chats: [makeChat({ sessionId: "s1" })] }));
    expect((await api.listScratchChats())[0].sessionId).toBe("s1");
  });
});
