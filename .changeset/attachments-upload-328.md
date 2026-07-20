---
"@paddock/server": minor
"@paddock/web": minor
---

Add inbound file/image upload in the chat composer (#328 Phase 1, Approach A).

Pick (single/multi), drag-drop, or paste files into the composer to send them to
the keeper. Every file is copied into the attachment store and the keeper is
pointed at the paths, so Claude Code's `Read` tool does native vision on images
and renders PDFs — no herdctl change (works on the CLI runtime).

- New `attachments` config group (env `PADDOCK_ATTACHMENTS_*` < YAML <
  per-project `project.yaml`): `enabled` (default true), `maxFileSizeMb` (25),
  `maxFilesPerMessage` (10), `allowedTypes` (default allow-all). Extension +
  MIME-pattern matching with an empty-MIME extension fallback.
- New `POST /api/projects/:slug/chats/:id/upload` (multipart) with
  server-authoritative enabled/size/count/type validation, reusing the
  `send_file` copy-on-send attachment store (immutable snapshot, cleanup on chat
  delete).
- Composer picker + drag-drop zone + paste handler + a removable attachment tray
  (image thumbnails / file chips); sent files render in the transcript and
  re-render on reload from the store.
