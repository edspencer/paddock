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

Either `npm run dev` or `npm run build && npm run preview` is fine for visual
verification, including for Mermaid. `rehype-mermaid` runs with
`strategy: 'pre-mermaid'`, which only tags the `<pre>` — all rendering happens
client-side from the CDN, identically in dev and in the built output. (The
"Mermaid only renders in the build" rule applies to the `img-svg` strategy that
herdctl's docs site uses, not to this one.)

Do check diagrams in **both** colour themes: Mermaid is re-rendered on every
change to `<html data-theme>`, so the theme toggle is a real code path.

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

## Analytics

PostHog, configured inline in `astro.config.mjs`'s `head` (the standard install
snippet). It is proxied through our own origin: `api_host` is
`https://paddock.edspencer.net/ingest`, and `functions/ingest/[[path]].ts` — a
Cloudflare Pages Function — forwards to PostHog. Change one and you must change
the other.

The `phc_` project key in that snippet is public by design and belongs in the
source. Do not "fix" it into an env var.

Note `functions/` is the only part of this directory that Cloudflare runs rather
than serves; it is invisible to `astro build`, so a broken proxy will not fail
the build or show up in `npm run preview`. Verify it against a deploy preview.

## Deploy (Cloudflare Pages)

Cloudflare Pages builds this directory directly (no GitHub Actions needed):
- Root directory: `website`
- Build command: `npm install && npm run build`
- Build output: `website/dist`
- Custom domain: `paddock.edspencer.net`

See the PR description / repo README for the token + DNS setup steps.
