---
"@paddock/web": patch
---

docs(website): link the `edspencer/paddock-deploy` recipes repo across the
entry-point pages, complementing the existing Guides coverage.

- **Getting started** gains a "Ready-made deploy recipes" pointer after the
  docker-compose block, linking the repo and its `docker/` subdir.
- **Authentication** cross-links the `auth-basic/` Caddy sidecar as the turnkey
  Tier-1 gate and points at the Securing ladder.
- **What's New** adds a 0.44 entry covering the two official images (`:latest`
  base + `:devbox`) and the new `paddock-deploy` recipes repo.
- **Environment variables** links the deploy recipe's port-publish note to the
  `docker/` recipe.
