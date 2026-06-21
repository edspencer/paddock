# Paddock backend contract — v2 (overview + sweep, preload, files, pins)

> The frontend integration delta for GitHub issues **#1, #2, #3, #4, #6**.
> Layers on top of the v1 WS/REST contract in the JOURNAL status log and
> `packages/web/README.md`. Backend-only changes; everything here is live and
> validated against a real keeper turn + sweeper run (Max OAuth, haiku sweeper).

---

## 1. Project DTO — new fields

`GET /api/projects` and `GET /api/projects/:slug` now return two extra fields on
each project object:

```ts
interface Project {
  // ...existing v1 fields (name, slug, status, domain, visibility,
  //    started, updated, summary, links, dir, created)...
  hasOverview: boolean;   // true once a sweep has written OVERVIEW.md
  pinned: string[];       // pinned file names (sibling tabs), order-preserving, default []
}
```

- `hasOverview` lets the UI show/hide the "preload project context" checkbox and
  an Overview tab without a second request.
- `pinned` drives the sibling-tab list (issue #4).

`project.yaml` now persists an optional `pinned: string[]` (defaults to `[]`).

---

## 2. WS `chat:send` — new `preloadContext` flag (issue #1)

`chat:send` payload gains one optional boolean:

```ts
// client -> server
{
  type: "chat:send",
  payload: {
    projectSlug: string,        // or "scratch"
    sessionId: string | null,   // null/omitted = new chat
    message: string,
    preloadContext?: boolean,   // NEW
  }
}
```

Behavior (server-side, no client work beyond setting the flag):

- Applies **only** when the chat is **new** (`sessionId` null/omitted) **and**
  `preloadContext === true` **and** the project has a non-empty `OVERVIEW.md`.
- When it applies, the server prepends the overview to the prompt as a delimited
  block before sending it to the keeper:

  ```
  <project-context>
  …OVERVIEW.md…
  </project-context>

  My request:
  …the user's message…
  ```

- **No-op** for scratch, for resumed chats, when the flag is false/absent, or
  when no overview exists. Server emits the same `chat:response` / `chat:complete`
  stream as always — there is no new server→client event for preload.

Recommended UI: a "preload project context" checkbox on the **new-chat**
composer, enabled only when `project.hasOverview === true`, sending
`preloadContext: true` on the first turn.

---

## 3. Overview endpoint (issue #2)

```
GET /api/projects/:slug/overview   ->  text/markdown  (raw OVERVIEW.md, "" if none)
```

- 200 with the raw markdown body (charset utf-8). Empty string if the project has
  no overview yet. 404 if the slug is unknown.
- OVERVIEW.md is the **sweep-curated current state** — a synthesized snapshot
  ("what the project is, key decisions/facts, open questions, next steps") written
  for an LLM to read at the start of a new chat. It is **replaced wholesale** on
  each sweep (not appended).

### The sweep (issues #2 + #6) — what the UI sees

There is no WS event for sweeps; they run out of band. The UI observes them
indirectly:

- After a user turn completes in a real project, a coalesced/debounced sweep runs
  (default min interval 5 min/project; env `PADDOCK_SWEEP_MIN_INTERVAL_MS`).
- The sweep **rewrites `OVERVIEW.md`** and **appends one dated bullet to
  `CHANGELOG.md`** (append-only). It skips when there's no new activity since the
  last sweep.
- To reflect a fresh sweep, re-fetch `GET /api/projects/:slug` (for `hasOverview`
  / `updated`), `/overview`, and `/changelog` — e.g. on project-view focus or a
  short poll while a chat is active. (A push channel for sweeps is a possible
  future enhancement; today it's pull.)

---

## 4. File content endpoint (issue #3)

```
GET /api/projects/:slug/files/:name
->  { name: string, kind: "markdown" | "html" | "text", content: string }
```

- `:name` is URL-encoded. Path-traversal guarded server-side.
- `kind` is derived from the extension: `.md`/`.markdown` → `markdown`,
  `.html`/`.htm` → `html`, everything else → `text`. This tells the UI which
  renderer to use (markdown/Mermaid live-render vs sandboxed iframe vs plain text).
- 404 if the file doesn't exist; 400 on path traversal; 404 if the slug is unknown.
- Existing `GET /api/projects/:slug/files` (list) and `/changelog` are unchanged.
  This endpoint serves **any** file in the project dir (plan.md, diagram.html,
  OVERVIEW.md, CHANGELOG.md, …).

---

## 5. Pins (issue #4)

```
PUT    /api/projects/:slug/pins         body: { file: string }   ->  { project }
DELETE /api/projects/:slug/pins/:file   (file URL-encoded)        ->  { project }
```

- `PUT` validates the file exists in the project dir (else **400**), dedupes, and
  appends to `pinned`. Returns the updated project DTO (with the new `pinned[]`).
- `DELETE` removes the file from `pinned` (no-op if absent). Returns the updated
  project DTO.
- Both persist `pinned` to `project.yaml` and bump `updated`.
- UI: render each `pinned` entry as a sibling tab next to Chat | Files | Changelog,
  fetching its content via the file endpoint (§4) and rendering by `kind`. An "x"
  on the tab calls the DELETE.

---

## Summary of new/changed surface

| Surface | Change |
|---|---|
| Project DTO | `+hasOverview: boolean`, `+pinned: string[]` |
| `chat:send` payload | `+preloadContext?: boolean` (new-chat-only overview inject) |
| `GET /api/projects/:slug/overview` | NEW — raw OVERVIEW.md |
| `GET /api/projects/:slug/files/:name` | NEW — `{ name, kind, content }` |
| `PUT /api/projects/:slug/pins` | NEW — pin `{ file }` |
| `DELETE /api/projects/:slug/pins/:file` | NEW — unpin |
| `project.yaml` | `+pinned: string[]` persisted |
| Files on disk | `OVERVIEW.md` (sweep-curated, replaced); `CHANGELOG.md` (sweep-appended) |
