# Paddock application image.
#
# Paddock is an APP (server + built web SPA), not a library — this image is the
# unit of deployment. It bundles the Fastify server, the built React SPA, and the
# `claude` CLI.
#
# Only the CLI runtime uses the PATH binary (`execa("claude", …)` in
# @herdctl/core's cli-runtime) — i.e. the sweeper (always), plus triggers and
# turns on `driveMode: batch`. A trigger resolves its drive mode exactly like a
# chat does, so on the default `session` mode it does NOT read PATH; the
# sweeper is the only unconditional user of the PATH binary.
# Chats run the SDK runtime, and the Claude Agent SDK resolves its
# own executable from its pinned platform optional-dependency
# (`@anthropic-ai/claude-agent-sdk-<platform>`) via require.resolve; it never
# consults PATH, and nothing here overrides `pathToClaudeCodeExecutable`.
#
# So the two runtimes can be running DIFFERENT `claude` versions: the image's
# PATH binary (installed unpinned below) for CLI-runtime turns, and the SDK's
# pinned binary for chats. Worth knowing before debugging a version-skew bug —
# `claude --version` tells you only half the story.
#
# This Dockerfile produces TWO images from shared stages (build once, publish
# both — pick with `--target`):
#   - base   (`--target base`)   the lean runtime: app + git, gh, claude CLI.
#   - devbox (`--target devbox`) base + the coding-agent toolbox — PM2 + the `pm`
#                                preview-server wrapper, ffmpeg, the Playwright
#                                MCP browser (headless Chromium), the Docker CLI,
#                                kubectl, python3/pip/uv, jq and rsync — for
#                                keepers that develop code in-container.
#
# Runtime requirements (supplied at `docker run` time, NOT baked in):
#   - CLAUDE_CODE_OAUTH_TOKEN   Claude Max plan auth. Or ANTHROPIC_API_KEY for API
#                               pricing. Either works on either runtime.
#   - a volume mounted at /data  Persistent project store + Claude session transcripts.
#                                (HOME=/data so ~/.claude/projects survives restarts → resume works.)
#   - GITHUB_TOKEN (optional)    Enables git push to the backing repo (configured by entrypoint).
#
# Multi-arch (linux/amd64, linux/arm64) is built in CI on native per-arch
# runners (see release.yml); each leg pushes by digest and the manifests are
# merged with `docker buildx imagetools create` (one manifest per target).

# ---- build stage ----------------------------------------------------------
# Pinned to $BUILDPLATFORM: this stage only emits arch-independent JS
# (tsc + vite dist/), so in an emulated cross-build (e.g. a local
# `docker buildx build --platform linux/amd64,linux/arm64`) it runs once,
# natively, instead of repeating npm ci + compile under QEMU per arch.
FROM --platform=$BUILDPLATFORM node:22-slim AS build
WORKDIR /app

# Install deps first (cache layer) — workspace manifests before sources.
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci

# Build server (tsc) + web (vite).
COPY . .
RUN npm run build

# ---- base runtime stage ---------------------------------------------------
# The lean, publishable runtime image (ghcr.io/edspencer/paddock:<version> /
# :latest). Everything a stock Paddock instance needs and nothing more.
FROM node:22-slim AS base
WORKDIR /app

ENV NODE_ENV=production \
    PORT=7233 \
    HOST=0.0.0.0 \
    PADDOCK_DATA_DIR=/data \
    HOME=/data

# System deps + GitHub CLI + the Claude CLI (the CLI runtime's PATH binary; the
# SDK runtime ships its own — see the header).
# openssh-client belongs here, next to git rather than in devbox: without it git
# has no ssh transport at all, so every `git@` remote dies mid-turn with
# "cannot run ssh: No such file or directory" (#487). The entrypoint's
# GITHUB_TOKEN rewrite only covers https://github.com/ URLs, so an SSH remote —
# or any non-GitHub host — has no working path in the lean image either. Cost is
# ~1.1 MB download / ~6 MiB installed (pulls libcbor0.8 + libfido2-1).
# tini is for process reaping, not convenience — see the ENTRYPOINT note below.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates curl tini \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code

# Production dependencies only (dev deps like vite/tsc/playwright are build-time).
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev

# The image redistributes Paddock, so it carries Paddock's licence text (#674).
COPY LICENSE ./

# Built artifacts. The server resolves the SPA at ../../web/dist relative to
# packages/server/dist, so this layout needs no PADDOCK_WEB_DIST override.
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/web/dist

