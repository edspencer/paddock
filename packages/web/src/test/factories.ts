// Small fixture factories for web component/unit tests.
import type { Chat, Project } from "../lib/types";
import type { api } from "../lib/api";

type ModelsResponse = Awaited<ReturnType<typeof api.getModels>>;

/**
 * A full `GET /api/models` payload. Every instance default is REQUIRED on the
 * wire (the server sends all of them unconditionally), so a mock that omits one
 * is not a realistic response — spread over this rather than hand-rolling one.
 */
export function makeModelsResponse(over: Partial<ModelsResponse> = {}): ModelsResponse {
  return {
    models: [
      { id: "claude-opus-4-8", label: "Opus 4.8", contextLimit: 1_000_000 },
      { id: "claude-sonnet-5", label: "Sonnet 5", contextLimit: 1_000_000 },
      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", contextLimit: 200_000 },
    ],
    defaultModel: "claude-opus-4-8",
    driveModeDefault: "batch",
    maxSpawnDepthDefault: 1,
    // Mirrors the server's DEFAULT_RECOVERY / DEFAULT_ATTACHMENTS / DEFAULT_CURATION
    // so a test that doesn't care about these gets the same effective config the
    // real server would send.
    recoveryDefault: {
      surfaceKilledTask: true,
      autoReDrive: false,
      debounceMs: 5000,
      maxRetries: 1,
      limboTimeoutMs: 0,
    },
    attachmentsDefault: {
      enabled: true,
      maxFileSizeMb: 25,
      maxFilesPerMessage: 10,
      allowedTypes: ["*"],
    },
    curationDefault: { overviewMaxTokens: 2000, changelogMaxTokens: 8000, claudeMaxTokens: 6000 },
    ...over,
  };
}

export function makeProject(over: Partial<Project> = {}): Project {
  const slug = over.slug ?? "test-project";
  return {
    name: "Test Project",
    slug,
    status: "active",
    domain: [],
    group: "",
    visibility: "public",
    started: "2026-06-01",
    updated: "2026-06-21",
    summary: "",
    links: [],
    dir: `/data/projects/${slug}`,
    workingDir: `/data/projects/${slug}`,
    repoBacked: false,
    hasOverview: false,
    pinned: [],
    model: "claude-opus-4-8",
    permissionMode: "acceptEdits",
    maxTurns: 200,
    docker: false,
    ...over,
  };
}

export function makeChat(over: Partial<Chat> = {}): Chat {
  return {
    sessionId: "sess-1",
    workingDirectory: "/data/scratch/.chats",
    name: "A chat",
    updatedAt: "2026-06-21T10:00:00.000Z",
    resumable: true,
    preview: "hello",
    ...over,
  };
}
