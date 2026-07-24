---
"@paddock/web": patch
---

docs(website): add "The Dev Box flavor" guide

New Guides page explaining the `devbox` image — what it adds over `base` (the `pm`
preview-server wrapper, `ffmpeg`, the headless Playwright MCP browser with
`PADDOCK_BROWSER_MCP=1` on by default, and the Docker CLI), how to run it, using
`pm`, and the docker-in-docker trade-offs — cross-linked to the `docker/` recipe
in `paddock-deploy`.
