---
"@paddock/server": patch
---

Refactor: split the oversized `projects.ts` (~1380 lines) into focused sibling modules, leaving `ProjectStore`'s metadata/yaml-serialization core cohesive. Extracts the MIME maps + `fileKind`/`contentTypeFor` into `project-mime.ts`, the `project.yaml` schema + `Project` DTO + create/update inputs + `normalizeLinks` into `project-types.ts`, the pure slug/repo-URL/path helpers + `ProjectError` into `project-paths.ts`, and the read-only freeform-file surface (`listFiles`/`readFile`/`readFileBytes`/`readFileWithKind`) into `project-files.ts` (pure `(root, slug, …)` functions the store delegates to). `projects.ts` drops to ~860 lines; the public import surface is unchanged (all moved names are re-exported from `./projects.js`) and behavior is identical. Part of #403.
