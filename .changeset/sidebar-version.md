---
"@paddock/web": patch
---

Show the Paddock version in the sidebar. The bottom-left tagline ("Project-first Claude Code, hosted.") is replaced with the running version (e.g. `v0.4.1`), injected at build time from the package version via a Vite `__APP_VERSION__` define.
