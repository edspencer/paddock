---
"@paddock/server": patch
"@paddock/web": patch
---

feat: split the Docker image into `base` + `devbox` targets

The Dockerfile now builds two images from shared stages. `base` (`--target
base`) is the lean runtime published as `:<version>` / `:latest` — the app plus
`git`, `gh` and the `claude` CLI. `devbox` (`--target devbox`) layers the
coding-agent toolbox on top — PM2 + the vendored `pm` preview-server wrapper,
`ffmpeg`, the Playwright MCP browser (headless Chromium) and the Docker CLI —
and is published as `:<version>-devbox` / `:devbox` (with `PADDOCK_BROWSER_MCP=1`
so browser tools attach out of the box). The release workflow now builds each
target per-arch on native runners and merges one manifest per target.
