---
"@paddock/server": patch
---

Docker images: install `openssh-client` in the base image and the `docker
buildx` / `docker compose` CLI plugins in devbox. The base image shipped `git`
with no ssh transport, so every `git@` remote failed mid-turn with `error:
cannot run ssh: No such file or directory`; devbox shipped `docker-ce-cli` with
an empty plugin path, so `docker compose` and `docker buildx` were both
`unknown command`. Both were missing runtime dependencies of tooling the images
already deliberately include.
