---
"@paddock/web": patch
---

chore(web): code-split the bundle (#11)

The markdown renderer (react-markdown + remark-gfm) and the four top-level route
components are now loaded as separate async chunks instead of sitting in the
entry bundle:

- `Markdown` lazy-loads its renderer (`MarkdownRenderer`) via `React.lazy`, with
  a plaintext fallback so streaming chat never flashes empty while the chunk
  fetches. `mermaid` was already dynamically imported.
- The router (`main.tsx`) lazy-loads `ProjectsGrid`, `ProjectView`,
  `ProjectRedirect`, and `OneOffChat`; `AppShell` wraps `<Outlet>` in a Suspense
  boundary with an unobtrusive spinner.

Result: the entry chunk drops from ~474 kB / 144 kB gzip to ~230 kB / 74 kB gzip
(−48% gzip). react-markdown and each route now load on demand.