# Configure git auth from GITHUB_TOKEN (if provided) then exec the server.
RUN printf '#!/bin/sh\nif [ -n "$GITHUB_TOKEN" ]; then\n  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"\nfi\nmkdir -p "$PADDOCK_DATA_DIR"\nexec "$@"\n' > /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME ["/data"]
EXPOSE 7233

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

# tini as pid 1, so orphaned processes get reaped (#788 class B).
#
# Without it the Paddock server itself is pid 1, and a server is not an init: it
# never calls wait(), so every orphan that exits correctly stays in the process
# table as a zombie forever. That is not hypothetical — it is what every
# browser-spawning tool in the devbox image does. Chromium watches its pipe and
# self-exits when its parent dies (correct behaviour), and the corpse then has
# nobody to reap it; `npm run demo:gif` alone left ~4 chrome zombies per run and
# 1 esbuild per build, on CLEAN exits. One dev box reached ~1,650 of them.
# Zombies hold no memory, but they consume pid-table entries and make every
# process census lie — a count of `chrome-headless` cannot distinguish a live
# 100 MB browser from a 0 MB corpse, which is how two investigations of #788
# reached opposite conclusions from honest measurements.
#
# Why baked in rather than `docker run --init`: `--init` is a Docker runtime
# flag with no Kubernetes equivalent (a pod spec can share a namespace or add a
# sidecar, but it cannot inject an init as a container's pid 1). Paddock also
# runs on a k3s cluster, so an in-image init is the portable half of that
# choice. `--init` remains harmless if someone passes it anyway: tini detects it
# is not pid 1, warns, and defers.
#
# Signal behaviour is deliberately unchanged. tini forwards SIGTERM/SIGINT to
# its immediate child, and docker-entrypoint.sh `exec`s the server, so that
# child IS the node process — the server's own SIGTERM handler (packages/server/
# src/start.ts) still runs, still awaits close(), and tini exits with the
# server's exit code. Verified against a pre-change image: `docker stop` took
# 0.19s and exited 0 both before and after, with identical fleet-manager
# shutdown logs. This matters because deploys SIGTERM the fleet; a change that
# broke propagation would surface as containers being SIGKILLed after the
# 10-second grace period, and nobody would notice until a deploy.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "packages/server/dist/index.js"]

# ---- devbox stage ---------------------------------------------------------
# base + the coding-agent toolbox (ghcr.io/edspencer/paddock:<version>-devbox /
# :devbox). This is the heavy image: the Playwright Chromium layer alone is
# ~1 GB. It inherits base's ENV / VOLUME / EXPOSE / HEALTHCHECK / ENTRYPOINT /
# CMD unchanged — HOST=0.0.0.0 stays (the container namespace is the security
# boundary; #435 handled the source default + open-network guard).
FROM base AS devbox

# Browser tools attach out of the box (issue #269): PADDOCK_BROWSER_MCP=1 makes
# browserMcpServers() launch the Playwright MCP server we install below.
ENV PADDOCK_BROWSER_MCP=1

# ffmpeg (media work) + the Docker CLI. Ship the *client* only — no daemon, no
# privilege baked in; the deploy recipe decides socket-mount (docker-outside-of-
# docker) vs privileged DinD. docker-ce-cli comes from Docker's own apt repo.
# The buildx/compose plugins ship separately from docker-ce-cli — without them
# `docker compose` and `docker buildx` are "unknown command" because the
# cli-plugins dir doesn't exist at all (#487). They are pure client-side
# binaries: they talk to whatever socket the deploy recipe chose, so they add no
# daemon and no privilege — the boundary above still holds. ~25 MB download /
# ~100 MiB installed, on a ~4.5 GB image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates curl gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends \
         docker-ce-cli docker-buildx-plugin docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# Interpreters and small CLI utilities the agent reaches for by habit (#522).
