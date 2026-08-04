# @paddock/web

The project-first Paddock SPA — React + Vite + Tailwind, dark-mode, responsive.
Projects are the first-class citizen; the instance root is a workspace of its own.

> **Running the full stack (server + token + web)?** See **`../../DEV.md`** at the
> repo root — it has the one-place instructions for both production-like and
> hot-reload dev.

## Quick start (frontend only)

```bash
# From the repo root, with the backend already running on :4000:
npm run dev:web      # http://localhost:5173 (proxies /api + /ws -> :4000)

# Build the production bundle (the server serves packages/web/dist):
npm run -w packages/web build
```

## What's here

| Path | Role |
|------|------|
| `src/main.tsx` | Router + `ProjectsProvider`. Routes: `/`, `/projects/:slug`, `/chat`, `/chat/:sessionId`. |
| `src/components/AppShell.tsx` | Sidebar (**Home** nav + the project list). |
| `src/routes/ProjectsGrid.tsx` | Landing: project cards (status, domains, chat count, last activity) + empty state. |
| `src/routes/ProjectView.tsx` | Project header, chat/session list, chat pane, Files & Changelog tab. |
| `src/components/ChatPane.tsx` | The core: streaming markdown, tool blocks, boundaries, cancel, history hydration. |
| `src/components/NewProjectModal.tsx` | Create-project flow (name, summary, domains, status). |
| `src/components/Markdown.tsx` | `react-markdown` + `remark-gfm`, styled via the `.md` scope in `index.css`. |
| `src/lib/api.ts` | Typed REST client. |
| `src/lib/ws.ts` | Shared WebSocket client: auto-reconnect, ping keepalive, per-chat routing. |
| `src/lib/types.ts` | DTOs mirroring `packages/server/src/{routes,ws}.ts`. |

## Server contract (matched exactly)

REST: `GET/POST /api/projects`, `GET /api/projects/:slug` (`{project, changelog, chats}`),
`GET /api/projects/:slug/chats`, `GET /api/projects/:slug/chats/:sessionId/messages`,
`GET /api/chats`, `GET /api/chats/:sessionId/messages`.

WebSocket `/ws`:
- client→server: `chat:send {projectSlug ("" = the root workspace), sessionId|null, message}`,
  `chat:cancel {jobId}`, `ping`.
- server→client: `chat:response {chunk}`, `chat:tool_call {toolName, inputSummary?, output, isError, durationMs?}`,
  `chat:message_boundary` (splits assistant turns), `chat:complete {sessionId, success, error?}`
  (store this `sessionId` to resume), `chat:error {error}`, `pong`.

The client uses `projectSlug` throughout (the server still emits the legacy
`target` alias, which the client tolerates but does not depend on).

## Build-time config

- `VITE_API_BASE` — REST origin (default: same-origin).
- `VITE_WS_BASE` — WebSocket origin (default: same-origin, derived from the page).
