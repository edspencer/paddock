# website/CLAUDE.md

Astro + Starlight documentation site for Paddock. Intended to deploy to
**paddock.edspencer.net via Cloudflare Pages**.

This package is **standalone** — it is deliberately NOT part of the root npm
workspaces (`packages/*`), so it never touches the server/web build, install, or
CI. Build it on its own from `website/`.

## Build & preview

```bash
cd website
npm install
npm run build && npm run preview   # preview the built site (Mermaid renders here)
```

Prefer `npm run build && npm run preview` for visual verification. `npm run dev`
(`astro dev`) is fine for fast iteration but Mermaid diagrams are configured via
`rehype-mermaid` and render most reliably in the built output.

Note: the projects box exports `NODE_ENV=production`. The build deps (astro,
starlight, tailwind) are intentionally in `dependencies` (not `devDependencies`)
so a plain `npm install` under that env still installs them — no `--include=dev`
needed here.

## Content

Docs pages are `.md` / `.mdx` files under `src/content/docs/`. Every page needs
Starlight frontmatter (at minimum `title:`). Use Mermaid code fences for diagrams.

Most pages were migrated from the repo's top-level `docs/*.md` (the raw
engineering docs remain the working source; this site is the published
presentation). When you change one, consider whether the other should follow —
consolidating to a single source is a tracked follow-up.

## Sidebar

The sidebar is maintained **by hand** in `astro.config.mjs` under `sidebar`.
Starlight does NOT auto-discover pages — add new pages there explicitly.

## Deploy (Cloudflare Pages)

Cloudflare Pages builds this directory directly (no GitHub Actions needed):
- Root directory: `website`
- Build command: `npm install && npm run build`
- Build output: `website/dist`
- Custom domain: `paddock.edspencer.net`

See the PR description / repo README for the token + DNS setup steps.