# The rule this follows: **interpreters and small CLI utilities in the image,
# libraries in the project.** So `python3` — same category as `git` or `curl`,
# and the default reach for a ten-line data transform whatever the surrounding
# project is written in — but no torch/transformers/numpy: hundreds of MB, and
# actively wrong for a project that pins its own versions. `jq` and `rsync` are
# the same gap from the other end (both absent during the systemd→container
# migration, where the host had them and the container did not).
# python3-venv is here because pip alone is nearly unusable on Debian: bookworm
# marks the interpreter EXTERNALLY-MANAGED (PEP 668), so a global `pip install`
# refuses and a venv is the supported path. ~70 MB of layer, on a ~4.9 GB image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv jq rsync \
    && rm -rf /var/lib/apt/lists/*

# uv — alongside pip rather than instead of it. Single static binary, makes venvs
# fast enough to be disposable, and it is where a lot of Python AI tooling has
# landed; that covers "AI work needs Python" without putting a single AI library
# in the image. Copied from Astral's own distroless image rather than curl|sh:
# multi-arch by construction (the tag is a manifest list — buildx resolves the
# per-arch variant, so this works unchanged on the arm64 release leg) and pinned,
# so an image rebuild is reproducible. Bump the tag deliberately. ~54 MB.
# NOTE the destination: /usr/local/bin, NOT the installer's default $HOME/.local/bin.
# HOME=/data is the runtime VOLUME mount, so anything installed under it is
# shadowed at run time and the binary vanishes — the same trap the Chromium
# install below sidesteps with PLAYWRIGHT_BROWSERS_PATH.
COPY --from=ghcr.io/astral-sh/uv:0.11.33 /uv /uvx /usr/local/bin/

# PM2 + the vendored `pm` preview-server wrapper (scripts/pm, MIT). `pm` is a
# thin PM2 + shared-ports-registry wrapper; installing it to /usr/local/bin
# makes the devbox turnkey for the dev-server convention.
RUN npm install -g pm2
COPY scripts/pm /usr/local/bin/pm
RUN chmod +x /usr/local/bin/pm

# Install Chromium OUTSIDE /data. HOME=/data (so ~/.claude survives restarts),
# but /data is the runtime VOLUME mount — Playwright's default browser dir
# ($HOME/.cache/ms-playwright) would be shadowed by the mounted volume at run
# time and the browser would vanish. Pin it to an image-baked path instead; the
# bundled playwright and the server-spawned MCP both honour this env at launch.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Playwright MCP server (exposes the `playwright-mcp` bin on PATH) + a matching
# headless Chromium installed via the `playwright` bundled inside @playwright/mcp
# (mirrors the box: `node .../playwright/cli.js install --with-deps chromium`).
# --with-deps pulls the shared libs Chromium needs; paddock launches it headless
# --no-sandbox --isolated --browser chromium (the container is the sandbox).
RUN npm install -g @playwright/mcp \
    && node "$(npm root -g)/@playwright/mcp/node_modules/playwright/cli.js" install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# kubectl — the same "client only, no credentials" shape as the Docker CLI above
# (#531). An agent asked "is the deploy healthy?" needs one binary to make a
# cluster legible: describe a pod, tail logs, check a rollout. It cannot be added
# downstream either — kubectl is in NO apt source this image carries (verified:
# `apt-cache policy kubectl` is empty against debian.sources + docker.list +
# github-cli.list), so a derived `apt-get install kubectl` fails outright and the
# alternatives are a new trust root or a forked image. Hence the static binary,
# and hence no kubeconfig and no cluster credentials baked in: those are
# per-deployment and belong to the operator. ~60 MB.
#
# THIS BLOCK IS LAST ON PURPOSE. `ARG`s are part of the cache key of every RUN
# after them, so declaring KUBECTL_VERSION higher up put it in the cache key of
# the 824 MB Chromium layer above — bumping kubectl would then rebuild Chromium
# on all four release legs. At the end of the stage it invalidates nothing.
#
# TARGETARCH is what keeps this honest on the arm64 leg: hardcoding amd64 would
# build cleanly and then fail confusingly at run time inside an arm64 container.
# It is a BuildKit-provided arg; under the legacy builder it is empty and the
# case below fails the build with a message rather than guessing.
#
# The digests are pinned HERE rather than fetched from the published
# `kubectl.sha256` next to the binary: that file travels the same TLS connection
# from the same host as the download, so checking it proves only that the
# transfer wasn't truncated. An in-repo digest is the thing that actually pins,
# and it keeps a rebuild of an old tag reproducible. Bumping the version means
# bumping all three values:
#   curl -fsSL https://dl.k8s.io/release/v<X.Y.Z>/bin/linux/<arch>/kubectl.sha256
ARG KUBECTL_VERSION=1.36.3
ARG KUBECTL_SHA256_AMD64=ebbd080e7c2e275093b55915722043257eb24004363e20acb3c4d71919f88336
ARG KUBECTL_SHA256_ARM64=3d86f24401c41ae5a46ac50eef8865fe891d3647d324a0836f6c63757a126e62
ARG TARGETARCH
RUN set -eu; \
    case "${TARGETARCH:-}" in \
      amd64) sha="$KUBECTL_SHA256_AMD64" ;; \
      arm64) sha="$KUBECTL_SHA256_ARM64" ;; \
      "") echo "TARGETARCH is empty — build with BuildKit/buildx, not the legacy builder" >&2; exit 1 ;; \
      *) echo "no pinned kubectl digest for TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl"; \
    echo "${sha}  /usr/local/bin/kubectl" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/kubectl; \
    kubectl version --client
